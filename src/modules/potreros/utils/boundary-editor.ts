import type { Coordinate } from "../types";

export type BoundaryDrafts = Record<string, Coordinate[]>;

export type BoundaryEditResult = {
  drafts: BoundaryDrafts;
  affectedIds: string[];
};

export type BoundaryVertexRemovalResult =
  | (BoundaryEditResult & { ok: true })
  | { ok: false; message: string };

export type LinkedFieldBoundaryEditResult = BoundaryEditResult & {
  boundary: Coordinate[];
};

export const FIELD_BOUNDARY_LINK_TOLERANCE_METERS = 2;

const COORDINATE_EPSILON = 1e-8;
const METERS_PER_DEGREE_LATITUDE = 111_320;
const MINIMUM_ATTACHED_EDGE_METERS = 0.25;
const MINIMUM_PARALLEL_COSINE = Math.cos(10 * Math.PI / 180);

export function cloneBoundaryDrafts(drafts: BoundaryDrafts): BoundaryDrafts {
  return Object.fromEntries(
    Object.entries(drafts).map(([id, ring]) => [id, ring.map(cloneCoordinate)]),
  );
}

export function boundaryRingsEqual(first: readonly Coordinate[], second: readonly Coordinate[]): boolean {
  return first.length === second.length && first.every((coordinate, index) => (
    coordinatesMatch(coordinate, second[index])
  ));
}

export function changedBoundaryDraftIds(
  drafts: BoundaryDrafts,
  originals: ReadonlyArray<{ id: string; coordinates: Coordinate[] }>,
): string[] {
  return originals
    .filter(({ id, coordinates }) => {
      const draft = drafts[id];
      return Boolean(draft) && !boundaryRingsEqual(draft, coordinates);
    })
    .map(({ id }) => id);
}

export function moveBoundaryVertex(
  drafts: BoundaryDrafts,
  editedId: string,
  vertexIndex: number,
  replacement: Coordinate,
): BoundaryEditResult {
  const edited = drafts[editedId];
  const original = edited?.[vertexIndex];
  if (!edited || !original) return { drafts, affectedIds: [] };

  const next = cloneBoundaryDrafts(drafts);
  const affectedIds: string[] = [];
  Object.entries(next).forEach(([id, ring]) => {
    let changed = false;
    next[id] = ring.map((coordinate) => {
      if (!coordinatesMatch(coordinate, original)) return coordinate;
      changed = true;
      return cloneCoordinate(replacement);
    });
    if (changed) affectedIds.push(id);
  });
  return { drafts: next, affectedIds };
}

export function insertBoundaryVertex(
  drafts: BoundaryDrafts,
  editedId: string,
  edgeIndex: number,
  point: Coordinate,
): BoundaryEditResult {
  const edited = drafts[editedId];
  if (!edited || edited.length < 2 || edgeIndex < 0 || edgeIndex >= edited.length) {
    return { drafts, affectedIds: [] };
  }

  const edgeStart = edited[edgeIndex];
  const edgeEnd = edited[(edgeIndex + 1) % edited.length];
  const next = cloneBoundaryDrafts(drafts);
  const affectedIds = new Set<string>();

  Object.entries(next).forEach(([id, ring]) => {
    if (ring.some((coordinate) => coordinatesMatch(coordinate, point))) return;
    const matchingEdge = findMatchingEdge(ring, edgeStart, edgeEnd);
    if (matchingEdge === -1) return;
    next[id] = insertAfter(ring, matchingEdge, point);
    affectedIds.add(id);
  });

  if (!affectedIds.has(editedId)) {
    next[editedId] = insertAfter(next[editedId], edgeIndex, point);
    affectedIds.add(editedId);
  }

  return { drafts: next, affectedIds: [...affectedIds] };
}

