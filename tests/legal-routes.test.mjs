import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describeSipecAdapter } from "../src/modules/trazabilidad/server/sipec-adapter.mjs";

const PRIVACY_RELEASE = /Última actualización: 29 de julio de 2026 · Versión 1\.2/;
const TERMS_RELEASE = /Última actualización: 29 de julio de 2026 · Versión 1\.2/;

function readProjectFile(...segments) {
  return fs.readFileSync(path.join(process.cwd(), ...segments), "utf8");
}

function findNamedFunction(sourceFile, name) {
  return sourceFile.statements.find(
    (statement) =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
}

function findDescendants(node, predicate) {
  const matches = [];
  const visit = (child) => {
    if (predicate(child)) {
      matches.push(child);
    }
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return matches;
}

function findJsxAttribute(element, name) {
  return element.attributes.properties.find(
    (property) => ts.isJsxAttribute(property) && property.name.text === name,
  );
}

function visibleJsxText(content, fileName) {
  const sourceFile = ts.createSourceFile(
    fileName,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const fragments = findDescendants(sourceFile, (node) => ts.isJsxText(node))
    .map((node) => node.text)
    .join(" ");
  return fragments.replace(/\s+/g, " ").trim();
}

function mountedLandingCopy(content, fileName) {
  const sourceFile = ts.createSourceFile(
    fileName,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  const functions = new Map();
  const moduleConstants = new Map();
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      functions.set(statement.name.text, statement);
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          moduleConstants.set(declaration.name.text, declaration.initializer);
        }
      }
    }
  }

  const fragments = [];
  const visitedFunctions = new Set();
  const visitedConstants = new Set();

  function localConstantsFor(declaration) {
    const constants = new Map();
    for (const statement of declaration.body?.statements ?? []) {
      if (!ts.isVariableStatement(statement)) {
        continue;
      }
      for (const variable of statement.declarationList.declarations) {
        if (ts.isIdentifier(variable.name) && variable.initializer) {
          constants.set(variable.name.text, variable.initializer);
        }
      }
    }
    return constants;
  }

  function staticBoolean(node) {
    if (node.kind === ts.SyntaxKind.TrueKeyword) {
      return true;
    }
    if (node.kind === ts.SyntaxKind.FalseKeyword) {
      return false;
    }
    return undefined;
  }

  function collectConstant(name, initializer, localConstants, scopeName) {
    const key = `${scopeName}:${name}`;
    if (visitedConstants.has(key)) {
      return;
    }
    visitedConstants.add(key);
    collectNode(initializer, localConstants, scopeName);
  }

  function collectFunction(name) {
    if (visitedFunctions.has(name)) {
      return;
    }
    visitedFunctions.add(name);
    const declaration = functions.get(name);
    assert.ok(declaration?.body, `${name} must have a function body`);
    const returned = declaration.body.statements.find(ts.isReturnStatement);
    assert.ok(returned?.expression, `${name} must directly return rendered JSX`);
    collectNode(returned.expression, localConstantsFor(declaration), name);
  }

  function collectNode(node, localConstants, scopeName) {
    if (
      ts.isJsxText(node) ||
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node)
    ) {
      fragments.push(node.text);
    }

    if (ts.isConditionalExpression(node)) {
      const condition = staticBoolean(node.condition);
      if (condition === true) {
        collectNode(node.whenTrue, localConstants, scopeName);
        return;
      }
      if (condition === false) {
        collectNode(node.whenFalse, localConstants, scopeName);
        return;
      }
    }

    if (ts.isBinaryExpression(node)) {
      const left = staticBoolean(node.left);
      if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        if (left === false) {
          return;
        }
        if (left === true) {
          collectNode(node.right, localConstants, scopeName);
          return;
        }
      }
      if (node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
        if (left === true) {
          return;
        }
        if (left === false) {
          collectNode(node.right, localConstants, scopeName);
          return;
        }
      }
    }

    if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      const componentName = node.tagName.getText(sourceFile);
      if (functions.has(componentName)) {
        collectFunction(componentName);
      }
    }

    if (ts.isIdentifier(node)) {
      const localInitializer = localConstants.get(node.text);
      if (localInitializer) {
        collectConstant(
          node.text,
          localInitializer,
          localConstants,
          scopeName,
        );
      } else {
        const moduleInitializer = moduleConstants.get(node.text);
        if (moduleInitializer) {
          collectConstant(
            node.text,
            moduleInitializer,
            new Map(),
            "module",
          );
        }
      }
    }

    ts.forEachChild(node, (child) =>
      collectNode(child, localConstants, scopeName),
    );
  }

  assert.ok(functions.has("LandingPage"), "LandingPage must remain exported");
  collectFunction("LandingPage");
  return fragments.join(" ").replace(/\s+/g, " ").trim();
}

