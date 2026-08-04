import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const sourceContractTest = process.env.FUNDOSMART_SOURCE_CONTRACTS === "1" ? test : test.skip;
const [page, map, dialog, history, panel, list, activitiesClient, draftsClient, operationsClient] = await Promise.all([
  source("src/modules/potreros/PotrerosPage.tsx"),
  source("src/modules/potreros/components/MapaPotreros.tsx"),
  source("src/modules/potreros/components/BulkSubdivisionDialog.tsx"),
  source("src/modules/potreros/components/HistorialPotrero.tsx"),
  source("src/modules/potreros/components/MapPotreroPanel.tsx"),
  source("src/modules/potreros/components/ListaPotreros.tsx"),
  source("src/modules/potreros/api/activities-client.ts"),
  source("src/modules/potreros/api/subdivision-drafts-client.ts"),
  source("src/modules/potreros/api/paddock-operations-client.ts"),
]);

sourceContractTest("field and paddock subdivision scopes keep independent CAS drafts", () => {
  assert.match(map, /export type SubdivisionScope =[\s\S]+kind: "field"[\s\S]+kind: "paddock"/);
  assert.match(page, /scopeKind: scope\.kind/);
  assert.match(page, /function subdivisionScopeId\(scope: SubdivisionScope\)[\s\S]+scope\.kind === "field" \? scope\.fieldId : scope\.paddockId/);
  assert.match(page, /baseSnapshotToken/);
  assert.match(page, /expectedUpdatedAt/);
  assert.match(page, /draftMatchesBase = draft\?\.baseSnapshotToken === baseSnapshotToken/);
  assert.match(page, /fetchServerScopedSubdivisionDraft\(scope\.fieldId, scope\.kind, subdivisionScopeId\(scope\)\)/);
  assert.match(draftsClient, /class SubdivisionDraftApiError/);
  assert.match(page, /if \(draft && draftMatchesBase\)[\s\S]+setSubdivisionHistory\(draft\.history\)/);
  assert.match(page, /setStaleSubdivisionDraft\(draft\)[\s\S]+No se restauró|no se restauró/i);

  const begin = section(page, "async function beginSubdivision", "function applySubdivisionLine");
  assert.match(begin, /scope\.kind === "paddock"[\s\S]+\[parent!\.coordinates\]/);
  assert.match(begin, /scope\.kind === "field"/);
});

