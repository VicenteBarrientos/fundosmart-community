import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import ts from "typescript";
import { normalizeTableText, tableRowMatches } from "../src/ui/table-explorer.mjs";

const root = process.cwd();

function tsxFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.isFile() && entry.name.endsWith(".tsx") ? [path] : [];
  });
}

function tagNameText(tagName) {
  if (ts.isIdentifier(tagName)) return tagName.text;
  return tagName.getText();
}

function jsxAttributeNames(element) {
  return new Set(element.attributes.properties.flatMap((attribute) =>
    ts.isJsxAttribute(attribute) ? [attribute.name.getText()] : []));
}

function jsxStringAttribute(element, name) {
  const attribute = element.attributes.properties.find((candidate) =>
    ts.isJsxAttribute(candidate) && candidate.name.getText() === name);
  return attribute?.initializer && ts.isStringLiteral(attribute.initializer)
    ? attribute.initializer.text
    : null;
}

function collectNativeTables(file) {
  const source = readFileSync(file, "utf8");
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const tables = [];

  function visit(node) {
    if (ts.isJsxElement(node) && tagNameText(node.openingElement.tagName) === "table") {
      tables.push(node);
    }
    ts.forEachChild(node, visit);
  }

  visit(parsed);
  return { parsed, source, tables };
}

test("normaliza búsquedas en español sin depender de tildes, caja o espacios", () => {
  assert.equal(normalizeTableText("  ÚLTIMO   ordeño  "), "ultimo ordeno");
  assert.equal(normalizeTableText("Ñuble / Producción"), "nuble / produccion");
  assert.equal(normalizeTableText(null), "");
});

test("combina búsqueda y filtro de dimensión con semántica AND", () => {
  const row = {
    rowText: "Vaca Lucero · Fundo El Ejemplo · En producción",
    rowFilter: "En producción",
  };

  assert.equal(tableRowMatches({ ...row, query: "lucéro", selectedFilter: "en produccion" }), true);
  assert.equal(tableRowMatches({ ...row, query: "lucero", selectedFilter: "seca" }), false);
  assert.equal(tableRowMatches({ ...row, query: "fundo inexistente", selectedFilter: "" }), false);
  assert.equal(tableRowMatches({ ...row, query: "", selectedFilter: "" }), true);
});

test("las tablas de datos usan el explorador común y el editor de vértices conserva su orden operativo", () => {
  const files = [...tsxFiles(join(root, "app")), ...tsxFiles(join(root, "src"))];
  const findings = files.flatMap((file) => {
    const { tables } = collectNativeTables(file);
    return tables.map((table) => ({ file, table }));
  });
  // El explorador reordena y oculta filas leyendo el DOM: una tabla que además se edita
  // pelearía con él —la fila saltaría de lugar o desaparecería mientras se escribe—, así
  // que los editores declaran su excepción en vez de heredarla.
  const interactiveEditorPaths = new Set([
    "src/modules/potreros/components/map/MapAccessibilityCoordinateEditor.tsx",
    "src/ui/SpreadsheetGrid.tsx",
  ]);
  const pathOf = (file) => relative(root, file).replaceAll("\\", "/");
  const interactiveEditors = findings.filter(({ file }) => interactiveEditorPaths.has(pathOf(file)));
  const dataTables = findings.filter(({ file }) => !interactiveEditorPaths.has(pathOf(file)));

  assert.equal(findings.length, 21, "el inventario de tablas nativas cambió; clasifica cualquier tabla nueva");
  assert.equal(
    interactiveEditors.length,
    interactiveEditorPaths.size,
    "solo los editores declarados pueden omitir el explorador, que reordenaría sus controles",
  );
  assert.equal(dataTables.length, 19, "migra cualquier tabla de datos nueva al explorador común");

  for (const { file, table } of dataTables) {
    const parent = table.parent;
    const path = relative(root, file);
    assert.match(
      jsxStringAttribute(table.openingElement, "className") ?? "",
      /\bmin-w-/u,
      `${path}: la tabla necesita un ancho mínimo para activar el scroll horizontal`,
    );
    assert.equal(ts.isJsxElement(parent), true, `${path}: <table> debe ser hijo directo de <TableExplorer>`);
    if (!ts.isJsxElement(parent)) continue;
    assert.equal(tagNameText(parent.openingElement.tagName), "TableExplorer", `${path}: falta TableExplorer`);
    const attributes = jsxAttributeNames(parent.openingElement);
    assert.equal(attributes.has("id"), true, `${path}: cada tabla necesita una identidad persistente`);
    assert.equal(attributes.has("title"), true, `${path}: cada tabla necesita un título didáctico`);
    assert.equal(attributes.has("description"), true, `${path}: cada tabla necesita contexto`);
    assert.equal(attributes.has("searchPlaceholder"), true, `${path}: cada tabla necesita búsqueda orientada`);
    assert.equal(attributes.has("filter"), true, `${path}: cada tabla necesita una dimensión de filtro`);
  }
});

test("las 25 vistas lógicas tienen identidades estables y únicas", () => {
  const expectedIds = [
    "analitica.historia-propia",
    "analitica.metricas",
    "cooprinsem.preview",
    "costos.movimientos",
    "ganado.agenda.calendario",
    "ganado.animales",
    "ganado.como-vamos.reparto",
    "ganado.forraje.oferta",
    "ganado.terreno.import-preview",
    "importaciones.preview",
    "leche.composicion-pago",
    "leche.liquidaciones",
    "leche.produccion.calidad",
    "leche.produccion.conciliacion",
    "leche.produccion.registros",
    "leche.rebano.inventario",
    "leche.reproduccion.trabajo",
    "leche.sanidad.rcs",
    "leche.sanidad.resguardos",
    "leche.simulador.componentes",
    "leche.simulador.sensibilidad",
    "praderas.feed-wedge",
    "praderas.planificacion-lotes",
    "reportes.comparacion",
    "trazabilidad.diio",
  ];
  const sources = [...tsxFiles(join(root, "app")), ...tsxFiles(join(root, "src"))]
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  const actualIds = [...sources.matchAll(/id="([^"]+)"(?=[^>]*\b(?:title|description|searchPlaceholder)=)/gu)]
    .map((match) => match[1])
    .filter((id) => expectedIds.includes(id))
    .sort();

  assert.deepEqual(actualIds, [...expectedIds].sort());
  assert.equal(new Set(actualIds).size, actualIds.length);
});

test("el contrato visual conserva scroll, cabecera fija, colapso y anuncios accesibles", () => {
  const component = readFileSync(join(root, "src/ui/TableExplorer.tsx"), "utf8");
  const styles = readFileSync(join(root, "app/globals.css"), "utf8");

  assert.match(component, /aria-expanded=\{open\}/u);
  assert.match(component, /inert=\{!open \|\| undefined\}/u);
  assert.match(component, /aria-live="polite"/u);
  assert.match(component, /role="region"/u);
  assert.match(component, /type="search"/u);
  assert.match(component, /No hay coincidencias/u);
  assert.match(styles, /\.table-explorer-scroll\s*\{[^}]*overflow:\s*auto/isu);
  assert.match(styles, /scrollbar-gutter:\s*stable/u);
  assert.doesNotMatch(styles, /\.table-explorer-scroll table\s*\{[^}]*min-width/isu);
  assert.match(styles, /\.table-explorer-scroll thead th\s*\{[^}]*position:\s*sticky/isu);
  assert.match(styles, /::-webkit-scrollbar-thumb/u);
});
