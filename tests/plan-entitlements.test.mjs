import assert from "node:assert/strict";
import test from "node:test";
import {
  getPlanDefinition,
  PLAN_CATALOG,
  PLAN_CATALOG_VERSION,
  PLAN_KEYS,
  PLAN_RESOURCE_KEYS,
  resolvePlanDefinition,
} from "../src/modules/plan/catalog.mjs";
import { evaluateResourceEntitlement } from "../src/modules/plan/entitlements.mjs";

test("catalog preserves commercial values, direct shape, and deep immutability", () => {
  assert.equal(PLAN_CATALOG_VERSION, "fundosmart.plan-catalog.v1");
  assert.deepEqual(Object.keys(PLAN_CATALOG), ["free", "pro", "legacy"]);
  assert.deepEqual(PLAN_KEYS, ["free", "pro", "legacy"]);
  assert.deepEqual(PLAN_RESOURCE_KEYS, [
    "fieldsMax",
    "paddocksMax",
    "membersMax",
    "monthlyExportsMax",
    "ndviEnabled",
  ]);
  assert.deepEqual(PLAN_CATALOG.free, {
    key: "free",
    name: "Plan Gratis",
    description: "Cuenta personal de autoservicio para pequeños productores y evaluación.",
    priceClpMonthly: 0,
    quotas: {
      fieldsMax: 2,
      paddocksMax: 200,
      membersMax: 5,
      monthlyExportsMax: 10,
      ndviEnabled: false,
    },
  });
  assert.deepEqual(PLAN_CATALOG.pro.quotas, {
    fieldsMax: null,
    paddocksMax: 2000,
    membersMax: null,
    monthlyExportsMax: null,
    ndviEnabled: true,
  });
  assert.equal(PLAN_CATALOG.pro.priceClpMonthly, 49_000);
  assert.equal(PLAN_CATALOG.legacy.priceClpMonthly, null);
  assert.deepEqual(PLAN_CATALOG.legacy.quotas, {
    fieldsMax: null,
    paddocksMax: null,
    membersMax: null,
    monthlyExportsMax: null,
    ndviEnabled: true,
  });

  assert.equal(Object.isFrozen(PLAN_CATALOG), true);
  assert.equal(Object.isFrozen(PLAN_KEYS), true);
  assert.equal(Object.isFrozen(PLAN_RESOURCE_KEYS), true);
  for (const plan of Object.values(PLAN_CATALOG)) {
    assert.equal(Object.isFrozen(plan), true);
    assert.equal(Object.isFrozen(plan.quotas), true);
  }
  assert.throws(() => {
    PLAN_CATALOG.free.quotas.paddocksMax = 999;
  }, TypeError);
});

test("compatibility lookup remains presentational while strict resolution never falls back", () => {
  assert.equal(getPlanDefinition(" PRO "), PLAN_CATALOG.pro);
  assert.equal(getPlanDefinition("unknown"), PLAN_CATALOG.free);
  assert.equal(getPlanDefinition("__proto__"), PLAN_CATALOG.free);
  assert.equal(getPlanDefinition("constructor"), PLAN_CATALOG.free);
  assert.equal(getPlanDefinition("toString"), PLAN_CATALOG.free);
  assert.equal(getPlanDefinition(null), PLAN_CATALOG.free);

  assert.equal(resolvePlanDefinition("free"), PLAN_CATALOG.free);
  assert.equal(resolvePlanDefinition("PRO"), null);
  assert.equal(resolvePlanDefinition(" unknown "), null);
  assert.equal(resolvePlanDefinition("__proto__"), null);
  assert.equal(resolvePlanDefinition("constructor"), null);
  assert.equal(resolvePlanDefinition("toString"), null);
  assert.equal(resolvePlanDefinition(null), null);
});

test("numeric entitlements use exact 70, 90, and hard-limit boundaries", () => {
  const at139 = paddockEvaluation(139);
  assert.deepEqual(
    [at139.valid, at139.allowed, at139.percentage, at139.noticeLevel],
    [true, true, 69, "none"],
  );

  const at140 = paddockEvaluation(140);
  assert.deepEqual(
    [at140.allowed, at140.percentage, at140.noticeLevel],
    [true, 70, "warning_70"],
  );

  const at179 = paddockEvaluation(179);
  assert.deepEqual(
    [at179.allowed, at179.percentage, at179.noticeLevel],
    [true, 89, "warning_70"],
  );

  const at180 = paddockEvaluation(180);
  assert.deepEqual(
    [at180.allowed, at180.percentage, at180.noticeLevel],
    [true, 90, "warning_90"],
  );

  const at200 = paddockEvaluation(200);
  assert.deepEqual(
    [at200.allowed, at200.percentage, at200.noticeLevel],
    [false, 100, "limit_reached"],
  );

  const over = paddockEvaluation(201);
  assert.deepEqual(
    [over.allowed, over.percentage, over.noticeLevel],
    [false, 100, "limit_reached"],
  );
});

