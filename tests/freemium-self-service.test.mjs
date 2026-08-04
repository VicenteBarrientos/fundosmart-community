import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const source = (relativePath) => readFile(path.join(root, relativePath), "utf8");

test("el alta pública comunica una cuenta gratis sin aprobación", async () => {
  const landing = await source("src/modules/landing/LandingPage.tsx");
  assert.match(landing, /Crear cuenta gratis/);
  assert.match(landing, /Sin aprobación manual · hasta 2 fundos y 200 potreros activos/);
  assert.match(landing, /href="\/cuenta\?modo=personal&returnTo=%2Fapp"/);
  assert.doesNotMatch(landing, /se habilita predio por predio/);
});

test("el onboarding crea el primer fundo mediante el editor de mapa", async () => {
  const [page, selector, dialog, map] = await Promise.all([
    source("src/modules/potreros/PotrerosPage.tsx"),
    source("src/modules/potreros/components/FundoSelector.tsx"),
    source("src/modules/potreros/components/CreateFundoDialog.tsx"),
    source("src/modules/potreros/components/MapaPotreros.tsx"),
  ]);
  assert.match(selector, /Nuevo fundo/);
  assert.match(selector, /Crear primer fundo/);
  assert.match(dialog, /Dibujar límite/);
  assert.match(page, /pendingNewFundo/);
  assert.match(page, /await persistFundo\(/);
  assert.match(page, /fieldLimit=\{organizationPlan\?\.fieldLimit \?\? null\}/);
  assert.match(page, /paddockLimit=\{organizationPlan\?\.paddockLimit \?\? null\}/);
  assert.match(map, /field:\$\{fundo\?\.id \?\? "new"\}/);
  assert.match(map, /boundaryEditing && !fundo/);
});

test("los límites freemium se aplican en repositorios y se exponen como conflictos de dominio", async () => {
  const [access, fieldRepository, paddockRepository, operationRepository, fieldRoute, paddockRoute] = await Promise.all([
    source("src/modules/access/server/access-repository.ts"),
    source("src/modules/potreros/server/fundo-repository.ts"),
    source("src/modules/potreros/server/potrero-repository.ts"),
    source("src/modules/potreros/server/paddock-operation-repository.ts"),
    source("app/api/fundos/route.ts"),
    source("app/api/potreros/route.ts"),
  ]);
  assert.match(access, /access\.self_service\.provisioned/);
  assert.match(access, /org-free-\$\{stableSuffix\}/);
  assert.match(fieldRepository, /PLAN_FIELD_LIMIT_REACHED/);
  assert.match(paddockRepository, /PLAN_PADDOCK_LIMIT_REACHED/);
  assert.match(operationRepository, /paddocksUsed - parents\.length \+ request\.proposedPaddocks\.length/);
  assert.match(operationRepository, /PLAN_PADDOCK_LIMIT_REACHED/);
  assert.match(fieldRoute, /\{ fundos, plan \}/);
  assert.match(paddockRoute, /cause instanceof DomainRuleError|error instanceof DomainRuleError/);
});
