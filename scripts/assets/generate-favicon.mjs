import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const root = process.cwd();
const source = await readFile(path.join(root, "public", "fundosmart-ultra-min-favicon.svg"));
const sizes = [16, 32, 48, 64, 128, 256];
const images = await Promise.all(sizes.map((size) => sharp(source, { density: 512 })
  .resize(size, size)
  .png()
  .toBuffer()));

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

const icon = Buffer.concat([directory, ...images]);
await Promise.all([
  writeFile(path.join(root, "public", "favicon.ico"), icon),
  writeFile(path.join(root, "public", "fundosmart-ultra-min-favicon.ico"), icon),
]);
