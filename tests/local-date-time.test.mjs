import assert from "node:assert/strict";
import test from "node:test";

import {
  isoInstantToLocalDateTimeInput,
  localDateTimeInputToIso,
} from "../src/modules/leche/domain/local-date-time.mjs";

process.env.TZ = "America/Santiago";

test("settlement generation instants round-trip through Chilean local time", () => {
  for (const [instant, expectedInput] of [
    ["2026-07-01T14:00:00.000Z", "2026-07-01T10:00"],
    ["2026-01-15T13:00:00.000Z", "2026-01-15T10:00"],
    ["2026-07-01T02:30:45.123Z", "2026-06-30T22:30:45.123"],
  ]) {
    const input = isoInstantToLocalDateTimeInput(instant);
    assert.equal(input, expectedInput);
    assert.equal(localDateTimeInputToIso(input), instant);
  }
});

test("empty settlement generation dates remain empty and invalid input fails", () => {
  assert.equal(isoInstantToLocalDateTimeInput(null), "");
  assert.equal(isoInstantToLocalDateTimeInput("invalid"), "");
  assert.equal(localDateTimeInputToIso(""), null);
  assert.throws(
    () => localDateTimeInputToIso("invalid"),
    /fecha de generación no es válida/,
  );
});