test("mounted landing copy ignores unreferenced and unreachable strings", () => {
  const copy = mountedLandingCopy(
    `
      const DEAD_MODULE_COPY = "dead module copy";
      function Unmounted() {
        return <p>dead component copy</p>;
      }
      function Mounted() {
        const deadLocalCopy = "dead local copy";
        const liveCopy = "visible mounted copy";
        if (false) {
          return <p>dead branch copy</p>;
        }
        return <p>{liveCopy}</p>;
      }
      export function LandingPage() {
        return <main><Mounted /></main>;
      }
    `,
    "mounted-copy-fixture.tsx",
  );

  assert.equal(copy, "visible mounted copy");
});

test("privacy page exists and contains legal sections", () => {
  const filePath = path.join(process.cwd(), "app", "privacidad", "page.tsx");
  assert.equal(fs.existsSync(filePath), true);
  const content = readProjectFile("app", "privacidad", "page.tsx");
  const visibleText = visibleJsxText(content, "app/privacidad/page.tsx");
  assert.match(visibleText, /Política de Privacidad/);
  assert.match(visibleText, /Protección de Datos/);
  assert.match(visibleText, /Datos que recopilamos/);
  assert.match(visibleText, PRIVACY_RELEASE);
});

test("terms of service page exists and contains legal sections", () => {
  const filePath = path.join(process.cwd(), "app", "terminos", "page.tsx");
  assert.equal(fs.existsSync(filePath), true);
  const content = readProjectFile("app", "terminos", "page.tsx");
  const visibleText = visibleJsxText(content, "app/terminos/page.tsx");
  assert.match(visibleText, /Términos de Servicio/);
  assert.match(visibleText, /Planes y Límites de Uso/);
  assert.match(visibleText, TERMS_RELEASE);
});

