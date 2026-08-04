import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("repository text stays UTF-8 and LF while binary assets avoid conversion", async () => {
  const [attributes, editorConfig] = await Promise.all([
    source(".gitattributes"),
    source(".editorconfig"),
  ]);

  assert.match(attributes, /^\* text=auto eol=lf$/m);
  for (const extension of ["dbf", "jpg", "pdf", "png", "sqlite", "webp", "woff2", "xlsx", "zip"]) {
    assert.match(attributes, new RegExp(`^\\*\\.${extension} binary !eol$`, "m"));
  }
  assert.match(editorConfig, /^root = true$/m);
  assert.match(editorConfig, /^charset = utf-8$/m);
  assert.match(editorConfig, /^end_of_line = lf$/m);
  assert.match(editorConfig, /^insert_final_newline = true$/m);
  assert.match(editorConfig, /^trim_trailing_whitespace = true$/m);
  assert.match(editorConfig, /^\[\*\.md\][\s\S]*trim_trailing_whitespace = false$/m);
});

test("el código publicado no reintroduce literales con doble codificación UTF-8", async () => {
  // Un acento guardado en UTF-8 y releido como Latin-1 se re-codifica con el prefijo
  // C3 83 / C2 XX: la o acentuada (C3 B3) queda almacenada como C3 83 C2 B3.
  const doubleEncoded = /[ÂÃ][-¿]/;
  const textExtensions = new Set([".ts", ".tsx", ".mts", ".mjs", ".js", ".jsx", ".css"]);
  const offenders = [];

  for (const directory of ["src", "app", "worker"]) {
    const base = fileURLToPath(new URL(`${directory}/`, root));
    const entries = await readdir(base, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !textExtensions.has(path.extname(entry.name))) continue;
      const file = path.join(entry.parentPath, entry.name);
      const contents = await readFile(file, "utf8");
      const line = contents.split("\n").findIndex((candidate) => doubleEncoded.test(candidate));
      if (line >= 0) offenders.push(`${directory}/${path.relative(base, file).replaceAll("\\", "/")}:${line + 1}`);
    }
  }

  assert.deepEqual(offenders, []);
});
