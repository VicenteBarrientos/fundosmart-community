import { writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const root = process.cwd();
const publicDir = path.join(root, "public");
const BRAND_BLACK = "#050505";
const BRAND_PREFIX = "fundosmart-ultra-min";

// Vector SVG for Cow Face (Image 1)
function cowFaceSvg(fillBackground = true) {
  const bg = fillBackground ? `<rect width="512" height="512" rx="72" fill="${BRAND_BLACK}"/>` : "";
  return `<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <title>FundoSmart</title>
  ${bg}
  <g fill="none" stroke="#FFFFFF" stroke-width="18" stroke-linecap="round" stroke-linejoin="round">
    <path d="M 212 128 L 300 128 L 352 184 M 160 184 L 212 128" />
    <path d="M 160 184 L 198 328" />
    <path d="M 352 184 L 314 328" />
    <path d="M 160 184 L 212 220 L 212 312" />
    <path d="M 352 184 L 300 220 L 300 312" />
    <path d="M 212 312 L 300 312 M 212 312 C 196 320, 192 336, 204 354 L 232 378 C 244 388, 268 388, 280 378 L 308 354 C 320 336, 316 320, 300 312" />
    <path d="M 160 184 C 120 156, 80 162, 64 180 C 80 216, 128 234, 168 226" />
    <path d="M 352 184 C 392 156, 432 162, 448 180 C 432 216, 384 234, 344 226" />
  </g>
</svg>
`;
}

// Vector SVG for Cow Shield (Image 2)
function cowShieldSvg(fillBackground = false, strokeColor = "#FFFFFF") {
  const bg = fillBackground ? `<rect width="512" height="512" rx="72" fill="${BRAND_BLACK}"/>` : "";
  return `<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <title>FundoSmart Shield</title>
  ${bg}
  <g fill="none" stroke="${strokeColor}" stroke-width="18" stroke-linecap="round" stroke-linejoin="round">
    <path d="M 256 68 L 408 136 C 424 280, 392 384, 256 444 C 120 384, 88 280, 104 136 Z" />
    <path d="M 186 206 L 224 164 L 288 164 L 326 206" />
    <path d="M 186 206 L 214 314" />
    <path d="M 326 206 L 298 314" />
    <path d="M 186 206 L 224 232 L 224 302" />
    <path d="M 326 206 L 288 232 L 288 302" />
    <path d="M 224 302 L 288 302 M 224 302 C 210 308, 206 322, 216 338 L 238 358 C 248 366, 264 366, 274 358 L 296 338 C 306 322, 302 308, 288 302" />
    <path d="M 186 206 C 154 184, 120 188, 108 202 C 120 230, 160 244, 192 238" />
    <path d="M 326 206 C 358 184, 392 188, 404 202 C 392 230, 352 244, 320 238" />
  </g>
</svg>
`;
}

// Convert SVG string to PNG Buffer at specified size
async function svgToPngBuffer(svgString, size) {
  return sharp(Buffer.from(svgString), { density: 300 })
    .resize(size, size)
    .png()
    .toBuffer();
}

// Build ICO file buffer with multiple icon sizes
async function buildIco(svgString) {
  const sizes = [16, 32, 48, 64, 128, 256];
  const images = await Promise.all(
    sizes.map((size) => svgToPngBuffer(svgString, size))
  );

  const directory = Buffer.alloc(6 + images.length * 16);
  directory.writeUInt16LE(0, 0);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(images.length, 4);
  let offset = directory.length;

  for (const [index, image] of images.entries()) {
    const entry = 6 + index * 16;
    const size = sizes[index];
    directory.writeUInt8(size === 256 ? 0 : size, entry);
    directory.writeUInt8(size === 256 ? 0 : size, entry + 1);
    directory.writeUInt8(0, entry + 2);
    directory.writeUInt8(0, entry + 3);
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(image.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += image.length;
  }

  return Buffer.concat([directory, ...images]);
}

async function run() {
  const faceSvgWithBg = cowFaceSvg(true);
  const faceSvgTransparent = cowFaceSvg(false);
  const shieldSvg = cowShieldSvg(false);

  const icoBuffer = await buildIco(faceSvgWithBg);
  const markPng = await svgToPngBuffer(faceSvgWithBg, 512);
  const appleTouchPng = await svgToPngBuffer(faceSvgWithBg, 180);
  const appIcon192Png = await svgToPngBuffer(faceSvgWithBg, 192);
  const appIcon512Png = await svgToPngBuffer(faceSvgWithBg, 512);

  // Save all brand assets
  await Promise.all([
    // Favicons & Marks
    writeFile(path.join(publicDir, "favicon.svg"), faceSvgWithBg),
    writeFile(path.join(publicDir, "favicon.ico"), icoBuffer),
    writeFile(path.join(publicDir, `${BRAND_PREFIX}-favicon.svg`), faceSvgWithBg),
    writeFile(path.join(publicDir, `${BRAND_PREFIX}-favicon.ico`), icoBuffer),
    writeFile(path.join(publicDir, `${BRAND_PREFIX}-mark.svg`), faceSvgTransparent),
    writeFile(path.join(publicDir, `${BRAND_PREFIX}-mark.png`), markPng),
    writeFile(path.join(publicDir, "apple-touch-icon.png"), appleTouchPng),
    writeFile(path.join(publicDir, `${BRAND_PREFIX}-apple-touch-icon.png`), appleTouchPng),
    writeFile(path.join(publicDir, `${BRAND_PREFIX}-app-icon-192.png`), appIcon192Png),
    writeFile(path.join(publicDir, `${BRAND_PREFIX}-app-icon-512.png`), appIcon512Png),
    writeFile(path.join(publicDir, `${BRAND_PREFIX}-app-icon-maskable-512.png`), appIcon512Png),

    // Shield Asset
    writeFile(path.join(publicDir, "fundosmart-shield.svg"), shieldSvg),
    writeFile(path.join(publicDir, `${BRAND_PREFIX}-shield.svg`), shieldSvg),
  ]);

  console.log("Successfully generated all new brand assets with Cow Face & Shield!");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
