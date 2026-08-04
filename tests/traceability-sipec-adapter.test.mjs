import assert from "node:assert/strict";
import test from "node:test";

import {
  describeSipecAdapter,
  exportSipecFile,
  importSipecFile,
  SIPEC_ADAPTER_VERSION,
  SipecAdapterError,
} from "../src/modules/trazabilidad/server/sipec-adapter.mjs";

test("SIPEC adapter publishes a versioned fail-closed boundary without claiming an official format", () => {
  assert.deepEqual(describeSipecAdapter(), {
    adapterVersion: "fundosmart.sipec.adapter.v1",
    officialSpecification: null,
    specificationStatus: "pending_official_specification",
    supportedOfficialFormats: [],
    importEnabled: false,
    exportEnabled: false,
    officiallySubmittable: false,
  });

  for (const operation of [
    () => importSipecFile({ adapterVersion: SIPEC_ADAPTER_VERSION, formatVersion: "unknown", bytes: new Uint8Array([1, 2, 3]) }),
    () => exportSipecFile({ adapterVersion: SIPEC_ADAPTER_VERSION, formatVersion: "unknown", projection: { sensitive: "never serialized" } }),
  ]) {
    assert.throws(operation, (cause) => cause instanceof SipecAdapterError
      && cause.code === "SIPEC_SPECIFICATION_UNAVAILABLE"
      && cause.details.officiallySubmittable === false
      && cause.details.officialSpecification === null);
  }
});

test("SIPEC adapter rejects unrecognized adapter versions before reading a payload", () => {
  assert.throws(
    () => importSipecFile({ adapterVersion: "fundosmart.sipec.adapter.v999", rows: [{ diio: "123456789" }] }),
    (cause) => cause instanceof SipecAdapterError
      && cause.code === "SIPEC_ADAPTER_VERSION_UNSUPPORTED"
      && cause.details.requestedAdapterVersion === "fundosmart.sipec.adapter.v999",
  );
});