sourceContractTest("subdivision autosave is content-driven, serialized, and bounded", () => {
  const save = section(page, "const saveSubdivisionDraftNow", "  useEffect(() => {\n    const saved = window.localStorage");
  const autosave = section(page, "  useEffect(() => {\n    if (!canMutate || !subdivisionScope", "  const selectedFundo");

  assert.match(save, /subdivisionSavePromiseRef\.current[\s\S]+\.catch\(\(\) => undefined\)[\s\S]+\.then\(async \(\) =>/);
  assert.match(save, /session\.updatedAt/);
  assert.match(save, /compactSubdivisionHistory\(history\)/);
  assert.match(autosave, /subdivisionSaveSessionRef\.current\.state === "stale"/);
  assert.doesNotMatch(autosave, /\bsubdivisionDraftState\b/);
});

sourceContractTest("subdivision hover snap is frame-limited and does not rerender the complete map", () => {
  const events = section(map, "function SubdivisionDrawingEvents", "function MapFocus");

  assert.match(events, /requestAnimationFrame/);
  assert.match(events, /nearestSubdivisionBoundaryPoint\(coordinate, polygons, maximumDistanceMeters\)/);
  assert.match(events, /const \[snapPoint, setSnapPoint\] = useState<Coordinate \| null>/);
  assert.doesNotMatch(map, /const \[subdivisionSnap, setSubdivisionSnap\]/);
});

sourceContractTest("individual subdivision keeps unrelated paddocks dimmed and non-interactive", () => {
  assert.match(map, /subdivisionScope\?\.kind === "paddock"/);
  assert.match(map, /potrero\.id !== subdivisionScope\.paddockId/);
  assert.match(map, /interactive=\{false\}/);
  assert.match(map, /fillOpacity: 0\.1/);
  assert.match(map, /fuera de la operación/);
});

sourceContractTest("accessible multiple selection builds a merge preview before commit", () => {
  assert.match(list, /type="checkbox"/);
  assert.match(list, /aria-label=\{`Seleccionar \$\{potrero\.name\} para fusionar`\}/);
  assert.match(list, /checked=\{selectedForMerge\}/);
  assert.match(list, /disabled=\{selectedIds\.length < 2 \|\| !structuralOperationsEnabled\}/);
  assert.match(list, /Fusionar/);

  const merge = section(page, "async function openMergeConfirmation", "async function openOperationPreview");
  assert.match(merge, /planMerge\(/);
  assert.match(merge, /selectedIds\.includes\(potrero\.id\)/);
  assert.match(merge, /openOperationPreview/);
});

sourceContractTest("inherited activities are labelled and remain read-only", () => {
  assert.match(history, /activity\.inherited/);
  assert.match(history, /Heredada de «\{activity\.sourcePaddockName/);
  assert.match(history, /!activity\.inherited && canMutate/);
  assert.match(page, /fetchActivitiesWithLineage\(selectedId\)/);
  assert.match(activitiesClient, /includeLineage: "1"/);
});

sourceContractTest("operation confirmation enumerates lot destinations, confidence, warnings, and blockers", () => {
  assert.match(dialog, /Destino de lotes ganaderos/);
  assert.match(dialog, /destinationPaddockName/);
  assert.match(dialog, /overlapRatio \* 100/);
  assert.match(dialog, /% confianza/);
  assert.match(dialog, /warnings\.map/);
  assert.match(dialog, /blockers\.map/);
  assert.match(dialog, /disabled=\{saving \|\| blockers\.length > 0\}/);
  assert.match(dialog, /se conservarán y seguirán consultables mediante el historial heredado/);
});

sourceContractTest("structural operations never apply offline or before a successful server commit", () => {
  const confirm = section(page, "async function confirmSubdivision", "function toggleSelectedForMerge");
  assert.match(confirm, /if \(!networkOnline\) throw new Error\("Sin conexión: la operación no se aplicó ni se encoló\."\)/);
  assert.doesNotMatch(confirm, /executeOrQueue|enqueue/);
  const commitIndex = confirm.indexOf("await confirmPaddockOperation");
  const activeStateIndex = confirm.indexOf("setPotreros", commitIndex);
  assert.ok(commitIndex >= 0 && activeStateIndex > commitIndex);
  assert.match(confirm, /expectedSnapshotToken: refreshedPreview\.snapshotToken/);
  assert.match(confirm, /Recarga el fundo|Recarga el fundo/i);
  assert.match(operationsClient, /class PaddockOperationApiError/);
});

sourceContractTest("confirmation preserves activities and consumes a complete active snapshot", () => {
  const confirm = section(page, "async function confirmSubdivision", "function toggleSelectedForMerge");
  assert.doesNotMatch(confirm, /setActivities|currentIds|activity\.potreroId/);
  assert.match(confirm, /current\.filter\(\(potrero\) => potrero\.fieldId !== selectedFundo\.id\), \.\.\.result\.activePaddocks/);
  assert.match(confirm, /setArchivedPotreros\(\(current\) => reconcileArchivedPaddocks\(current, result\)\)/);
});

sourceContractTest("archived view, guarded undo, and read-only roles are explicit", () => {
  assert.match(list, /Ver archivados/);
  assert.match(list, /Potreros archivados/);
  assert.match(page, /fetchArchivedPaddocks\(selectedFundoId\)/);
  assert.match(panel, /undoPreview\?\.canUndo && onUndo/);
  assert.match(page, /kind: "undo"/);
  assert.match(page, /const canMutate = !isDemo && !offlineScope\.split\("\."\)\.includes\("viewer"\)/);
  assert.match(page, /selectedPotreroCanMutate=\{canMutate && !\(selectedPotrero as Phase1Potrero \| null\)\?\.archivedAt\}/);
  assert.match(panel, /\{canMutate && \(/);
  assert.match(history, /Vista de solo lectura/);
  assert.match(map, /\{canMutate && \(/);
});

function section(contents, start, end) {
  const startIndex = contents.indexOf(start);
  const endIndex = contents.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return contents.slice(startIndex, endIndex);
}

function source(path) {
  return readFile(new URL(path, root), "utf8");
}
