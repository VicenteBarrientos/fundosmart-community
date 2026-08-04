import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("Cloudflare Static Assets inherit security defaults and deliberate cache lifetimes", async () => {
  const [sourceHeaders, builtHeaders] = await Promise.all([
    readFile(new URL("public/_headers", root), "utf8"),
    readFile(new URL("dist/client/_headers", root), "utf8"),
  ]);

  assert.equal(builtHeaders, sourceHeaders);
  assert.match(sourceHeaders, /\/\*\s+Content-Security-Policy: base-uri 'self'; frame-ancestors 'none'; object-src 'none'/);
  assert.match(sourceHeaders, /Permissions-Policy: camera=\(\), microphone=\(\), payment=\(\), usb=\(\)/);
  assert.match(sourceHeaders, /Referrer-Policy: strict-origin-when-cross-origin/);
  assert.match(sourceHeaders, /Strict-Transport-Security: max-age=31536000/);
  assert.match(sourceHeaders, /X-Content-Type-Options: nosniff/);
  assert.match(sourceHeaders, /X-Frame-Options: DENY/);
  assert.match(sourceHeaders, /\/assets\/\*\s+Cache-Control: public, max-age=31536000, immutable/);
  assert.match(sourceHeaders, /\/landing\/\*\s+Cache-Control: public, max-age=86400, stale-while-revalidate=604800/);
  assert.match(sourceHeaders, /\/og\.png\s+Cache-Control: public, max-age=86400, stale-while-revalidate=604800/);
  assert.match(sourceHeaders, /\/manifest\.webmanifest\s+Cache-Control: no-cache, max-age=0/);
  assert.match(sourceHeaders, /\/sw\.js\s+Cache-Control: no-cache, max-age=0/);
  assert.match(sourceHeaders, /\/favicon\.ico\s+Cache-Control: no-cache, max-age=0/);
  assert.match(sourceHeaders, /\/apple-touch-icon\.png\s+Cache-Control: no-cache, max-age=0/);
});