test("unlimited and boolean resources remain explicit and frozen", () => {
  const unlimited = evaluateResourceEntitlement({
    planKey: "pro",
    resourceKey: "fieldsMax",
    currentUsage: Number.MAX_SAFE_INTEGER,
  });
  assert.deepEqual(
    [unlimited.valid, unlimited.allowed, unlimited.limit, unlimited.percentage],
    [true, true, null, 0],
  );

  const disabled = evaluateResourceEntitlement({
    planKey: "free",
    resourceKey: "ndviEnabled",
    currentUsage: 0,
  });
  assert.deepEqual(
    [disabled.allowed, disabled.limit, disabled.percentage, disabled.noticeLevel],
    [false, null, 100, "limit_reached"],
  );

  const enabled = evaluateResourceEntitlement({
    planKey: "pro",
    resourceKey: "ndviEnabled",
    currentUsage: 0,
  });
  assert.deepEqual(
    [enabled.allowed, enabled.percentage, enabled.noticeLevel],
    [true, 0, "none"],
  );
  assert.equal(Object.isFrozen(unlimited), true);
  assert.equal(Object.isFrozen(disabled), true);
  assert.equal(Object.isFrozen(enabled), true);

  for (const currentUsage of [1, Number.MAX_SAFE_INTEGER]) {
    const invalidFeatureUsage = evaluateResourceEntitlement({
      planKey: "pro",
      resourceKey: "ndviEnabled",
      currentUsage,
    });
    assert.equal(invalidFeatureUsage.valid, false);
    assert.equal(invalidFeatureUsage.allowed, false);
    assert.equal(
      invalidFeatureUsage.reasonCode,
      "FEATURE_USAGE_INVALID",
    );
  }
});

test("unknown or malformed entitlement input denies deterministically without NaN or leakage", () => {
  const sentinel = "private.person@example.com";
  const invalidInputs = [
    {
      planKey: sentinel,
      resourceKey: "paddocksMax",
      currentUsage: 0,
    },
    {
      planKey: "free",
      resourceKey: sentinel,
      currentUsage: 0,
    },
    {
      planKey: "free",
      resourceKey: "paddocksMax",
      currentUsage: -1,
    },
    {
      planKey: "free",
      resourceKey: "paddocksMax",
      currentUsage: -0,
    },
    {
      planKey: "free",
      resourceKey: "paddocksMax",
      currentUsage: 1.5,
    },
    {
      planKey: "free",
      resourceKey: "paddocksMax",
      currentUsage: Number.NaN,
    },
    {
      planKey: "free",
      resourceKey: "paddocksMax",
      currentUsage: Number.POSITIVE_INFINITY,
    },
    {
      planKey: "free",
      resourceKey: "paddocksMax",
      currentUsage: "0",
    },
    {
      planKey: "free",
      resourceKey: "paddocksMax",
    },
    {
      planKey: "free",
      resourceKey: "paddocksMax",
      currentUsage: 0,
      extra: true,
    },
    Object.assign(Object.create(null), {
      planKey: "free",
      resourceKey: "paddocksMax",
      currentUsage: 0,
    }),
  ];

  for (const input of invalidInputs) {
    const result = evaluateResourceEntitlement(input);
    assert.equal(result.valid, false);
    assert.equal(result.allowed, false);
    assert.equal(result.noticeLevel, "invalid_request");
    assert.equal(result.percentage, 0);
    assert.equal(Number.isNaN(result.percentage), false);
    assert.equal(JSON.stringify(result).includes(sentinel), false);
    assert.equal(Object.isFrozen(result), true);
  }
});

test("entitlement shape validation rejects symbols, accessors, classes, and hostile proxies", () => {
  let getterCalls = 0;
  const accessor = {
    planKey: "free",
    resourceKey: "paddocksMax",
  };
  Object.defineProperty(accessor, "currentUsage", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 0;
    },
  });
  assert.equal(evaluateResourceEntitlement(accessor).valid, false);
  assert.equal(getterCalls, 0);

  const withSymbol = {
    planKey: "free",
    resourceKey: "paddocksMax",
    currentUsage: 0,
    [Symbol("private.person@example.com")]: true,
  };
  assert.equal(evaluateResourceEntitlement(withSymbol).valid, false);

  class EntitlementInput {
    constructor() {
      this.planKey = "free";
      this.resourceKey = "paddocksMax";
      this.currentUsage = 0;
    }
  }
  assert.equal(evaluateResourceEntitlement(new EntitlementInput()).valid, false);

  const hostile = new Proxy({}, {
    getPrototypeOf() {
      throw new Error("private.person@example.com");
    },
  });
  const denied = evaluateResourceEntitlement(hostile);
  assert.equal(denied.valid, false);
  assert.doesNotMatch(JSON.stringify(denied), /private\.person@example\.com/u);
});

function paddockEvaluation(currentUsage) {
  return evaluateResourceEntitlement({
    planKey: "free",
    resourceKey: "paddocksMax",
    currentUsage,
  });
}