export function removeBoundaryVertex(
  drafts: BoundaryDrafts,
  editedId: string,
  vertexIndex: number,
): BoundaryVertexRemovalResult {
  const edited = drafts[editedId];
  if (!edited || !edited[vertexIndex]) return { ok: false, message: "Selecciona un vértice vigente." };
  if (edited.length <= 3) return { ok: false, message: "El potrero necesita al menos tres vértices." };

  const previous = edited[(vertexIndex - 1 + edited.length) % edited.length];
  const current = edited[vertexIndex];
  const following = edited[(vertexIndex + 1) % edited.length];
  const removals = new Map<string, number>();
  removals.set(editedId, vertexIndex);

  for (const [id, ring] of Object.entries(drafts)) {
    if (id === editedId) continue;
    const sharedSegment = hasMatchingEdge(ring, previous, current) || hasMatchingEdge(ring, current, following);
    if (!sharedSegment) continue;

    const matchingVertexIndex = ring.findIndex((coordinate) => coordinatesMatch(coordinate, current));
    if (matchingVertexIndex === -1) {
      return {
        ok: false,
        message: "Ese punto pertenece a un borde compartido que no puede simplificarse de forma segura.",
      };
    }
    const siblingPrevious = ring[(matchingVertexIndex - 1 + ring.length) % ring.length];
    const siblingFollowing = ring[(matchingVertexIndex + 1) % ring.length];
    const sharesWholeChain = (
      coordinatesMatch(siblingPrevious, previous) && coordinatesMatch(siblingFollowing, following)
    ) || (
      coordinatesMatch(siblingPrevious, following) && coordinatesMatch(siblingFollowing, previous)
    );
    if (!sharesWholeChain) {
      return {
        ok: false,
        message: "Ese vértice es una unión entre varios potreros. Muévelo o redibuja el tramo en vez de eliminarlo.",
      };
    }
    if (ring.length <= 3) {
      return {
        ok: false,
        message: "Eliminar ese vértice dejaría un potrero vecino con menos de tres puntos.",
      };
    }
    removals.set(id, matchingVertexIndex);
  }

  const next = cloneBoundaryDrafts(drafts);
  removals.forEach((index, id) => {
    next[id] = next[id].filter((_, coordinateIndex) => coordinateIndex !== index);
  });
  return { ok: true, drafts: next, affectedIds: [...removals.keys()] };
}

/**
 * Moves a field vertex and every paddock boundary chain attached to either
 * incident field edge. Paddock points are mapped by their relative position on
 * the old field edge, so intermediate breakpoints and shared junctions remain
 * on the new edge instead of opening slivers.
 */
export function moveLinkedFieldBoundaryVertex(
  boundary: Coordinate[],
  drafts: BoundaryDrafts,
  vertexIndex: number,
  replacement: Coordinate,
  toleranceMeters = FIELD_BOUNDARY_LINK_TOLERANCE_METERS,
): LinkedFieldBoundaryEditResult {
  const current = boundary[vertexIndex];
  if (!current || boundary.length < 3) return unchangedLinkedFieldResult(boundary, drafts);

  const previousEdgeIndex = (vertexIndex - 1 + boundary.length) % boundary.length;
  const nextEdgeIndex = vertexIndex;
  const nextBoundary = moveVertex(boundary, vertexIndex, replacement);
  const proposals = new Map<string, VertexProposal>();

  collectMappedAttachedVertices({
    boundary,
    drafts,
    fieldEdgeIndex: previousEdgeIndex,
    nextStart: nextBoundary[previousEdgeIndex],
    nextEnd: replacement,
    movedVertex: { before: current, after: replacement },
    proposals,
    toleranceMeters,
  });
  collectMappedAttachedVertices({
    boundary,
    drafts,
    fieldEdgeIndex: nextEdgeIndex,
    nextStart: replacement,
    nextEnd: nextBoundary[(nextEdgeIndex + 1) % nextBoundary.length],
    movedVertex: { before: current, after: replacement },
    proposals,
    toleranceMeters,
  });

  const applied = applyVertexProposals(drafts, proposals);
  return { boundary: nextBoundary, drafts: applied.drafts, affectedIds: applied.affectedIds };
}

/**
 * Inserts a field vertex into every attached paddock edge that spans the same
 * position. This establishes a canonical shared node before the user drags it.
 */
