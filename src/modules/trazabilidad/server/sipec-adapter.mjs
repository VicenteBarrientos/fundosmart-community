export const SIPEC_ADAPTER_VERSION = "fundosmart.sipec.adapter.v1";

const DESCRIPTION = Object.freeze({
  adapterVersion: SIPEC_ADAPTER_VERSION,
  officialSpecification: null,
  specificationStatus: "pending_official_specification",
  supportedOfficialFormats: Object.freeze([]),
  importEnabled: false,
  exportEnabled: false,
  officiallySubmittable: false,
});

export class SipecAdapterError extends Error {
  constructor(message, code, details) {
    super(message);
    this.name = "SipecAdapterError";
    this.code = code;
    this.details = details;
  }
}

export function describeSipecAdapter() {
  return {
    ...DESCRIPTION,
    supportedOfficialFormats: [...DESCRIPTION.supportedOfficialFormats],
  };
}

export function importSipecFile(input) {
  assertAdapterVersion(input?.adapterVersion);
  throw specificationUnavailable("import", input?.formatVersion);
}

export function exportSipecFile(input) {
  assertAdapterVersion(input?.adapterVersion);
  throw specificationUnavailable("export", input?.formatVersion);
}

function assertAdapterVersion(value) {
  if (value === SIPEC_ADAPTER_VERSION) return;
  throw new SipecAdapterError(
    "La versión del adaptador SIPEC no está soportada.",
    "SIPEC_ADAPTER_VERSION_UNSUPPORTED",
    { ...describeSipecAdapter(), requestedAdapterVersion: value ?? null },
  );
}

function specificationUnavailable(direction, requestedFormatVersion) {
  return new SipecAdapterError(
    "El formato oficial SIPEC no está confirmado; la operación se bloqueó sin interpretar ni generar un archivo.",
    "SIPEC_SPECIFICATION_UNAVAILABLE",
    {
      ...describeSipecAdapter(),
      direction,
      requestedFormatVersion: requestedFormatVersion ?? null,
    },
  );
}
