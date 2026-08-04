import type { AnimalRecord, BirthInput, HealthEventInput, MilkControlInput, RenumberInput, ReproductiveEventInput } from "../domain/types";

export async function fetchAnimalRecord(animalId: string): Promise<AnimalRecord> {
  const response = await fetch(`/api/ganado/ficha?animalId=${encodeURIComponent(animalId)}`, { cache: "no-store" });
  return readRecordResponse(response, "No fue posible abrir la ficha animal.");
}

export async function persistMilkControl(input: MilkControlInput): Promise<AnimalRecord> {
  const response = await fetch("/api/ganado/ficha", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "milk_control", ...input }),
  });
  return readRecordResponse(response, "No fue posible guardar el control lechero.");
}

export async function persistReproductiveEvent(input: ReproductiveEventInput): Promise<AnimalRecord> {
  const response = await fetch("/api/ganado/ficha", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "reproductive_event", ...input }),
  });
  return readRecordResponse(response, "No fue posible guardar el evento reproductivo.");
}

export async function persistBirth(input: BirthInput): Promise<AnimalRecord> {
  const response = await fetch("/api/ganado/ficha", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "birth", ...input }),
  });
  return readRecordResponse(response, "No fue posible guardar el parto.");
}

export async function persistHealthEvent(input: HealthEventInput): Promise<AnimalRecord> {
  const response = await fetch("/api/ganado/ficha", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "health_event", ...input }),
  });
  return readRecordResponse(response, "No fue posible guardar el evento sanitario.");
}

export async function persistRenumber(input: RenumberInput): Promise<AnimalRecord> {
  const response = await fetch("/api/ganado/ficha", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "renumber", ...input }),
  });
  return readRecordResponse(response, "No fue posible cambiar el número del animal.");
}

async function readRecordResponse(response: Response, fallback: string): Promise<AnimalRecord> {
  const body = await response.json() as { error?: string; record?: AnimalRecord };
  if (!response.ok || !body.record) throw new Error(body.error ?? fallback);
  return body.record;
}
