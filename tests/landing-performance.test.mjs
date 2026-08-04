import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("the landing page hydrates only its interactive islands", async () => {
  const [landing, motion, navigation, showcase, reveal] = await Promise.all([
    source("src/modules/landing/LandingPage.tsx"),
    source("src/modules/landing/LandingMotion.tsx"),
    source("src/modules/landing/LandingNavigation.tsx"),
    source("src/modules/landing/ProductShowcase.tsx"),
    source("src/modules/landing/Reveal.tsx"),
  ]);

  assert.doesNotMatch(landing, /^"use client";/);
  assert.doesNotMatch(landing, /from "next\/link"|useState/);
  assert.match(landing, /<LandingNavigation \/>/);
  assert.match(landing, /<ProductShowcase \/>/);
  assert.match(landing, /<LandingMotion \/>/);
  assert.match(landing, /data-landing-motion-root/);
  assert.match(landing, /<details className="landing-faq-item/);
  assert.match(motion, /^"use client";/);
  assert.match(motion, /prefers-reduced-motion: reduce/);
  assert.match(motion, /requestAnimationFrame/);
  assert.match(navigation, /^"use client";/);
  assert.match(showcase, /^"use client";/);
  assert.match(showcase, /aria-pressed=\{selected\}/);
  assert.match(reveal, /^"use client";/);
  assert.match(reveal, /prefers-reduced-motion: reduce/);
});

test("the approved hero and real-product views remain the first two landing scenes", async () => {
  const landing = await source("src/modules/landing/LandingPage.tsx");

  assert.match(landing, /src="\/landing\/fundosmart-community-hero\.webp"/);
  assert.match(landing, /className="object-cover object-center opacity-100 transition-opacity duration-700"/);
  assert.match(landing, /<Hero \/>\s*<InteractiveShowcase \/>\s*<div className="landing-motion-root"/);
});

test("self-hosted Latin fonts are discovered from use instead of being preloaded", async () => {
  const [layout, fonts] = await Promise.all([source("app/layout.tsx"), source("app/fonts.css")]);
  const fontFiles = [
    "geist-98bbbccb.woff2",
    "geist-mono-013b2f2f.woff2",
    "inter-1ab1ad55.woff2",
    "fraunces-8ca9c2a4.woff2",
  ];

  assert.match(layout, /import "\.\/fonts\.css";/);
  assert.doesNotMatch(layout, /next\/font|preload/);
  assert.equal(fonts.match(/@font-face/g)?.length, fontFiles.length);
  assert.equal(fonts.match(/font-display: swap/g)?.length, fontFiles.length);
  for (const fontFile of fontFiles) {
    assert.match(fonts, new RegExp(`url\\("/assets/fonts/${fontFile.replace(".", "\\.")}"\\)`));
  }
  for (const variable of [
    "--font-geist-sans",
    "--font-geist-mono",
    "--font-landing-sans",
    "--font-landing-display",
  ]) {
    assert.match(fonts, new RegExp(`${variable}:`));
  }
});
