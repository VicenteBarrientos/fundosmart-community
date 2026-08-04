import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const root = process.cwd();

const socialSourcePath = path.join(root, "assets", "brand", "fundosmart-community-hero-source.png");
const publicDir = path.join(root, "public");

const MARK_SIZE = 512;
const LOCKUP_WIDTH = 1024;
const LOCKUP_HEIGHT = 276;

const BRAND_BLACK = "#050505";
const BRAND_PREFIX = "fundosmart-ultra-min";

async function extractMark() {
  const svg = `<svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
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
  </svg>`;

  return sharp(Buffer.from(svg), { density: 300 })
    .resize(MARK_SIZE, MARK_SIZE, { kernel: sharp.kernel.lanczos3 })
    .png({ adaptiveFiltering: true, compressionLevel: 9 })
    .toBuffer();
}

function imageDataUri(buffer) {
  return `data:image/png;base64,${buffer.toString("base64")}`;
}

function markSvg(markDataUri) {
  return `<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <title>FundoSmart</title>
  <image width="512" height="512" href="${markDataUri}"/>
</svg>
`;
}

function faviconSvg(markDataUri) {
  return `<svg width="512" height="512" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <title>FundoSmart</title>
  <rect width="512" height="512" rx="72" fill="${BRAND_BLACK}"/>
  <image width="512" height="512" href="${markDataUri}"/>
</svg>
`;
}

function lockupSvg(markDataUri, textColor) {
  return `<svg width="${LOCKUP_WIDTH}" height="${LOCKUP_HEIGHT}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${LOCKUP_WIDTH} ${LOCKUP_HEIGHT}">
  <title>FundoSmart</title>
  <rect width="276" height="276" rx="36" fill="${BRAND_BLACK}"/>
  <image width="276" height="276" href="${markDataUri}"/>
  <text x="324" y="181" fill="${textColor}" font-family="Arial, Helvetica, sans-serif" font-size="126" letter-spacing="-5"><tspan font-weight="700">Fundo</tspan><tspan font-weight="400">Smart</tspan></text>
</svg>
`;
}

async function squareIcon(markPng, size, markSize) {
  const resizedMark = await sharp(markPng)
    .resize(markSize, markSize, { kernel: sharp.kernel.lanczos3 })
    .png()
    .toBuffer();
  const inset = Math.round((size - markSize) / 2);

  return sharp({
    create: {
      background: BRAND_BLACK,
      channels: 4,
      height: size,
      width: size,
    },
  })
    .composite([{ input: resizedMark, left: inset, top: inset }])
    .png({ adaptiveFiltering: true, compressionLevel: 9 })
    .toBuffer();
}

async function updateSocialPreview(inverseLockup) {
  const background = await sharp(socialSourcePath)
    .resize(1200, 630, { fit: "cover", position: "centre" })
    .png()
    .toBuffer();
  const renderedLockup = await sharp(Buffer.from(inverseLockup), { density: 288 })
    .resize({ width: 420 })
    .png()
    .toBuffer();

  await sharp(background)
    .composite([{ input: renderedLockup, left: 110, top: 112 }])
    .png({ adaptiveFiltering: true, compressionLevel: 9 })
    .toFile(path.join(publicDir, "og.png"));
}

const markPng = await extractMark();
const markDataUri = imageDataUri(markPng);
const normalLockup = lockupSvg(markDataUri, "#0A0A0A");
const inverseLockup = lockupSvg(markDataUri, "#F8FAFC");
const appleTouchIcon = await squareIcon(markPng, 180, 160);
const appIcon192 = await squareIcon(markPng, 192, 168);
const appIcon512 = await squareIcon(markPng, 512, 448);
const maskableIcon = await squareIcon(markPng, 512, 420);

await Promise.all([
  writeFile(path.join(publicDir, `${BRAND_PREFIX}-mark.png`), markPng),
  writeFile(path.join(publicDir, `${BRAND_PREFIX}-mark.svg`), markSvg(markDataUri)),
  writeFile(path.join(publicDir, `${BRAND_PREFIX}-favicon.svg`), faviconSvg(markDataUri)),
  writeFile(path.join(publicDir, `${BRAND_PREFIX}-logo.svg`), normalLockup),
  writeFile(path.join(publicDir, `${BRAND_PREFIX}-logo-inverse.svg`), inverseLockup),
  writeFile(path.join(publicDir, `${BRAND_PREFIX}-apple-touch-icon.png`), appleTouchIcon),
  writeFile(path.join(publicDir, `${BRAND_PREFIX}-app-icon-192.png`), appIcon192),
  writeFile(path.join(publicDir, `${BRAND_PREFIX}-app-icon-512.png`), appIcon512),
  writeFile(path.join(publicDir, `${BRAND_PREFIX}-app-icon-maskable-512.png`), maskableIcon),
  // Conventional fallbacks also contain the current mark, but product code uses
  // the versioned paths above so browser and operating-system caches cannot drift.
  writeFile(path.join(publicDir, "favicon.svg"), faviconSvg(markDataUri)),
  writeFile(path.join(publicDir, "apple-touch-icon.png"), appleTouchIcon),
  updateSocialPreview(inverseLockup),
]);

for (const file of [
  `${BRAND_PREFIX}-mark.png`,
  `${BRAND_PREFIX}-mark.svg`,
  `${BRAND_PREFIX}-favicon.svg`,
  `${BRAND_PREFIX}-logo.svg`,
  `${BRAND_PREFIX}-logo-inverse.svg`,
  `${BRAND_PREFIX}-apple-touch-icon.png`,
  `${BRAND_PREFIX}-app-icon-192.png`,
  `${BRAND_PREFIX}-app-icon-512.png`,
  `${BRAND_PREFIX}-app-icon-maskable-512.png`,
  "favicon.svg",
  "apple-touch-icon.png",
  "og.png",
]) {
  const bytes = (await readFile(path.join(publicDir, file))).byteLength;
  console.log(`${file}: ${bytes} bytes`);
}
