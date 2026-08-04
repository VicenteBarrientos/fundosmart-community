import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("the product shell owns one manual module refresh without polling", async () => {
  const [shell, control, dashboard] = await Promise.all([
    source("src/core/layout/AppShell.tsx"),
    source("src/ui/ModuleRefreshControl.tsx"),
    source("src/modules/dashboard/DashboardPage.tsx"),
  ]);

  assert.match(shell, /<ModuleRefreshControl[\s\S]*label=\{moduleLabel\}[\s\S]*moduleKey=\{activeSection\}[\s\S]*onRefresh=\{onRefresh\}/u);
  assert.match(control, /startRouteRefresh\(\(\) => \{\s*router\.refresh\(\)/u);
  assert.match(control, /aria-label=\{`Actualizar \$\{label\}`\}/u);
  assert.match(control, /<time[\s\S]*Actualizado \{formatModuleUpdatedAt\(visibleUpdatedAt\)\}/u);
  assert.match(control, /timeZone: "America\/Santiago"/u);
  assert.match(control, /await onRefresh\(\)/u);
  assert.match(control, /response\.ok && isModuleMutation\(moduleKey, args\[0\], args\[1\]\)/u);
  assert.match(control, /method !== "POST" && method !== "PUT" && method !== "PATCH" && method !== "DELETE"/u);
  assert.doesNotMatch(control, /setInterval\(|setTimeout\(/u);

  assert.match(dashboard, /snapshotGeneratedAt=\{generatedAt\}/u);
  assert.match(dashboard, /setAgendaManagement\(initialAgendaManagement\)/u);
  assert.doesNotMatch(dashboard, /aria-label="Actualizar resumen"/u);
});

test("Ganado defers supporting section data and caches it for the module visit", async () => {
  const [route, page, client] = await Promise.all([
    source("app/(producto)/ganado/page.tsx"),
    source("src/modules/ganado/GanadoPage.tsx"),
    source("src/modules/ganado/api/livestock-client.ts"),
  ]);

  assert.doesNotMatch(route, /listPotreros\(access\)/u);
  assert.doesNotMatch(route, /listLivestockFeedingPlans\(access\)/u);
  assert.doesNotMatch(route, /listLivestockFeedData\(access\.fieldIds\)/u);
  assert.match(route, /initialFeedConsumptions=\{\[\]\}/u);
  assert.match(page, /type DeferredDataKey = "paddocks" \| "feeding"/u);
  assert.match(page, /deferredState\.paddocks === "loaded"/u);
  assert.match(page, /deferredState\.feeding === "loaded"/u);
  assert.match(page, /if \(deferredRequests\.current\.paddocks\)/u);
  assert.match(page, /if \(deferredRequests\.current\.feeding\)/u);
  assert.match(page, /onClick=\{\(\) => openTab\(item\.key\)\}/u);
  assert.match(client, /fetchLivestockFeedingPlans/u);
  assert.match(client, /fetchLivestockFeedData/u);
});

test("Leche loads the operational snapshot on first relevant section access and reuses it", async () => {
  const [route, page] = await Promise.all([
    source("app/(producto)/leche/page.tsx"),
    source("src/modules/leche/LechePage.tsx"),
  ]);

  assert.match(route, /const needsOperationalSnapshot = initialSection !== "settlements" && initialSection !== "simulator"/u);
  assert.match(route, /needsOperationalSnapshot \? getMilkModuleSnapshot\(access\) : Promise\.resolve\(null\)/u);
  assert.match(page, /initialSnapshot: MilkModuleSnapshot \| null/u);
  assert.match(page, /snapshotCacheRef = useRef\(new Map<string, MilkModuleSnapshot>\(\)\)/u);
  assert.match(page, /if \(!force && cached\)/u);
  assert.match(page, /sectionNeedsOperationalSnapshot\(section\.id\)/u);
  assert.match(page, /return section !== "settlements" && section !== "simulator"/u);
  assert.match(page, /snapshot \? \(\s*<MilkModuleSections/u);
  assert.match(page, /<ModuleSectionLoading \/>/u);
});

test("the import inbox stays mounted after its first lazy visit", async () => {
  const page = await source("src/modules/importaciones/ImportacionesPage.tsx");

  assert.match(page, /const \[inboxVisited, setInboxVisited\] = useState\(false\)/u);
  assert.match(page, /setInboxVisited\(true\); setActiveTab\("inbox"\)/u);
  assert.match(page, /\{inboxVisited && \([\s\S]*<InboxSection/u);
  assert.match(page, /activeTab === "inbox" \? "mt-6" : "hidden"/u);
});
