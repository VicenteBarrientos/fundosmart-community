import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createGpsCaptureRuntime,
  gpsPositionError,
} from "../src/modules/potreros/hooks/useGpsBoundaryCapture.ts";
import {
  finalizeGpsBoundary,
  gpsBoundaryCoordinatesToDraft,
  GPS_MAX_ACCURACY_METERS,
  GPS_MIN_VERTEX_DISTANCE_METERS,
  GPS_SIMPLIFY_TOLERANCE_METERS,
  processGpsSample,
} from "../src/modules/potreros/utils/gps-capture.ts";
import {
  calculateAreaSquareMeters,
  metersToDegrees,
} from "../src/modules/potreros/utils/geometry.ts";

const OSORNO = [-40.57, -73.13];

test("el filtro acepta el primer fix preciso y exige estrictamente <15 m y al menos 8 m", () => {
  const first = processGpsSample([], sampleAt(OSORNO, { accuracyMeters: 14.99, timestamp: 1 }));
  assert.equal(first.decision.reason, "accepted_first");
  assert.equal(first.acceptedFixes.length, 1);

  const tooCloseCoordinate = [
    OSORNO[0],
    OSORNO[1] + metersToDegrees(GPS_MIN_VERTEX_DISTANCE_METERS - 0.1, OSORNO[0]),
  ];
  const tooClose = processGpsSample(
    first.acceptedFixes,
    sampleAt(tooCloseCoordinate, { accuracyMeters: 4, timestamp: 2 }),
  );
  assert.equal(tooClose.decision.reason, "too_close");
  assert.equal(tooClose.acceptedFixes, first.acceptedFixes, "un fix omitido no copia ni muta la traza");

  const exactThreshold = processGpsSample(
    first.acceptedFixes,
    sampleAt([
      OSORNO[0] + metersToDegrees(GPS_MIN_VERTEX_DISTANCE_METERS, OSORNO[0], "latitude"),
      OSORNO[1],
    ], { accuracyMeters: 4, timestamp: 2.5 }),
  );
  assert.equal(exactThreshold.decision.reason, "accepted_distance");

  const inaccurate = processGpsSample(
    first.acceptedFixes,
    sampleAt([
      OSORNO[0],
      OSORNO[1] + metersToDegrees(20, OSORNO[0]),
    ], { accuracyMeters: GPS_MAX_ACCURACY_METERS, timestamp: 3 }),
  );
  assert.equal(inaccurate.decision.reason, "low_accuracy");

  const farEnough = processGpsSample(
    first.acceptedFixes,
    sampleAt([
      OSORNO[0],
      OSORNO[1] + metersToDegrees(GPS_MIN_VERTEX_DISTANCE_METERS + 0.1, OSORNO[0]),
    ], { accuracyMeters: 5, timestamp: 4 }),
  );
  assert.equal(farEnough.decision.reason, "accepted_distance");
  assert.equal(farEnough.acceptedFixes.length, 2);
  assert.ok(farEnough.decision.distanceFromLastAcceptedMeters > GPS_MIN_VERTEX_DISTANCE_METERS);

  const invalid = processGpsSample(farEnough.acceptedFixes, {
    ...sampleAt(OSORNO, { timestamp: 5 }),
    latitude: Number.NaN,
  });
  assert.equal(invalid.fix, null);
  assert.equal(invalid.decision.reason, "invalid_sample");
});

test("el adaptador de GPS convierte el ring cerrado al draft abierto sin mutar", () => {
  const closed = [
    [-40.57, -73.13],
    [-40.57, -73.129],
    [-40.569, -73.129],
    [-40.57, -73.13],
  ];
  const before = structuredClone(closed);

  assert.deepEqual(gpsBoundaryCoordinatesToDraft(closed), closed.slice(0, -1));
  assert.deepEqual(gpsBoundaryCoordinatesToDraft(closed.slice(0, -1)), closed.slice(0, -1));
  assert.deepEqual(closed, before);
});

