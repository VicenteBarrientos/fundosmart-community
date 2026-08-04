import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import { isValidChileanRut, normalizeRut } from "../src/modules/ganado/sag/sag-export-rules.mjs";

/**
 * El repositorio no versiona datos personales. Los datos de personas reales
 * —correos, RUT— entran por la aplicación y viven en D1, nunca en el árbol de
 * código, en el seed de arranque ni en los tests.
 *
 * Este contrato impide que fixtures, migraciones o documentación incorporen
 * identidades y registros operativos que pertenezcan a una persona real.
 */

const root = process.cwd();
const SCANNED = ["app", "docs", "src", "worker", "db", "drizzle", "scripts", "tests"];
const SCANNED_EXTENSIONS = /\.(?:ts|tsx|mts|mjs|js|jsx|sql|json|csv|md)$/;

/** Proveedores de correo personal: nunca deben aparecer en el árbol. */
const PERSONAL_MAIL_DOMAINS = [
  "gmail.com",
  "googlemail.com",
  "hotmail.com",
  "hotmail.cl",
  "outlook.com",
  "outlook.cl",
  "live.cl",
  "live.com",
  "yahoo.com",
  "yahoo.cl",
  "icloud.com",
  "me.com",
  "protonmail.com",
  "proton.me",
];

// The public tree has no exceptions: bootstrap identities are synthetic and
// the real owner enters exclusively through FUNDOSMART_OWNER_EMAIL at runtime.
const MAX_PENDING_OWNERSHIP_BOOTSTRAP_FILES = 0;
const PENDING_OWNERSHIP_BOOTSTRAP = new Set();

/**
 * RUT sintéticos documentados: secuencias evidentes usadas como muestra en
 * pruebas y como titular ficticio de la demo. Agregar uno nuevo aquí exige que
 * sea igual de evidente; un RUT plausible es, por definición, el de alguien.
 */
const SYNTHETIC_RUTS = new Set(
  [
    "12.345.678-5",
    "9.876.543-3",
    "11.111.111-1",
    "76.543.210-3",
    "00.000.000-0",
  ].map((rut) => normalizeRut(rut)),
);

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const RUT_PATTERN = /\b(?:\d{1,2}(?:\.\d{3}){2}|\d{7,8})-[\dkK]\b/g;

test("no personal e-mail addresses are versioned in the repository", async () => {
  const offenders = [];
  for (const { relative, contents } of await readScannedFiles()) {
    if (PENDING_OWNERSHIP_BOOTSTRAP.has(relative)) continue;
    for (const address of contents.match(EMAIL_PATTERN) ?? []) {
      const domain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
      if (PERSONAL_MAIL_DOMAINS.includes(domain)) offenders.push(`${relative}: ${address}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("no real Chilean RUT is versioned in the repository", async () => {
  const offenders = [];
  for (const { relative, contents } of await readScannedFiles()) {
    for (const candidate of contents.match(RUT_PATTERN) ?? []) {
      const normalized = normalizeRut(candidate);
      if (!isValidChileanRut(normalized)) continue;
      if (SYNTHETIC_RUTS.has(normalized)) continue;
      offenders.push(`${relative}: ${candidate}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("the pending ownership bootstrap debt does not grow", async () => {
  assert.ok(
    PENDING_OWNERSHIP_BOOTSTRAP.size <= MAX_PENDING_OWNERSHIP_BOOTSTRAP_FILES,
    `la deuda de correos personales sólo puede bajar de ${MAX_PENDING_OWNERSHIP_BOOTSTRAP_FILES} archivos`,
  );
  const scanned = await readScannedFiles();
  const known = new Set(scanned.map((file) => file.relative));
  const stale = [...PENDING_OWNERSHIP_BOOTSTRAP].filter((relative) => !known.has(relative));
  assert.deepEqual(stale, [], "hay archivos en la lista de deuda que ya no existen: bórralos de la lista");

  const carriesPersonalMail = new Set(
    scanned
      .filter(({ contents }) =>
        (contents.match(EMAIL_PATTERN) ?? []).some((address) =>
          PERSONAL_MAIL_DOMAINS.includes(address.slice(address.lastIndexOf("@") + 1).toLowerCase()),
        ),
      )
      .map((file) => file.relative),
  );
  const resolved = [...PENDING_OWNERSHIP_BOOTSTRAP].filter((relative) => !carriesPersonalMail.has(relative));
  assert.deepEqual(resolved, [], "estos archivos ya no tienen correos personales: sácalos de la lista de deuda");
});

let scannedFiles;

async function readScannedFiles() {
  if (scannedFiles) return scannedFiles;
  const files = [];
  const pending = SCANNED.map((directory) => path.join(root, directory));
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolute);
        continue;
      }
      if (!SCANNED_EXTENSIONS.test(entry.name)) continue;
      files.push({
        relative: path.relative(root, absolute).replaceAll("\\", "/"),
        contents: await readFile(absolute, "utf8"),
      });
    }
  }
  scannedFiles = files.sort((left, right) => left.relative.localeCompare(right.relative));
  return scannedFiles;
}