test("privacy transparency names active providers and actual retention boundaries", () => {
  const content = readProjectFile("app", "privacidad", "page.tsx");
  const visibleText = visibleJsxText(content, "app/privacidad/page.tsx");

  for (const provider of [
    "Cloudflare",
    "Google OpenID Connect",
    "OpenStreetMap Standard",
    "Esri ArcGIS",
    "Copernicus Data Space Ecosystem (CDSE)",
  ]) {
    assert.match(visibleText, new RegExp(provider.replace(/[()]/g, "\\$&")));
  }
  assert.match(visibleText, /No aplicamos un plazo único a todos los datos/);
  assert.match(
    visibleText,
    /FundoSmart no vende ni comercializa tus datos agrícolas, pecuarios, personales u operacionales/,
  );
  assert.match(
    visibleText,
    /Personas y contrapartes operacionales: nombre, correo, RUT, dirección y patentes/,
  );
  assert.match(
    visibleText,
    /Finanzas y cumplimiento: aportes, egresos, costos, liquidaciones, establecimientos, movimientos y evidencia regulatoria/,
  );
  assert.match(
    visibleText,
    /Feedback y soporte: nombre y correo.+mensaje libre.+user agent.+viewport/,
  );
  assert.match(
    visibleText,
    /Captura offline en el dispositivo: IndexedDB conserva localmente la cola de mutaciones, modelos de lectura, cursores, una sesión offline acotada y adjuntos pendientes/,
  );
  assert.match(
    visibleText,
    /Cloudflare.+si se habilitan alertas.+dirección destinataria y el contenido del recordatorio/,
  );
  assert.match(
    visibleText,
    /OpenStreetMap Standard y Esri ArcGIS.+metadatos de red.+índices de tesela.+área visible/,
  );
  assert.match(
    visibleText,
    /Satélite, Topográfico y Relieve usan Esri/,
  );
  assert.match(
    visibleText,
    /Copernicus Data Space Ecosystem \(CDSE\).+geometría del potrero y el intervalo consultado/,
  );
  assert.match(
    visibleText,
    /Cerrar sesión no elimina de forma global esos datos locales.+no existe un TTL general/,
  );
  assert.match(
    visibleText,
    /Tras una carga exitosa se retira el archivo binario de la foto, pero permanecen sus metadatos/,
  );
  assert.match(
    visibleText,
    /Estos respaldos no equivalen a una exportación completa del espacio/,
  );
  assert.match(
    visibleText,
    /33 secciones D1.+allowlists.+omisiones declaradas.+SHA-256 por sección/,
  );
  assert.match(
    visibleText,
    /No incluye archivos R2 ni todas las categorías de datos personales o tablas clasificadas X2\/X3/,
  );
  assert.match(
    visibleText,
    /SHA-256.+no son una firma ni acreditan autoría/,
  );
  assert.match(
    visibleText,
    /solicitud de cierre de cuenta.+revoca únicamente las sesiones de esa cuenta/,
  );
  assert.match(
    visibleText,
    /solicitud de cierre de espacio.+conserva las sesiones.+otros espacios/,
  );
  assert.match(
    visibleText,
    /gracia de 30 días.+no elimina, anonimiza ni purga datos.+no ejecuta un cierre final automático/,
  );
  assert.match(
    visibleText,
    /versión, fecha de publicación, SHA-256 del contenido exacto, fecha de aceptación, identidad, identificador de solicitud/,
  );
  assert.match(
    visibleText,
    /no constituye un consentimiento general/,
  );
  assert.doesNotMatch(
    visibleText,
    /No vendemos, compartimos ni comercializamos/,
  );
  assert.doesNotMatch(visibleText, /exportación portátil completa/);
});

test("terms describe portable v2 and reversible suspension without promising deletion", () => {
  const content = readProjectFile("app", "terminos", "page.tsx");
  const visibleText = visibleJsxText(content, "app/terminos/page.tsx");

  assert.match(visibleText, /Portabilidad, suspensión y conservación/);
  assert.match(
    visibleText,
    /Estos respaldos no equivalen a una exportación completa del espacio/,
  );
  assert.match(
    visibleText,
    /portable workspace v2 con 33 secciones D1.+No incluye archivos R2/,
  );
  assert.match(
    visibleText,
    /gracia de 30 días.+No se elimina, anonimiza ni purga información.+no existe cierre final automático/,
  );
  assert.match(
    visibleText,
    /Todo cambio de contenido se publica como una nueva versión con su propia huella.+aceptar esa nueva versión/,
  );
  assert.match(
    visibleText,
    /no constituye consentimiento general/,
  );
  assert.doesNotMatch(
    visibleText,
    /puedes descargarlos o cancelar tu cuenta en cualquier momento/,
  );
});