test("la finalización simplifica en metros, cierra el anillo y valida un recorrido de Osorno", () => {
  const sideMeters = 100;
  const north = metersToDegrees(sideMeters, OSORNO[0], "latitude");
  const east = metersToDegrees(sideMeters, OSORNO[0]);
  const corners = [
    OSORNO,
    [OSORNO[0], OSORNO[1] + east],
    [OSORNO[0] + north, OSORNO[1] + east],
    [OSORNO[0] + north, OSORNO[1]],
  ];
  const denseBoundary = corners.flatMap((corner, index) => interpolateSide(
    corner,
    corners[(index + 1) % corners.length],
    25,
  ));
  const acceptedFixes = denseBoundary.map((coordinate, index) => fixAt(coordinate, index));
  const before = structuredClone(acceptedFixes);

  const result = finalizeGpsBoundary(acceptedFixes);

  assert.equal(GPS_SIMPLIFY_TOLERANCE_METERS, 2);
  assert.equal(result.rawVertexCount, 100);
  assert.ok(result.simplifiedVertexCount <= 5);
  assert.equal(result.coordinates.length, result.simplifiedVertexCount + 1);
  assert.deepEqual(result.coordinates[0], result.coordinates.at(-1));
  assert.equal(result.valid, true);
  assert.deepEqual(result.validation.errors, []);
  assert.ok(Math.abs(calculateAreaSquareMeters(result.coordinates) - 10_000) < 200);
  assert.deepEqual(acceptedFixes, before, "finalizar no muta los fixes capturados");
});

test("la validación final bloquea trazas insuficientes y auto-intersectadas", () => {
  const short = finalizeGpsBoundary([
    fixAt(OSORNO, 1),
    fixAt([OSORNO[0], OSORNO[1] + 0.001], 2),
  ]);
  assert.equal(short.valid, false);
  assert.match(short.validation.errors.join(" "), /al menos 3 vértices/iu);

  const bowTie = finalizeGpsBoundary([
    fixAt([-40.57, -73.13], 1),
    fixAt([-40.568, -73.128], 2),
    fixAt([-40.57, -73.128], 3),
    fixAt([-40.568, -73.13], 4),
  ]);
  assert.equal(bowTie.valid, false);
  assert.match(bowTie.validation.errors.join(" "), /cruza consigo mismo/iu);
});

test("un restart invalida callbacks y wake locks viejos sin contaminar la nueva captura", async () => {
  const watchers = new Map();
  const cleared = [];
  const wakeRequests = [];
  let nextWatchId = 0;
  const runtime = createGpsCaptureRuntime({
    watchPosition(onPosition, onError) {
      const watchId = ++nextWatchId;
      watchers.set(watchId, { onPosition, onError });
      return watchId;
    },
    clearWatch(watchId) {
      cleared.push(watchId);
    },
    requestWakeLock() {
      const request = deferred();
      wakeRequests.push(request);
      return request.promise;
    },
  });
  const first = callbackRecorder();
  const second = callbackRecorder();

  assert.equal(runtime.start(first.callbacks), true);
  watchers.get(1).onPosition(sampleAt(OSORNO, { timestamp: 1 }));
  assert.equal(first.positions.length, 1);
  assert.equal(runtime.start(second.callbacks), true);
  assert.deepEqual(cleared, [1]);

  watchers.get(1).onPosition(sampleAt([-40.56, -73.12], { timestamp: 2 }));
  watchers.get(1).onError({ code: 2 });
  assert.equal(first.positions.length, 1, "callbacks del watch anterior quedan invalidados");
  assert.equal(first.errors.length, 0);

  const staleLease = new MockWakeLockLease();
  wakeRequests[0].resolve(staleLease);
  await eventLoopTurn();
  assert.equal(staleLease.releaseCalls, 1, "un wake lock resuelto tarde se libera inmediatamente");
  assert.doesNotMatch(second.wakeStatuses.join(" "), /active/u);

  const currentLease = new MockWakeLockLease();
  wakeRequests[1].resolve(currentLease);
  await eventLoopTurn();
  assert.equal(second.wakeStatuses.at(-1), "active");
  watchers.get(2).onPosition(sampleAt([-40.569, -73.129], { timestamp: 3 }));
  assert.equal(second.positions.length, 1);

  currentLease.simulateBrowserRelease();
  assert.equal(second.wakeStatuses.at(-1), "inactive");
  runtime.refreshWakeLock();
  const reacquiredLease = new MockWakeLockLease();
  wakeRequests[2].resolve(reacquiredLease);
  await eventLoopTurn();
  assert.equal(second.wakeStatuses.at(-1), "active");

  runtime.stop();
  assert.deepEqual(cleared, [1, 2]);
  assert.equal(reacquiredLease.releaseCalls, 1);
  watchers.get(2).onPosition(sampleAt([-40.55, -73.11], { timestamp: 4 }));
  assert.equal(second.positions.length, 1, "stop también invalida callbacks ya encolados");
});

