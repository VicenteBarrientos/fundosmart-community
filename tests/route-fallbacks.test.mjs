import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("unknown routes and render failures receive branded, actionable fallbacks", async () => {
  const [notFound, errorBoundary, fallback] = await Promise.all([
    source("app/not-found.tsx"),
    source("app/error.tsx"),
    source("src/core/layout/RouteFallback.tsx"),
  ]);

  assert.match(notFound, /Ruta no encontrada · 404/);
  assert.match(notFound, /href="\/"/);
  assert.match(notFound, /href="\/app"/);
  assert.match(errorBoundary, /^"use client";/);
  assert.match(errorBoundary, /onClick=\{\(\) => reset\(\)\}/);
  assert.match(errorBoundary, /Intentar de nuevo/);
  assert.doesNotMatch(errorBoundary, /error\.message|error\.stack|digest/);
  assert.match(fallback, /FundoSmartMark/);
  assert.match(fallback, /min-h-screen/);
  assert.match(fallback, /role=\{announce \? "alert" : undefined\}/);
  assert.match(fallback, /aria-live=\{announce \? "assertive" : undefined\}/);
});

test("denied access offers a real exit instead of looping every user back to the product", async () => {
  const noAccess = await source("app/sin-acceso/page.tsx");

  assert.match(noAccess, /MEMBERSHIP_REQUIRED:[\s\S]*returnToProduct: false/);
  assert.match(noAccess, /MEMBERSHIP_SUSPENDED:[\s\S]*returnToProduct: false/);
  assert.match(noAccess, /MEMBERSHIP_AMBIGUOUS:[\s\S]*returnToProduct: false/);
  assert.match(noAccess, /CAPABILITY_REQUIRED:[\s\S]*returnToProduct: true/);
  assert.match(noAccess, /FIELD_REQUIRED:[\s\S]*returnToProduct: true/);
  assert.match(noAccess, /await searchParams/);
  assert.match(noAccess, /copy\.returnToProduct \? "\/app" : "\/demo\?returnTo=%2Fapp"/);
  assert.match(noAccess, /href="\/"/);
  assert.match(noAccess, /RouteFallback/);
});