export function insertLinkedFieldBoundaryVertex(
  boundary: Coordinate[],
  drafts: BoundaryDrafts,
  edgeIndex: number,
  point: Coordinate,
  toleranceMeters = FIELD_BOUNDARY_LINK_TOLERANCE_METERS,
): LinkedFieldBoundaryEditResult {
  const start = boundary[edgeIndex];
  const end = boundary[(edgeIndex + 1) % boundary.length];
  if (!start || !end || boundary.length < 3) return unchangedLinkedFieldResult(boundary, drafts);

  const fieldProjection = projectPointToSegment(point, start, end);
  const sharedPoint = interpolateCoordinate(start, end, fieldProjection.t);
  const nextDrafts = cloneBoundaryDrafts(drafts);
  const affectedIds = new Set<string>();

  Object.entries(drafts).forEach(([id, ring]) => {
    const attachedEdges = findAttachedPaddockEdges(ring, start, end, toleranceMeters);
    if (attachedEdges.length === 0) return;

    const attachedVertexIndices = new Set<number>();
    attachedEdges.forEach(({ edgeIndex: attachedEdgeIndex }) => {
      attachedVertexIndices.add(attachedEdgeIndex);
      attachedVertexIndices.add((attachedEdgeIndex + 1) % ring.length);
    });
    const existingIndex = [...attachedVertexIndices]
      .find((coordinateIndex) => distanceMeters(ring[coordinateIndex], sharedPoint) <= toleranceMeters) ?? -1;
    if (existingIndex !== -1) {
      if (!coordinatesMatch(ring[existingIndex], sharedPoint)) {
        nextDrafts[id] = moveVertex(nextDrafts[id], existingIndex, sharedPoint);
        affectedIds.add(id);
      }
      return;
    }

    const matchingEdge = attachedEdges
      .find(({ startProjection, endProjection }) => {
        const minimum = Math.min(startProjection.t, endProjection.t);
        const maximum = Math.max(startProjection.t, endProjection.t);
        return fieldProjection.t > minimum + Number.EPSILON && fieldProjection.t < maximum - Number.EPSILON;
      });
    if (!matchingEdge) return;
    nextDrafts[id] = insertAfter(nextDrafts[id], matchingEdge.edgeIndex, sharedPoint);
    affectedIds.add(id);
  });

  return {
    boundary: insertVertex(boundary, edgeIndex, sharedPoint),
    drafts: nextDrafts,
    affectedIds: [...affectedIds],
  };
}

/**
 * Removes a field vertex while preserving attached paddock chains. Every point
 * on the two old incident edges is projected by cumulative edge distance onto
 * the replacement edge; junction vertices remain available to internal
 * paddock divisions even when they are no longer explicit field vertices.
 */
export function removeLinkedFieldBoundaryVertex(
  boundary: Coordinate[],
  drafts: BoundaryDrafts,
  vertexIndex: number,
  toleranceMeters = FIELD_BOUNDARY_LINK_TOLERANCE_METERS,
): LinkedFieldBoundaryEditResult {
  if (boundary.length <= 3 || !boundary[vertexIndex]) return unchangedLinkedFieldResult(boundary, drafts);

  const previousIndex = (vertexIndex - 1 + boundary.length) % boundary.length;
  const nextIndex = (vertexIndex + 1) % boundary.length;
  const previous = boundary[previousIndex];
  const current = boundary[vertexIndex];
  const next = boundary[nextIndex];
  const previousLength = distanceMeters(previous, current);
  const nextLength = distanceMeters(current, next);
  const chainLength = previousLength + nextLength;
  if (chainLength <= Number.EPSILON || distanceMeters(previous, next) <= Number.EPSILON) {
    return unchangedLinkedFieldResult(boundary, drafts);
  }

  const proposals = new Map<string, VertexProposal>();
  collectCollapsedAttachedVertices({
    drafts,
    oldStart: previous,
    oldEnd: current,
    newStart: previous,
    newEnd: next,
    chainOffsetMeters: 0,
    chainLengthMeters: chainLength,
    segmentLengthMeters: previousLength,
    proposals,
    toleranceMeters,
  });
  collectCollapsedAttachedVertices({
    drafts,
    oldStart: current,
    oldEnd: next,
    newStart: previous,
    newEnd: next,
    chainOffsetMeters: previousLength,
    chainLengthMeters: chainLength,
    segmentLengthMeters: nextLength,
    proposals,
    toleranceMeters,
  });

  const applied = applyVertexProposals(drafts, proposals);
  return {
    boundary: removeVertex(boundary, vertexIndex),
    drafts: applied.drafts,
    affectedIds: applied.affectedIds,
  };
}

