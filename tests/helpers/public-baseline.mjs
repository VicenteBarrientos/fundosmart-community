import { readFileSync } from "node:fs";

const schema = readFileSync(new URL("../../drizzle/0000_public_schema.sql", import.meta.url), "utf8");
const invariants = readFileSync(new URL("../../drizzle/0001_public_invariants.sql", import.meta.url), "utf8");

const splitStatements = (source) => source
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter(Boolean);

export function publicSqlForTables(tableNames, { includeInvariants = true } = {}) {
  const tables = new Set(tableNames);
  const schemaStatements = splitStatements(schema).filter((statement) => {
    const table = statement.match(/^CREATE TABLE `([^`]+)`/u)?.[1];
    if (table) return tables.has(table);
    const indexedTable = statement.match(/^CREATE (?:UNIQUE )?INDEX `[^`]+` ON `([^`]+)`/u)?.[1];
    return indexedTable ? tables.has(indexedTable) : false;
  });
  const invariantStatements = includeInvariants
    ? splitStatements(invariants).filter((statement) => {
        const table = statement.match(/^CREATE TRIGGER `[^`]+`[\s\S]+? ON `([^`]+)`/u)?.[1];
        return table ? tables.has(table) : false;
      })
    : [];

  if (schemaStatements.length === 0) {
    throw new Error(`No public schema statements found for: ${[...tables].join(", ")}`);
  }
  return [...schemaStatements, ...invariantStatements].join("\n");
}