test("un error síncrono durante watchPosition limpia el identificador retornado", () => {
  const cleared = [];
  let runtime;
  runtime = createGpsCaptureRuntime({
    watchPosition(_onPosition, onError) {
      onError({ code: 1 });
      return 99;
    },
    clearWatch(watchId) {
      cleared.push(watchId);
    },
  });

  const started = runtime.start({
    onPosition() {},
    onError() {
      runtime.stop();
    },
    onWakeLockStatus() {},
  });
  assert.equal(started, false);
  assert.deepEqual(cleared, [99]);
});

test("un wake lock que falla sincrónicamente no interrumpe el watch GPS", () => {
  const wakeStatuses = [];
  const runtime = createGpsCaptureRuntime({
    watchPosition() {
      return 7;
    },
    clearWatch() {},
    requestWakeLock() {
      throw new Error("wake lock blocked");
    },
  });

  const started = runtime.start({
    onPosition() {},
    onError() {},
    onWakeLockStatus: (status) => wakeStatuses.push(status),
  });
  assert.equal(started, true);
  assert.deepEqual(wakeStatuses, ["requesting", "unavailable"]);
  runtime.stop();
});

test("errores públicos y fronteras SSR/browser quedan explícitos", async () => {
  assert.equal(gpsPositionError(1).code, "permission_denied");
  assert.match(gpsPositionError(1).message, /permiso de ubicación/iu);
  assert.equal(gpsPositionError(2).code, "position_unavailable");
  assert.equal(gpsPositionError(3).code, "timeout");
  assert.equal(gpsPositionError(99).code, "watch_failed");

  const [hookSource, utilitySource] = await Promise.all([
    readFile(new URL("../src/modules/potreros/hooks/useGpsBoundaryCapture.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/modules/potreros/utils/gps-capture.ts", import.meta.url), "utf8"),
  ]);
  assert.match(hookSource, /Permissions is deliberately optional/u);
  assert.match(hookSource, /enableHighAccuracy: true/u);
  assert.match(hookSource, /window\.isSecureContext/u);
  assert.doesNotMatch(utilitySource, /\b(?:navigator|window|document|GeolocationPosition)\b/u);
});

function sampleAt(coordinate, overrides = {}) {
  return {
    latitude: coordinate[0],
    longitude: coordinate[1],
    accuracyMeters: 5,
    timestamp: 0,
    altitudeMeters: null,
    headingDegrees: null,
    speedMetersPerSecond: null,
    ...overrides,
  };
}

function fixAt(coordinate, timestamp) {
  return {
    coordinate: [...coordinate],
    accuracyMeters: 5,
    timestamp,
    altitudeMeters: null,
    headingDegrees: null,
    speedMetersPerSecond: null,
  };
}

function interpolateSide(start, end, count) {
  return Array.from({ length: count }, (_, index) => {
    const ratio = index / count;
    return [
      start[0] + (end[0] - start[0]) * ratio,
      start[1] + (end[1] - start[1]) * ratio,
    ];
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function eventLoopTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function callbackRecorder() {
  const positions = [];
  const errors = [];
  const wakeStatuses = [];
  return {
    positions,
    errors,
    wakeStatuses,
    callbacks: {
      onPosition: (sample) => positions.push(sample),
      onError: (error) => errors.push(error),
      onWakeLockStatus: (status) => wakeStatuses.push(status),
    },
  };
}

class MockWakeLockLease {
  released = false;
  releaseCalls = 0;
  listeners = new Set();

  addEventListener(_type, listener) {
    this.listeners.add(listener);
  }

  removeEventListener(_type, listener) {
    this.listeners.delete(listener);
  }

  async release() {
    this.releaseCalls += 1;
    this.released = true;
  }

  simulateBrowserRelease() {
    this.released = true;
    for (const listener of [...this.listeners]) listener();
  }
}