test("public footer exposes direct legal routes without replacing existing resource links", () => {
  const content = readProjectFile("src", "modules", "landing", "LandingPage.tsx");
  const sourceFile = ts.createSourceFile(
    "LandingPage.tsx",
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const landingPage = findNamedFunction(sourceFile, "LandingPage");
  const footer = findNamedFunction(sourceFile, "Footer");
  const footerLinks = findNamedFunction(sourceFile, "FooterLinks");

  assert.ok(landingPage);
  assert.ok(footer);
  assert.ok(footerLinks);
  assert.equal(
    findDescendants(
      landingPage,
      (node) =>
        ts.isJsxSelfClosingElement(node) &&
        node.tagName.getText(sourceFile) === "Footer",
    ).length,
    1,
  );

  const resources = findDescendants(
    footer,
    (node) =>
      ts.isJsxSelfClosingElement(node) &&
      node.tagName.getText(sourceFile) === "FooterLinks" &&
      findJsxAttribute(node, "heading")?.initializer?.text === "Recursos",
  );
  assert.equal(resources.length, 1);

  const linksAttribute = findJsxAttribute(resources[0], "links");
  assert.ok(
    linksAttribute?.initializer &&
      ts.isJsxExpression(linksAttribute.initializer) &&
      linksAttribute.initializer.expression &&
      ts.isArrayLiteralExpression(linksAttribute.initializer.expression),
  );
  const links = new Map(
    linksAttribute.initializer.expression.elements.map((entry) => {
      assert.ok(ts.isArrayLiteralExpression(entry));
      assert.equal(entry.elements.length, 2);
      assert.ok(entry.elements.every(ts.isStringLiteral));
      return [entry.elements[0].text, entry.elements[1].text];
    }),
  );
  assert.equal(links.get("Preguntas"), "#preguntas");
  assert.equal(links.get("Contacto"), "#contacto");
  assert.equal(links.get("Privacidad"), "/privacidad");
  assert.equal(links.get("Términos"), "/terminos");

  const anchors = findDescendants(
    footerLinks,
    (node) =>
      ts.isJsxElement(node) &&
      node.openingElement.tagName.getText(sourceFile) === "a",
  );
  assert.equal(anchors.length, 1);
  const hrefAttribute = findJsxAttribute(anchors[0].openingElement, "href");
  assert.equal(hrefAttribute?.initializer?.expression?.text, "href");
  assert.equal(
    anchors[0].children.some(
      (child) =>
        ts.isJsxExpression(child) && child.expression?.text === "label",
    ),
    true,
  );
});

test("public landing matches the fail-closed SAG, SIPEC and portable contracts", () => {
  const adapter = describeSipecAdapter();
  assert.equal(adapter.officialSpecification, null);
  assert.deepEqual(adapter.supportedOfficialFormats, []);
  assert.equal(adapter.importEnabled, false);
  assert.equal(adapter.exportEnabled, false);
  assert.equal(adapter.officiallySubmittable, false);

  const content = readProjectFile("src", "modules", "landing", "LandingPage.tsx");
  const publicCopy = mountedLandingCopy(
    content,
    "src/modules/landing/LandingPage.tsx",
  );

  for (const unsupportedClaim of [
    /exportaciones oficiales compatibles con SAG\/SIPEC/i,
    /FMA SAG Ok/i,
    /SIPEC Validado/i,
    /Trazabilidad SAG & DIIO/i,
    /Trazabilidad DIIO & SAG/i,
    /trazabilidad total/i,
    /100% tuya/i,
  ]) {
    assert.doesNotMatch(publicCopy, unsupportedClaim);
  }

  assert.match(publicCopy, /Trazabilidad interna & DIIO/);
  assert.match(publicCopy, /FMA interno/);
  assert.match(publicCopy, /Formato SIPEC pendiente/);
  assert.match(
    publicCopy,
    /documentos internos de apoyo.+importación, el formato de exportación y el envío oficial SAG\/SIPEC siguen pendientes/i,
  );
  const sipecImportStatements = publicCopy
    .split(/[.!?]/)
    .filter(
      (statement) =>
        /\bSIPEC\b/i.test(statement) &&
        /\b(?:importación|importaciones|importar|importa)\b/i.test(statement),
    );
  assert.ok(sipecImportStatements.length > 0);
  for (const statement of sipecImportStatements) {
    assert.match(statement, /\bpendiente(?:s)?\b/i);
  }
  assert.match(
    publicCopy,
    /Tu organización controla el acceso a sus datos/,
  );
  assert.match(
    publicCopy,
    /Respaldo portable v1 por fundo o importación, con manifiesto de inclusiones y exclusiones/,
  );
  assert.match(
    publicCopy,
    /Portable workspace v2 para owner\/admin con 33 secciones D1/,
  );
  assert.match(publicCopy, /Mapas satelitales de potreros/);
});
