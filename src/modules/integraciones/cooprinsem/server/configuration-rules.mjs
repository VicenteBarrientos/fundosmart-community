import { normalizeExternalIdentifier } from "./projection-rules.mjs";

export function normalizeCooprinsemGroupCode(value) {
  return normalizeExternalIdentifier(value);
}

export function resolveGenealogyCandidate(input) {
  const matchesByAnimal = new Map();
  for (const match of input.matches ?? []) {
    if (!match?.animalId) continue;
    const current = matchesByAnimal.get(match.animalId) ?? {
      animalId: match.animalId,
      tag: match.tag ?? match.animalId,
      sex: match.sex ?? "unknown",
      birthDate: match.birthDate ?? null,
      matchedBy: [],
    };
    current.matchedBy = [...new Set([...current.matchedBy, ...(match.matchedBy ?? [])])];
    matchesByAnimal.set(match.animalId, current);
  }
  const matches = [...matchesByAnimal.values()].sort((left, right) => left.tag.localeCompare(right.tag, "es"));
  if (matches.length === 0) {
    return { status: "unmatched", candidateAnimalId: null, candidateTag: null, matchedBy: [], issues: ["Todavía no existe un animal con este identificador en el fundo."] };
  }
  if (matches.length > 1) {
    return { status: "conflict", candidateAnimalId: null, candidateTag: null, matchedBy: [], issues: [`El identificador coincide con ${matches.length} animales y requiere revisión.`] };
  }
  const candidate = matches[0];
  const issues = [];
  if (candidate.animalId === input.damAnimalId) issues.push("La cría no puede enlazarse con la misma madre.");
  if (input.sex !== "unknown" && candidate.sex !== "unknown" && input.sex !== candidate.sex) issues.push("El sexo del animal no coincide con el registro de la cría.");
  if (candidate.birthDate && input.occurredAt && candidate.birthDate !== input.occurredAt) issues.push("La fecha de nacimiento del animal no coincide con la fecha del parto.");
  return {
    status: issues.length > 0 ? "conflict" : "ready",
    candidateAnimalId: candidate.animalId,
    candidateTag: candidate.tag,
    matchedBy: candidate.matchedBy,
    issues,
  };
}

export function markDuplicateGenealogyCandidates(rows) {
  const readyByAnimal = new Map();
  for (const row of rows) {
    if (row.status !== "ready" || !row.candidateAnimalId) continue;
    readyByAnimal.set(row.candidateAnimalId, [...(readyByAnimal.get(row.candidateAnimalId) ?? []), row.offspringId]);
  }
  return rows.map((row) => {
    const duplicates = row.candidateAnimalId ? readyByAnimal.get(row.candidateAnimalId) ?? [] : [];
    if (row.status !== "ready" || duplicates.length <= 1) return row;
    return {
      ...row,
      status: "conflict",
      issues: [`El mismo animal coincide con ${duplicates.length} registros de cría pendientes.`],
    };
  });
}

export async function buildConfirmationToken(namespace, payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${namespace}:${hex}`;
}
