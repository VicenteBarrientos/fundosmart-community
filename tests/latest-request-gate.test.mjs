import assert from "node:assert/strict";
import test from "node:test";

import { createLatestRequestGate } from "../src/modules/leche/domain/latest-request-gate.mjs";

test("only the latest out-of-order milk snapshot request can update state", async () => {
  const gate = createLatestRequestGate();
  const state = { snapshot: null, error: null, refreshing: false };

  async function load(label, delay, failure = null) {
    const ticket = gate.begin();
    state.refreshing = true;
    state.error = null;
    try {
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (failure) throw failure;
      if (gate.isCurrent(ticket)) state.snapshot = label;
    } catch (cause) {
      if (gate.isCurrent(ticket)) state.error = cause;
    } finally {
      if (gate.isCurrent(ticket)) state.refreshing = false;
    }
  }

  await Promise.all([
    load("2025-12-31", 30, new Error("stale failure")),
    load("2026-07-21", 1),
  ]);

  assert.deepEqual(state, {
    snapshot: "2026-07-21",
    error: null,
    refreshing: false,
  });
});