export function insertVertex(ring: Coordinate[], edgeIndex: number, point: Coordinate): Coordinate[] {
  if (ring.length < 2 || edgeIndex < 0 || edgeIndex >= ring.length) return ring;
  return insertAfter(ring, edgeIndex, point);
}

export function removeVertex(ring: Coordinate[], vertexIndex: number): Coordinate[] {
  if (ring.length <= 3 || !ring[vertexIndex]) return ring;
  return ring.filter((_, index) => index !== vertexIndex);
}

export function moveVertex(ring: Coordinate[], vertexIndex: number, replacement: Coordinate): Coordinate[] {
  if (!ring[vertexIndex]) return ring;
  return ring.map((coordinate, index) => index === vertexIndex ? cloneCoordinate(replacement) : cloneCoordinate(coordinate));
}

export function edgeMidpoint(start: Coordinate, end: Coordinate): Coordinate {
  return [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2];
}

function findMatchingEdge(ring: Coordinate[], start: Coordinate, end: Coordinate): number {
  for (let index = 0; index < ring.length; index += 1) {
    const candidateStart = ring[index];
    const candidateEnd = ring[(index + 1) % ring.length];
    if (
      (coordinatesMatch(candidateStart, start) && coordinatesMatch(candidateEnd, end))
      || (coordinatesMatch(candidateStart, end) && coordinatesMatch(candidateEnd, start))
    ) return index;
  }
  return -1;
}

function hasMatchingEdge(ring: Coordinate[], start: Coordinate, end: Coordinate): boolean {
  return findMatchingEdge(ring, start, end) !== -1;
}

function insertAfter(ring: Coordinate[], edgeIndex: number, point: Coordinate): Coordinate[] {
  return [
    ...ring.slice(0, edgeIndex + 1).map(cloneCoordinate),
    cloneCoordinate(point),
    ...ring.slice(edgeIndex + 1).map(cloneCoordinate),
  ];
}

type SegmentProjection = {
  distanceMeters: number;
  rawT: number;
  t: number;
};

type AttachedPaddockEdge = {
  edgeIndex: number;
  startProjection: SegmentProjection;
  endProjection: SegmentProjection;
};

type VertexProposal = {
  id: string;
  vertexIndex: number;
  coordinate: Coordinate;
  sourceDistanceMeters: number;
};

function collectMappedAttachedVertices({
  boundary,
  drafts,
  fieldEdgeIndex,
  nextStart,
  nextEnd,
  movedVertex,
  proposals,
  toleranceMeters,
}: {
  boundary: Coordinate[];
  drafts: BoundaryDrafts;
  fieldEdgeIndex: number;
  nextStart: Coordinate;
  nextEnd: Coordinate;
  movedVertex: { before: Coordinate; after: Coordinate };
  proposals: Map<string, VertexProposal>;
  toleranceMeters: number;
}) {
  const oldStart = boundary[fieldEdgeIndex];
  const oldEnd = boundary[(fieldEdgeIndex + 1) % boundary.length];
  Object.entries(drafts).forEach(([id, ring]) => {
    findAttachedPaddockEdges(ring, oldStart, oldEnd, toleranceMeters).forEach((attachment) => {
      [
        { vertexIndex: attachment.edgeIndex, projection: attachment.startProjection },
        { vertexIndex: (attachment.edgeIndex + 1) % ring.length, projection: attachment.endProjection },
      ].forEach(({ vertexIndex, projection }) => {
        const original = ring[vertexIndex];
        const coordinate = distanceMeters(original, movedVertex.before) <= toleranceMeters
          ? cloneCoordinate(movedVertex.after)
          : interpolateCoordinate(nextStart, nextEnd, projection.t);
        addVertexProposal(proposals, {
          id,
          vertexIndex,
          coordinate,
          sourceDistanceMeters: projection.distanceMeters,
        });
      });
    });
  });
}

