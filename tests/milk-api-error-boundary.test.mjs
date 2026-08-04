import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readSource = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("every milk API surface sanitizes and records unexpected infrastructure failures", async () => {
  const [settlements, dashboard, notifications, evidence] = await Promise.all([
    readSource("../app/api/leche/route.ts"),
    readSource("../app/api/leche/resumen/route.ts"),
    readSource("../app/api/leche/notificaciones/route.ts"),
    readSource("../app/api/leche/pabco-documentos/route.ts"),
  ]);
  const sources = [settlements, dashboard, notifications, evidence];
  for (const source of sources) {
    assert.match(source, /import \{ unexpectedApiFailure \} from "@\/app\/api-failure\.mjs"/);
  }
  for (const [source, operation] of [
    [settlements, "milk.settlement.list"],
    [dashboard, "milk.dashboard.snapshot"],
    [notifications, "milk.notifications.list"],
    [notifications, "milk.notifications.save"],
    [evidence, "milk.pabco.evidence.upload"],
    [evidence, "milk.pabco.evidence.download"],
  ]) {
    assert.match(
      source,
      new RegExp(`unexpectedApiFailure\\(\\s*"${operation.replaceAll(".", "\\.")}"`),
    );
  }
  assert.doesNotMatch(
    sources.join("\n"),
    /catch\s*(?:\([^)]*\))?\s*\{\s*return Response\.json\([\s\S]{0,180}?status:\s*500/,
  );
});
