import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("only the canonical public landing page is advertised for indexing", async () => {
  const [page, robots, sitemap] = await Promise.all([
    source("app/page.tsx"),
    source("app/robots.ts"),
    source("app/sitemap.ts"),
  ]);

  assert.match(page, /canonical: publicUrl\(\)/);
  assert.match(page, /follow: true/);
  assert.match(page, /index: true/);
  assert.match(robots, /allow: "\/"/);
  assert.match(robots, /sitemap: publicUrl\("\/sitemap\.xml"\)/);
  assert.doesNotMatch(robots, /disallow:/i);
  assert.match(sitemap, /url: publicUrl\(\)/);
  assert.match(sitemap, /import \{ publicUrl \} from "\.\/public-url"/);
  assert.doesNotMatch(sitemap, /\/app|\/api|\/demo|\/cuenta/);
});