function collectCollapsedAttachedVertices({
  drafts,
  oldStart,
  oldEnd,
  newStart,
  newEnd,
  chainOffsetMeters,
  chainLengthMeters,
  segmentLengthMeters,
  proposals,
  toleranceMeters,
}: {
  drafts: BoundaryDrafts;
  oldStart: Coordinate;
  oldEnd: Coordinate;
  newStart: Coordinate;
  newEnd: Coordinate;
  chainOffsetMeters: number;
  chainLengthMeters: number;
  segmentLengthMeters: number;
  proposals: Map<string, VertexProposal>;
  toleranceMeters: number;
}) {
  Object.entries(drafts).forEach(([id, ring]) => {
    findAttachedPaddockEdges(ring, oldStart, oldEnd, toleranceMeters).forEach((attachment) => {
      [
        { vertexIndex: attachment.edgeIndex, projection: attachment.startProjection },
        { vertexIndex: (attachment.edgeIndex + 1) % ring.length, projection: attachment.endProjection },
      ].forEach(({ vertexIndex, projection }) => {
        const chainPosition = chainOffsetMeters + projection.t * segmentLengthMeters;
        addVertexProposal(proposals, {
          id,
          vertexIndex,
          coordinate: interpolateCoordinate(newStart, newEnd, chainPosition / chainLengthMeters),
          sourceDistanceMeters: projection.distanceMeters,
        });
      });
    });
  });
}

function findAttachedPaddockEdges(
  ring: Coordinate[],
  fieldStart: Coordinate,
  fieldEnd: Coordinate,
  toleranceMeters: number,
): AttachedPaddockEdge[] {
  const fieldLength = distanceMeters(fieldStart, fieldEnd);
  if (fieldLength <= Number.EPSILON) return [];
  const matches: AttachedPaddockEdge[] = [];
  for (let edgeIndex = 0; edgeIndex < ring.length; edgeIndex += 1) {
    const paddockStart = ring[edgeIndex];
    const paddockEnd = ring[(edgeIndex + 1) % ring.length];
    const paddockLength = distanceMeters(paddockStart, paddockEnd);
    if (paddockLength < MINIMUM_ATTACHED_EDGE_METERS) continue;
    const startProjection = projectPointToSegment(paddockStart, fieldStart, fieldEnd);
    const endProjection = projectPointToSegment(paddockEnd, fieldStart, fieldEnd);
    const midpointProjection = projectPointToSegment(edgeMidpoint(paddockStart, paddockEnd), fieldStart, fieldEnd);
    const extension = toleranceMeters / fieldLength;
    if (
      startProjection.distanceMeters > toleranceMeters
      || endProjection.distanceMeters > toleranceMeters
      || midpointProjection.distanceMeters > toleranceMeters
      || startProjection.rawT < -extension
      || startProjection.rawT > 1 + extension
      || endProjection.rawT < -extension
      || endProjection.rawT > 1 + extension
      || segmentParallelCosine(paddockStart, paddockEnd, fieldStart, fieldEnd) < MINIMUM_PARALLEL_COSINE
    ) continue;
    matches.push({ edgeIndex, startProjection, endProjection });
  }
  return matches;
}

function applyVertexProposals(
  drafts: BoundaryDrafts,
  proposals: Map<string, VertexProposal>,
): BoundaryEditResult {
  const next = cloneBoundaryDrafts(drafts);
  const affectedIds = new Set<string>();
  proposals.forEach(({ id, vertexIndex, coordinate }) => {
    const original = next[id]?.[vertexIndex];
    if (!original || coordinatesMatch(original, coordinate)) return;
    next[id][vertexIndex] = cloneCoordinate(coordinate);
    affectedIds.add(id);
  });
  return { drafts: next, affectedIds: [...affectedIds] };
}

