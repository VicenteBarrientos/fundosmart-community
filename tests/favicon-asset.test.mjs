import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the conventional favicon route has a real multi-size ICO asset", async () => {
  const [icon, mark, favicon, layout, serviceWorker, generator] = await Promise.all([
    readFile(new URL("../public/favicon.ico", import.meta.url)),
    readFile(new URL("../public/fundosmart-ultra-min-mark.png", import.meta.url)),
    readFile(new URL("../public/fundosmart-ultra-min-favicon.svg", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
    readFile(new URL("../scripts/assets/generate-favicon.mjs", import.meta.url), "utf8"),
  ]);

  assert.equal(icon.readUInt16LE(0), 0);
  assert.equal(icon.readUInt16LE(2), 1);
  assert.deepEqual([...mark.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.match(favicon, /fill="#050505"/);
  assert.match(favicon, /data:image\/png;base64,/);
  const count = icon.readUInt16LE(4);
  assert.equal(count, 6);
  const sizes = [];
  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16;
    const width = icon.readUInt8(entry) || 256;
    const height = icon.readUInt8(entry + 1) || 256;
    const length = icon.readUInt32LE(entry + 8);
    const offset = icon.readUInt32LE(entry + 12);
    assert.equal(width, height);
    assert.ok(offset >= 6 + count * 16);
    assert.ok(offset + length <= icon.length);
    assert.deepEqual([...icon.subarray(offset, offset + 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    sizes.push(width);
  }
  assert.deepEqual(sizes, [16, 32, 48, 64, 128, 256]);
  assert.match(layout, /shortcut: "\/fundosmart-ultra-min-favicon\.ico"/);
  assert.match(serviceWorker, /"\/fundosmart-ultra-min-favicon\.ico"/);
  assert.match(generator, /fundosmart-ultra-min-favicon\.svg/);
  assert.match(generator, /fundosmart-ultra-min-favicon\.ico/);
  assert.match(generator, /Buffer\.concat\(\[directory, \.\.\.images\]\)/);
});
