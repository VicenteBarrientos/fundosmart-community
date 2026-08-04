export type TraceabilityDbfAnimalIndex = {
  animalIds: Set<string>;
  animalIdsByIdentity: Map<string, Set<string>>;
};

export type TraceabilityDbfAdaptedRow = {
  fila: number;
  id_origen: string;
  diio: string;
  animal_id: string;
  tipo_dispositivo: string;
  rfid: string | null;
  adapter_issue_code: string | null;
  adapter_issue_message: string | null;
};

export function adaptCliexDbfForTraceability(
  input: ArrayBuffer | Uint8Array,
  options: TraceabilityDbfAnimalIndex & { filename: string; maxRows: number },
): {
  rows: TraceabilityDbfAdaptedRow[];
  source: {
    filename: string;
    declaredRows: number;
    parsedRows: number;
    activeRows: number;
    skippedRows: number;
    warnings: string[];
    parser: "cooprinsem-dbf";
  };
};