function addVertexProposal(proposals: Map<string, VertexProposal>, proposal: VertexProposal) {
  const key = `${proposal.id}:${proposal.vertexIndex}`;
  const current = proposals.get(key);
  if (!current || proposal.sourceDistanceMeters < current.sourceDistanceMeters) proposals.set(key, proposal);
}

function projectPointToSegment(point: Coordinate, start: Coordinate, end: Coordinate): SegmentProjection {
  const referenceLatitude = (point[0] + start[0] + end[0]) / 3;
  const longitudeScale = METERS_PER_DEGREE_LATITUDE * Math.max(0.000001, Math.cos(referenceLatitude * Math.PI / 180));
  const endX = (end[1] - start[1]) * longitudeScale;
  const endY = (end[0] - start[0]) * METERS_PER_DEGREE_LATITUDE;
  const pointX = (point[1] - start[1]) * longitudeScale;
  const pointY = (point[0] - start[0]) * METERS_PER_DEGREE_LATITUDE;
  const squaredLength = endX * endX + endY * endY;
  if (squaredLength <= Number.EPSILON) {
    return { distanceMeters: Math.hypot(pointX, pointY), rawT: 0, t: 0 };
  }
  const rawT = (pointX * endX + pointY * endY) / squaredLength;
  const t = Math.max(0, Math.min(1, rawT));
  return {
    distanceMeters: Math.hypot(pointX - t * endX, pointY - t * endY),
    rawT,
    t,
  };
}

function segmentParallelCosine(
  firstStart: Coordinate,
  firstEnd: Coordinate,
  secondStart: Coordinate,
  secondEnd: Coordinate,
): number {
  const referenceLatitude = (firstStart[0] + firstEnd[0] + secondStart[0] + secondEnd[0]) / 4;
  const longitudeScale = METERS_PER_DEGREE_LATITUDE * Math.max(0.000001, Math.cos(referenceLatitude * Math.PI / 180));
  const firstX = (firstEnd[1] - firstStart[1]) * longitudeScale;
  const firstY = (firstEnd[0] - firstStart[0]) * METERS_PER_DEGREE_LATITUDE;
  const secondX = (secondEnd[1] - secondStart[1]) * longitudeScale;
  const secondY = (secondEnd[0] - secondStart[0]) * METERS_PER_DEGREE_LATITUDE;
  const denominator = Math.hypot(firstX, firstY) * Math.hypot(secondX, secondY);
  return denominator <= Number.EPSILON ? 0 : Math.abs((firstX * secondX + firstY * secondY) / denominator);
}

function distanceMeters(first: Coordinate, second: Coordinate): number {
  const referenceLatitude = (first[0] + second[0]) / 2;
  const longitudeScale = METERS_PER_DEGREE_LATITUDE * Math.max(0.000001, Math.cos(referenceLatitude * Math.PI / 180));
  return Math.hypot(
    (second[1] - first[1]) * longitudeScale,
    (second[0] - first[0]) * METERS_PER_DEGREE_LATITUDE,
  );
}

function interpolateCoordinate(start: Coordinate, end: Coordinate, t: number): Coordinate {
  return [
    start[0] + (end[0] - start[0]) * t,
    start[1] + (end[1] - start[1]) * t,
  ];
}

function unchangedLinkedFieldResult(boundary: Coordinate[], drafts: BoundaryDrafts): LinkedFieldBoundaryEditResult {
  return { boundary: cloneRing(boundary), drafts: cloneBoundaryDrafts(drafts), affectedIds: [] };
}

function cloneRing(ring: Coordinate[]): Coordinate[] {
  return ring.map(cloneCoordinate);
}

function coordinatesMatch(first: Coordinate | undefined, second: Coordinate | undefined): boolean {
  return Boolean(first && second)
    && Math.abs(first![0] - second![0]) <= COORDINATE_EPSILON
    && Math.abs(first![1] - second![1]) <= COORDINATE_EPSILON;
}

function cloneCoordinate([latitude, longitude]: Coordinate): Coordinate {
  return [latitude, longitude];
}
