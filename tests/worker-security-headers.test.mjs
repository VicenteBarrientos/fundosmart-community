import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { withSecurityHeaders } from "../worker/security-headers.mjs";

test("HTTPS responses receive conservative security defaults without losing application headers", async () => {
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "Content-Type": "application/json",
  });
  headers.append("Set-Cookie", "session=first; Secure; HttpOnly");
  headers.append("Set-Cookie", "mode=demo; Secure; HttpOnly");

  const secured = withSecurityHeaders(
    new Response('{"ok":true}', { status: 201, headers }),
    "https://fundosmart.com/api/example",
  );

  assert.equal(secured.status, 201);
  assert.equal(await secured.text(), '{"ok":true}');
  assert.equal(secured.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(secured.headers.getSetCookie(), [
    "session=first; Secure; HttpOnly",
    "mode=demo; Secure; HttpOnly",
  ]);
  assert.equal(secured.headers.get("Content-Security-Policy"), "base-uri 'self'; frame-ancestors 'none'; object-src 'none'");
  assert.equal(secured.headers.get("Permissions-Policy"), "camera=(), microphone=(), payment=(), usb=()");
  assert.equal(secured.headers.get("Referrer-Policy"), "strict-origin-when-cross-origin");
  assert.equal(secured.headers.get("Strict-Transport-Security"), "max-age=31536000");
  assert.equal(secured.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(secured.headers.get("X-Frame-Options"), "DENY");
  assert.equal(secured.headers.get("X-Robots-Tag"), "noindex, nofollow");
});

test("route-specific policies are preserved and HSTS is not emitted over local HTTP", () => {
  const secured = withSecurityHeaders(
    new Response(null, { headers: { "Referrer-Policy": "no-referrer" } }),
    new URL("http://localhost:3000/app"),
  );

  assert.equal(secured.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(secured.headers.get("Strict-Transport-Security"), null);
  assert.equal(secured.headers.get("Cache-Control"), "private, no-store");
  assert.equal(secured.headers.get("X-Robots-Tag"), "noindex, nofollow");
});

test("the public landing page remains cacheable while sensitive routes cannot opt into storage", () => {
  const publicResponse = withSecurityHeaders(new Response(null), "https://fundosmart.com/");
  const explicitPolicy = withSecurityHeaders(
    new Response(null, { headers: { "Cache-Control": "public, max-age=60", "X-Robots-Tag": "noindex" } }),
    "https://fundosmart.com/api/example",
  );

  assert.equal(publicResponse.headers.get("Cache-Control"), null);
  assert.equal(publicResponse.headers.get("X-Robots-Tag"), null);
  assert.equal(explicitPolicy.headers.get("Cache-Control"), "private, no-store");
  assert.equal(explicitPolicy.headers.get("X-Robots-Tag"), "noindex");
});

test("the health endpoint cannot be cached or indexed", () => {
  const health = withSecurityHeaders(
    Response.json({ status: "ok" }),
    "https://fundosmart.com/healthz",
  );

  assert.equal(health.headers.get("Cache-Control"), "private, no-store");
  assert.equal(health.headers.get("X-Robots-Tag"), "noindex, nofollow");
});

test("the legacy import-center path remains private before its canonical redirect", () => {
  const response = withSecurityHeaders(new Response(null), "https://fundosmart.com/importaciones");

  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(response.headers.get("X-Robots-Tag"), "noindex, nofollow");
});

test("redirects and every Worker fetch response pass through the same header boundary", async () => {
  const redirect = withSecurityHeaders(
    Response.redirect("https://fundosmart.com/app", 308),
    "https://fundosmart.com/dashboard",
  );
  const workerSource = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");

  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get("Location"), "https://fundosmart.com/app");
  assert.equal(redirect.headers.get("Cache-Control"), "private, no-store");
  assert.equal(redirect.headers.get("X-Frame-Options"), "DENY");
  assert.equal(redirect.headers.get("X-Robots-Tag"), "noindex, nofollow");
  assert.match(workerSource, /return withSecurityHeaders\(response, request\.url\)/);
});
