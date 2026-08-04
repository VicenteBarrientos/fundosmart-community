import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  CURRENT_LEGAL_DOCUMENT_RELEASES,
} from "../src/modules/legal/legal-acceptance.mjs";

const root = new URL("../", import.meta.url);

test("each legal release seals the exact public source shown to the person", async () => {
  for (const [kind, relativePath] of [
    ["privacy", "app/privacidad/page.tsx"],
    ["terms", "app/terminos/page.tsx"],
  ]) {
    const source = await readFile(new URL(relativePath, root));
    const digest = createHash("sha256").update(source).digest("hex");
    assert.equal(
      CURRENT_LEGAL_DOCUMENT_RELEASES[kind].contentSha256,
      digest,
      `${kind} changed without publishing a new sealed legal release`,
    );
  }
});
