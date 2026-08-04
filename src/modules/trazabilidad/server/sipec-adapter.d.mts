export const SIPEC_ADAPTER_VERSION: "fundosmart.sipec.adapter.v1";

export type SipecAdapterDescription = {
  adapterVersion: typeof SIPEC_ADAPTER_VERSION;
  officialSpecification: null;
  specificationStatus: "pending_official_specification";
  supportedOfficialFormats: string[];
  importEnabled: false;
  exportEnabled: false;
  officiallySubmittable: false;
};

export class SipecAdapterError extends Error {
  code: "SIPEC_ADAPTER_VERSION_UNSUPPORTED" | "SIPEC_SPECIFICATION_UNAVAILABLE";
  details: SipecAdapterDescription & Record<string, unknown>;
}

export function describeSipecAdapter(): SipecAdapterDescription;

export function importSipecFile(input: {
  adapterVersion: string;
  formatVersion?: string | null;
  bytes?: ArrayBuffer | Uint8Array;
  rows?: Array<Record<string, unknown>>;
}): never;

export function exportSipecFile(input: {
  adapterVersion: string;
  formatVersion?: string | null;
  projection: Record<string, unknown>;
}): never;
