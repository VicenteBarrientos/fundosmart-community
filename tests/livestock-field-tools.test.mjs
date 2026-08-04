import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parseDeviceWeightText } from "../src/modules/ganado/lib/device-import.ts";

function readSource(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function compact(source) {
  return source.replace(/\s+/g, " ").trim();
}

function constantValue(source, name) {
  return source.match(new RegExp(`const\\s+${name}\\s*=\\s*["']([^"']+)["']`))?.[1] ?? null;
}

test("parseDeviceWeightText reads semicolon CSV, BOM, accented headers, decimal comma and kg suffix", () => {
  const rows = parseDeviceWeightText([
    "\uFEFFDIIO;Peso (kg)",
    "CL-0001;412,75",
    "CL-0002; 398 kg",
  ].join("\r\n"));

  assert.deepEqual(rows, [
    { tag: "CL-0001", weightKg: 412.75, line: 2 },
    { tag: "CL-0002", weightKg: 398, line: 3 },
  ]);
});

test("parseDeviceWeightText reads comma CSV with EID and weight headers", () => {
  const rows = parseDeviceWeightText([
    "EID,weight",
    '"982000123456789","521.40"',
    "982000123456790,476 kg",
  ].join("\n"));

  assert.deepEqual(rows, [
    { tag: "982000123456789", weightKg: 521.4, line: 2 },
    { tag: "982000123456790", weightKg: 476, line: 3 },
  ]);
});

test("parseDeviceWeightText reads tab-delimited, reordered DIIO/weight columns", () => {
  const rows = parseDeviceWeightText([
    "weight\tDIIO\toperador",
    '"355,6"\t"TAB-001"\tturno-a',
    "401.25\tTAB-002\tturno-b",
  ].join("\n"));

  assert.deepEqual(rows, [
    { tag: "TAB-001", weightKg: 355.6, line: 2 },
    { tag: "TAB-002", weightKg: 401.25, line: 3 },
  ]);
});

test("parseDeviceWeightText supports normalized aliases and files without a header", async (t) => {
  await t.test("identificador and peso kg", () => {
    assert.deepEqual(parseDeviceWeightText("Identificador;Peso kg\nCAR-77;288,5"), [
      { tag: "CAR-77", weightKg: 288.5, line: 2 },
    ]);
  });

  await t.test("headerless tag and weight", () => {
    assert.deepEqual(parseDeviceWeightText("SIN-001;201,25\nSIN-002;199"), [
      { tag: "SIN-001", weightKg: 201.25, line: 1 },
      { tag: "SIN-002", weightKg: 199, line: 2 },
    ]);
  });

  await t.test("empty or whitespace-only export", () => {
    assert.deepEqual(parseDeviceWeightText("\uFEFF \r\n\t\r\n"), []);
  });
});

test("parseDeviceWeightText drops malformed rows and keeps valid positive finite weights", () => {
  const rows = parseDeviceWeightText([
    "DIIO;weight",
    ";300",
    "ZERO;0",
    "NEGATIVE;-2",
    "TEXT;no-es-peso",
    "NAN;NaN",
    "INFINITY;Infinity",
    "MISSING;",
    "VALID;408,25 kg",
  ].join("\n"));

  assert.deepEqual(rows, [{ tag: "VALID", weightKg: 408.25, line: 9 }]);
});

test("the web manifest declares an installable livestock entry point", () => {
  const manifest = JSON.parse(readSource("public/manifest.webmanifest"));

  assert.equal(manifest.name, "FundoSmart — Gestión predial");
  assert.equal(manifest.short_name, "FundoSmart");
  assert.equal(manifest.lang, "es-CL");
  assert.equal(manifest.start_url, "/app");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
  assert.match(manifest.theme_color, /^#[0-9a-f]{6}$/i);
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0);
  assert.ok(manifest.icons.some((icon) => icon.src === "/fundosmart-ultra-min-app-icon-192.png" && icon.sizes === "192x192"));
  assert.ok(manifest.icons.some((icon) => icon.src === "/fundosmart-ultra-min-app-icon-512.png" && icon.purpose === "any"));
  assert.ok(manifest.icons.some((icon) => icon.src === "/fundosmart-ultra-min-app-icon-maskable-512.png" && icon.purpose === "maskable"));
  assert.ok(manifest.shortcuts.some((shortcut) => shortcut.url === "/app/ganado"));
});

test("service worker excludes APIs, uses an offline navigation fallback and caches only public assets", () => {
  const source = readSource("public/sw.js");
  const flat = compact(source);
  const guard = 'if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;';
  const guardIndex = flat.indexOf(guard);
  const respondIndex = flat.indexOf("event.respondWith", guardIndex);
  const publicAssetIndex = flat.indexOf("if (isPublicAsset(request, url))", guardIndex);

  assert.match(source, /self\.addEventListener\(["']fetch["']/);
  assert.ok(guardIndex >= 0, "cross-origin and /api/ requests must return before handling");
  assert.ok(respondIndex > guardIndex, "the navigation fallback must run after the exclusions");
  assert.ok(publicAssetIndex > respondIndex, "only the explicit public asset allowlist is cacheable");
  assert.match(flat, /fetch\(request\)\.catch\(\(\) => offlineResponse\(\)\)/);
  assert.match(flat, /response\.ok && response\.type === "basic" && !hasPrivateCacheDirective\(response\)/);
  assert.doesNotMatch(source, /cache\.addAll\([^)]*["']\/app["']/s, "the private product shell must not be precached");
});

test("IndexedDB remains foreground-scoped and background sync never replays with an unknown account", () => {
  const queue = readSource("src/core/offline/mutation-queue.ts");
  const worker = readSource("public/sw.js");
  const flatQueue = compact(queue);
  const flatWorker = compact(worker);

  assert.equal(constantValue(queue, "DB_NAME"), "fundosmart-offline");
  assert.equal(constantValue(queue, "MUTATION_STORE"), "mutations");
  assert.equal(constantValue(queue, "READ_MODEL_STORE"), "readModels");
  assert.equal(constantValue(queue, "CURSOR_STORE"), "cursors");
  assert.equal(constantValue(queue, "SESSION_STORE"), "sessions");
  assert.equal(constantValue(queue, "ATTACHMENT_STORE"), "attachments");
  assert.match(flatQueue, /indexedDB\.open\(DB_NAME, DB_VERSION\)/);
  assert.match(flatQueue, /createObjectStore\(MUTATION_STORE, \{ keyPath: "id" \}\)/);
  assert.match(flatQueue, /createObjectStore\(READ_MODEL_STORE, \{ keyPath: "id" \}\)/);
  assert.match(flatQueue, /createObjectStore\(CURSOR_STORE, \{ keyPath: "id" \}\)/);
  assert.match(flatQueue, /createObjectStore\(SESSION_STORE, \{ keyPath: "id" \}\)/);
  assert.match(flatQueue, /createObjectStore\(ATTACHMENT_STORE, \{ keyPath: "id" \}\)/);
  assert.match(flatQueue, /sync\?\.register\("fundosmart-mutations"\)/);
  assert.match(flatWorker, /event\.tag === "fundosmart-mutations"/);
  assert.match(flatWorker, /requestScopedForegroundFlush\(\)/);
  assert.match(flatWorker, /fundosmart:offline-sync-request/);
  assert.doesNotMatch(flatWorker, /indexedDB\.open|fetch\(mutation\.url|response\.status === 409/);
});

test("offline mutations require the active mode, organization, subject and field before foreground flush", () => {
  const source = readSource("src/core/offline/mutation-queue.ts");

  assert.match(source, /scope:\s*string/);
  assert.match(source, /flushOfflineMutations\(scope:\s*string\)/);
  assert.match(source, /countOfflineMutations\(scope:\s*string\)/);
  assert.match(source, /entry\.scope === scope && await scopeAllowsPartition\(scope, entry\.partition\)/);
  assert.match(source, /partition\.organizationId === `organization-by-membership:/);
  assert.match(source, /partition\.userSubject === `membership-subject:/);
  assert.match(source, /fieldIds\.includes\(partition\.fieldId\)/);
  assert.match(source, /partition\.accountMode === expectedMode/);
  assert.match(source, /partition\.organizationId === session\.organizationId/);
  assert.match(source, /partition\.userSubject === session\.userSubject/);
  assert.match(source, /attempt\.response\.status === 401 \|\| attempt\.response\.status === 403/);
  assert.doesNotMatch(source, /response\.ok \|\| response\.status === 409|deleteMutation/);
});

test("TerrenoSection scopes its queue, syncs on reconnect and targets Phase 0 sync", () => {
  const source = readSource("src/modules/ganado/components/TerrenoSection.tsx");
  const flat = compact(source);

  assert.match(flat, /offlineScope: string/);
  assert.match(flat, /countOfflineMutations\(offlineScope\)/);
  assert.match(flat, /flushOfflineMutations\(offlineScope\)/);
  assert.ok(source.indexOf("await flushOfflineMutations(offlineScope)") < source.indexOf("await flushOfflineAttachments(offlineScope)"));
  assert.ok((source.match(/scope:\s*offlineScope/g) ?? []).length >= 2, "every field capture must retain the active scope");
  assert.match(flat, /window\.addEventListener\("online", handleOnline\)/);
  assert.match(flat, /navigator\.serviceWorker\?\.addEventListener\("message", handleWorker\)/);
  assert.match(source, /sendOrQueueSyncMutations/u);
  assert.match(source, /offlinePartitionFromSession/u);
  assert.match(source, /refreshOfflineSession/u);
  for (const entity of ["livestock_weighing", "livestock_health", "livestock_estrus", "livestock_movement"]) {
    assert.match(source, new RegExp(`entity: "${entity}"`, "u"));
  }
});

test("queued livestock endpoints implement stable idempotency keys", () => {
  const weighingRepository = readSource("src/modules/ganado/server/livestock-weighing-repository.ts");
  const animalRecordRepository = readSource("src/modules/ganado/ficha/server/animal-record-repository.ts");
  const operationsRoute = readSource("app/api/ganado/operaciones/route.ts");

  assert.match(weighingRepository, /id:\s*`weight-\$\{entry\.animalId\}-\$\{recordedAt\}`/);
  assert.match(compact(weighingRepository), /ON CONFLICT\(animal_id, recorded_at\) DO UPDATE/);

  assert.match(animalRecordRepository, /const birthId = `birth:\$\{input\.animalId\}:\$\{input\.occurredAt\}`/);
  assert.match(animalRecordRepository, /if \(existingBirth\) return requireAnimalRecord\(input\.animalId, accessScope\)/);
  assert.match(animalRecordRepository, /`health-batch:\$\{batchId\}:\$\{input\.animalId\}`/);
  assert.match(compact(animalRecordRepository), /insert\(livestockHealthEvents\)\.values\(values\)\.onConflictDoNothing\(\)/);

  assert.match(operationsRoute, /batchId\?: unknown/);
  assert.match(operationsRoute, /payload\.batchId/);
  assert.match(operationsRoute, /saveHealthEventsBatch\(inputs, access\.email, batchId\)/);
});
