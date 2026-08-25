import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createRuntimeHeavyHeadroomPolicy,
  type RuntimeMemoryTelemetry,
} from "../../src/shared/middleware/chatAdmissionHeadroom.ts";
import {
  PerConnectionAdmissionController,
  admitChatStructure,
} from "../../src/shared/middleware/chatBodyAdmission.ts";

const GiB = 1024 * 1024 * 1024;
const MiB = 1024 * 1024;

function heavyBody() {
  return {
    messages: Array.from({ length: 200 }, () => ({ role: "user", content: "x" })),
    tools: [],
  };
}

test("runtime policy and process-global admission integrate across independent sessions", async () => {
  let now = 1_000;
  let current: RuntimeMemoryTelemetry = {
    heapLimitBytes: 8 * GiB,
    heapUsedBytes: 512 * MiB,
    rssUsedBytes: 768 * MiB,
    cgroupLimitBytes: 12 * GiB,
    cgroupUsedBytes: GiB,
  };
  const policy = createRuntimeHeavyHeadroomPolicy({
    explicitHeadroom: null,
    baseCapacity: 1,
    legacyHeadroom: 1,
    shedRatio: 0.75,
    sample: () => current,
    now: () => now,
    recoveryStableMs: 1_000,
  });
  const admission = new PerConnectionAdmissionController(1, {
    healthyHeadroomPolicy: policy,
    onShed: () => {},
  });
  const leases = [];

  for (const sessionId of ["integration-a", "integration-b", "integration-c"]) {
    const result = await admitChatStructure(heavyBody(), null, {
      controller: admission.getController(sessionId),
      heapPressureCheck: () => false,
    });
    assert.equal(result.admit, true);
    if (result.admit && result.lease) leases.push(result.lease);
  }
  assert.equal(admission.snapshot().activeHeavy, 1);
  assert.equal(admission.snapshot().activeHealthyHeadroom, 2);

  for (const lease of leases) lease.release();
  assert.equal(admission.snapshot().activeHeavy, 0);
  assert.equal(admission.snapshot().activeHealthyHeadroom, 0);

  current = { ...current, heapUsedBytes: 6 * GiB };
  now += 1;
  const primary = await admitChatStructure(heavyBody(), null, {
    controller: admission.getController("integration-pressure-a"),
    heapPressureCheck: () => true,
  });
  assert.equal(primary.admit, true);
  const pressured = await admitChatStructure(heavyBody(), null, {
    controller: admission.getController("integration-pressure-b"),
    heapPressureCheck: () => true,
  });
  assert.equal(pressured.admit, false);
  if (!pressured.admit) assert.equal(pressured.response.status, 503);
  if (primary.admit) primary.lease?.release();

  assert.equal(admission.snapshot().activeHeavy, 0);
  assert.equal(admission.snapshot().activeHealthyHeadroom, 0);
});
