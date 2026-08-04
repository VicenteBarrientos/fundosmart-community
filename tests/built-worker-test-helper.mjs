import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export async function readBuiltWorkerSchema(projectRoot) {
  const assetsDirectory = path.join(projectRoot, "dist", "server", "assets");
  const databaseChunks = (await readdir(assetsDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^db-[a-zA-Z0-9_-]+\.js$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  if (databaseChunks.length === 0) {
    throw new Error("The built Worker does not contain a database schema chunk.");
  }

  return (await Promise.all(
    databaseChunks.map((name) => readFile(path.join(assetsDirectory, name), "utf8")),
  )).join("\n");
}
