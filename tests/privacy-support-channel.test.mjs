import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const SUPPORT_ADDRESS = "soporte@fundosmart.com";
const SUPPORT_SUBJECT = "Solicitud de privacidad FundoSmart";

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

test("privacy page exposes a visible data-free support mailto", () => {
  const filePath = path.join(process.cwd(), "app", "privacidad", "page.tsx");
  const content = fs.readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(
    "page.tsx",
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  const supportLinks = findDescendants(
    sourceFile,
    (node) =>
      ts.isJsxElement(node) &&
      node.openingElement.tagName.getText(sourceFile) === "a" &&
      findJsxAttribute(node.openingElement, "href")?.initializer?.text?.startsWith(
        `mailto:${SUPPORT_ADDRESS}`,
      ),
  );
  assert.equal(supportLinks.length, 1);

  const supportLink = supportLinks[0];
  const href = findJsxAttribute(supportLink.openingElement, "href").initializer.text;
  const mailto = new URL(href);

  assert.equal(mailto.protocol, "mailto:");
  assert.equal(mailto.pathname, SUPPORT_ADDRESS);
  assert.deepEqual([...mailto.searchParams], [["subject", SUPPORT_SUBJECT]]);
  assert.equal(mailto.searchParams.has("body"), false);
  assert.equal(
    supportLink.children.some(
      (child) => ts.isJsxText(child) && child.text.trim() === SUPPORT_ADDRESS,
    ),
    true,
  );
});
