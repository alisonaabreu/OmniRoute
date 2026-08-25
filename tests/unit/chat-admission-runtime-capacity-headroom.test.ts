import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

import {
  DEFAULT_HEAVY_REQUEST_COST_BYTES,
  DEFAULT_RECOVERY_STABLE_MS,
  createRuntimeHeavyHeadroomPolicy,
  deriveRuntimeHeavyHeadroom,
  resolveRuntimeHeavyHeadroomConfiguration,
  type RuntimeHeavyHeadroomInput,
  type RuntimeMemoryTelemetry,
} from "../../src/shared/middleware/chatAdmissionHeadroom.ts";
import {
  PerConnectionAdmissionController,
  admitChatStructure,
} from "../../src/shared/middleware/chatBodyAdmission.ts";

const GiB = 1024 * 1024 * 1024;
const MiB = 1024 * 1024;

function representativeHealthyHost(
  overrides: Partial<RuntimeHeavyHeadroomInput> = {}
): RuntimeHeavyHeadroomInput {
  return {
    heapLimitBytes: 8 * GiB,
    heapUsedBytes: 512 * MiB,
    rssUsedBytes: 768 * MiB,
    cgroupLimitBytes: 12 * GiB,
    cgroupUsedBytes: GiB,
    baseCapacity: 1,
    legacyHeadroom: 1,
    shedRatio: 0.75,
    ...overrides,
  };
}

function telemetry(overrides: Partial<RuntimeMemoryTelemetry> = {}): RuntimeMemoryTelemetry {
  const host = representativeHealthyHost();
  return {
    heapLimitBytes: host.heapLimitBytes,
    heapUsedBytes: host.heapUsedBytes,
    rssUsedBytes: host.rssUsedBytes,
    cgroupLimitBytes: host.cgroupLimitBytes,
    cgroupUsedBytes: host.cgroupUsedBytes,
    ...overrides,
  };
}

function heavyBody() {
  return {
    messages: Array.from({ length: 200 }, () => ({ role: "user", content: "x" })),
    tools: [],
  };
}

function readProductionAdmissionSnapshot(overrides: Record<string, string>): {
  configuredHealthyHeadroom: number | null;
  effectiveHealthyHeadroom: number;
  healthyHeadroomReason: string;
} {
  const script = `
    const { perConnectionAdmissionController } = await import(
      "./src/shared/middleware/chatBodyAdmission.ts"
    );
    console.log("HEADROOM=" + JSON.stringify(perConnectionAdmissionController.snapshot()));
  `;
  const output = execFileSync(
    process.execPath,
    ["--import", "tsx/esm", "--input-type=module", "--eval", script],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        NODE_ENV: "test",
        APP_LOG_TO_FILE: "false",
        DATA_DIR: "/tmp/omniroute-admission-runtime-headroom-test",
        ...overrides,
      },
    }
  );
  const match = output.match(/^HEADROOM=(.+)$/m);
  assert.ok(match, "child process must report the production admission snapshot");
  return JSON.parse(match[1]);
}

test("the conservative request-cost estimate is operator-configurable and bounded", () => {
  assert.equal(DEFAULT_HEAVY_REQUEST_COST_BYTES, GiB);
  assert.equal(DEFAULT_RECOVERY_STABLE_MS, 5_000);

  assert.deepEqual(resolveRuntimeHeavyHeadroomConfiguration({}), {
    perRequestCostBytes: GiB,
    recoveryStableMs: 5_000,
    valid: true,
  });
  assert.deepEqual(
    resolveRuntimeHeavyHeadroomConfiguration({
      heavyRequestCostBytes: String(2 * GiB),
      recoveryStableMs: "12000",
    }),
    { perRequestCostBytes: 2 * GiB, recoveryStableMs: 12_000, valid: true }
  );

  for (const invalid of ["", "1", String(256 * MiB), "1073741824junk", "Infinity"]) {
    assert.equal(
      resolveRuntimeHeavyHeadroomConfiguration({ heavyRequestCostBytes: invalid }).valid,
      false,
      `cost ${JSON.stringify(invalid)} must fail closed`
    );
  }
  for (const invalid of ["", "0", "999", "5000junk", "Infinity"]) {
    assert.equal(
      resolveRuntimeHeavyHeadroomConfiguration({ recoveryStableMs: invalid }).valid,
      false,
      `interval ${JSON.stringify(invalid)} must fail closed`
    );
  }
});

test("a cgroup larger than the V8 heap still contracts near cgroup exhaustion", () => {
  const result = deriveRuntimeHeavyHeadroom(
    representativeHealthyHost({
      heapLimitBytes: 4 * GiB,
      heapUsedBytes: 512 * MiB,
      rssUsedBytes: 6 * GiB,
      cgroupLimitBytes: 8 * GiB,
      cgroupUsedBytes: 6 * GiB,
    })
  );

  assert.equal(result.memorySafeHeadroom, 0);
  assert.equal(result.reason, "cgroup_pressure");
});

test("the V8 heap budget wins when it has less available memory", () => {
  const result = deriveRuntimeHeavyHeadroom(
    representativeHealthyHost({
      heapLimitBytes: 4 * GiB,
      heapUsedBytes: GiB,
      rssUsedBytes: GiB,
      cgroupLimitBytes: 8 * GiB,
      cgroupUsedBytes: GiB,
    })
  );

  assert.equal(result.memorySafeHeadroom, 1);
  assert.equal(result.reason, "runtime_capacity");
});

test("the cgroup budget wins when it has less available memory", () => {
  const result = deriveRuntimeHeavyHeadroom(
    representativeHealthyHost({
      heapLimitBytes: 8 * GiB,
      heapUsedBytes: GiB,
      rssUsedBytes: 2 * GiB,
      cgroupLimitBytes: 4 * GiB,
      cgroupUsedBytes: 2 * GiB,
    })
  );

  assert.equal(result.memorySafeHeadroom, 0);
  assert.equal(result.reason, "runtime_cgroup_capacity");
});

test("RSS/native-memory pressure cannot be hidden by a lower cgroup usage sample", () => {
  const result = deriveRuntimeHeavyHeadroom(
    representativeHealthyHost({
      heapLimitBytes: 4 * GiB,
      heapUsedBytes: 512 * MiB,
      rssUsedBytes: 6 * GiB,
      cgroupLimitBytes: 8 * GiB,
      cgroupUsedBytes: 2 * GiB,
    })
  );

  assert.equal(result.memorySafeHeadroom, 0);
  assert.equal(result.reason, "cgroup_pressure");
});

test("unavailable, malformed, incomplete, and contradictory telemetry fail conservatively", () => {
  const unavailable = deriveRuntimeHeavyHeadroom(
    representativeHealthyHost({ heapLimitBytes: null })
  );
  const malformed = deriveRuntimeHeavyHeadroom(
    representativeHealthyHost({ rssUsedBytes: Number.NaN })
  );
  const incomplete = deriveRuntimeHeavyHeadroom(
    representativeHealthyHost({ cgroupUsedBytes: null })
  );
  const contradictory = deriveRuntimeHeavyHeadroom(
    representativeHealthyHost({ heapLimitBytes: 512 * MiB, heapUsedBytes: GiB })
  );

  assert.deepEqual(
    [
      unavailable.memorySafeHeadroom,
      malformed.memorySafeHeadroom,
      incomplete.memorySafeHeadroom,
      contradictory.memorySafeHeadroom,
    ],
    [1, 1, 1, 1]
  );
  assert.deepEqual(
    [unavailable.reason, malformed.reason, incomplete.reason, contradictory.reason],
    [
      "telemetry_unavailable",
      "telemetry_invalid",
      "telemetry_unavailable",
      "telemetry_contradictory",
    ]
  );
});

test("valid explicit overrides retain exact precedence and invalid overrides fail closed", () => {
  let samples = 0;
  const policy = createRuntimeHeavyHeadroomPolicy({
    explicitHeadroom: 5,
    baseCapacity: 1,
    legacyHeadroom: 1,
    shedRatio: 0.75,
    sample: () => {
      samples += 1;
      return telemetry({ heapUsedBytes: 7 * GiB });
    },
  });

  assert.equal(policy.getEffectiveHeadroom(), 5);
  assert.equal(samples, 0, "an explicit override must bypass runtime derivation");
  assert.deepEqual(policy.snapshot(), {
    configuredHeadroom: 5,
    effectiveHeadroom: 5,
    memorySafeHeadroom: 5,
    reason: "environment_override",
  });

  const validProduction = readProductionAdmissionSnapshot({
    OMNIROUTE_CHAT_ADMISSION_HEALTHY_HEADROOM: "5",
  });
  assert.equal(validProduction.configuredHealthyHeadroom, 5);
  assert.equal(validProduction.effectiveHealthyHeadroom, 5);
  assert.equal(validProduction.healthyHeadroomReason, "environment_override");

  const invalidProduction = readProductionAdmissionSnapshot({
    OMNIROUTE_CHAT_ADMISSION_HEALTHY_HEADROOM: "5junk",
  });
  assert.equal(invalidProduction.configuredHealthyHeadroom, null);
  assert.equal(invalidProduction.effectiveHealthyHeadroom, 1);
  assert.equal(invalidProduction.healthyHeadroomReason, "configuration_invalid");
});

test("invalid adaptive configuration cannot raise the legacy headroom", () => {
  const invalidCost = readProductionAdmissionSnapshot({
    OMNIROUTE_CHAT_ADMISSION_HEAVY_REQUEST_COST_BYTES: "1",
  });
  const invalidInterval = readProductionAdmissionSnapshot({
    OMNIROUTE_CHAT_ADMISSION_RECOVERY_STABLE_MS: "0",
  });

  for (const snapshot of [invalidCost, invalidInterval]) {
    assert.equal(snapshot.configuredHealthyHeadroom, null);
    assert.equal(snapshot.effectiveHealthyHeadroom, 1);
    assert.equal(snapshot.healthyHeadroomReason, "configuration_invalid");
  }
});

test("healthy bootstrap admits three simultaneous independent heavyweight sessions", async () => {
  const policy = createRuntimeHeavyHeadroomPolicy({
    explicitHeadroom: null,
    baseCapacity: 1,
    legacyHeadroom: 1,
    shedRatio: 0.75,
    sample: () => telemetry(),
    now: () => 10_000,
  });
  const processGlobal = new PerConnectionAdmissionController(1, {
    healthyHeadroomPolicy: policy,
    onShed: () => {},
  });
  const leases = [];

  for (const sessionId of ["session-a", "session-b", "session-c"]) {
    const admission = await admitChatStructure(heavyBody(), null, {
      controller: processGlobal.getController(sessionId),
      heapPressureCheck: () => false,
    });
    assert.equal(admission.admit, true, `${sessionId} must share usable global capacity`);
    if (admission.admit && admission.lease) leases.push(admission.lease);
  }

  assert.equal(processGlobal.snapshot().activeHeavy, 1);
  assert.equal(processGlobal.snapshot().activeHealthyHeadroom, 2);
  assert.ok(processGlobal.snapshot().effectiveHealthyHeadroom >= 2);
  for (const lease of leases) lease.release();
});

test("capacity contracts immediately under memory pressure", () => {
  let current = telemetry();
  let now = 20_000;
  const policy = createRuntimeHeavyHeadroomPolicy({
    explicitHeadroom: null,
    baseCapacity: 1,
    legacyHeadroom: 1,
    shedRatio: 0.75,
    sample: () => current,
    now: () => now,
    recoveryStableMs: 1_000,
  });

  assert.ok(policy.getEffectiveHeadroom() >= 2, "healthy bootstrap should derive headroom");
  current = telemetry({ heapUsedBytes: 6 * GiB });
  now += 1;
  assert.equal(policy.getEffectiveHeadroom(), 0);
  assert.equal(policy.snapshot().reason, "heap_pressure");
});

test("repeated calls in one millisecond cannot recover capacity", () => {
  let current = telemetry({ heapUsedBytes: 6 * GiB });
  let now = 30_000;
  const policy = createRuntimeHeavyHeadroomPolicy({
    explicitHeadroom: null,
    baseCapacity: 1,
    legacyHeadroom: 1,
    shedRatio: 0.75,
    sample: () => current,
    now: () => now,
    recoveryStableMs: 1_000,
  });

  assert.equal(policy.getEffectiveHeadroom(), 0);
  current = telemetry();
  for (let index = 0; index < 100; index += 1) {
    assert.equal(policy.getEffectiveHeadroom(), 0);
  }
  assert.equal(policy.snapshot().reason, "recovery_hysteresis");
});

test("capacity recovers only after a real stable interval", () => {
  let current = telemetry({ heapUsedBytes: 6 * GiB });
  let now = 40_000;
  const policy = createRuntimeHeavyHeadroomPolicy({
    explicitHeadroom: null,
    baseCapacity: 1,
    legacyHeadroom: 1,
    shedRatio: 0.75,
    sample: () => current,
    now: () => now,
    recoveryStableMs: 1_000,
  });

  assert.equal(policy.getEffectiveHeadroom(), 0);
  current = telemetry();
  assert.equal(policy.getEffectiveHeadroom(), 0);
  now += 999;
  assert.equal(policy.getEffectiveHeadroom(), 0);
  now += 1;
  assert.ok(policy.getEffectiveHeadroom() >= 2);
  assert.equal(policy.snapshot().reason, "runtime_capacity");
});

test("account count cannot multiply the process-global memory budget", () => {
  const oneAccount = {
    ...representativeHealthyHost(),
    accountCount: 1,
  } satisfies RuntimeHeavyHeadroomInput & { accountCount: number };
  const manyAccounts = {
    ...representativeHealthyHost(),
    accountCount: 10_000,
  } satisfies RuntimeHeavyHeadroomInput & { accountCount: number };

  assert.equal(
    deriveRuntimeHeavyHeadroom(oneAccount).memorySafeHeadroom,
    deriveRuntimeHeavyHeadroom(manyAccounts).memorySafeHeadroom
  );
});

test("pressure and exhausted derived capacity remain retryable 503s", async () => {
  let current = telemetry();
  let now = 50_000;
  const policy = createRuntimeHeavyHeadroomPolicy({
    explicitHeadroom: null,
    baseCapacity: 1,
    legacyHeadroom: 1,
    shedRatio: 0.75,
    sample: () => current,
    now: () => now,
    recoveryStableMs: 1_000,
  });
  const processGlobal = new PerConnectionAdmissionController(1, {
    healthyHeadroomPolicy: policy,
    onShed: () => {},
  });
  const controller = processGlobal.getController("bounded-capacity");
  const leases = [];

  for (;;) {
    const admission = await admitChatStructure(heavyBody(), null, {
      controller,
      heapPressureCheck: () => false,
    });
    if (!admission.admit) {
      assert.equal(admission.response.status, 503);
      assert.equal(admission.response.headers.get("Retry-After"), "1");
      break;
    }
    if (admission.lease) leases.push(admission.lease);
    assert.ok(leases.length <= 9, "derived capacity must remain bounded");
  }

  for (const lease of leases) lease.release();
  current = telemetry({ heapUsedBytes: 6 * GiB });
  now += 1;

  const primary = await admitChatStructure(heavyBody(), null, {
    controller,
    heapPressureCheck: () => true,
  });
  assert.equal(primary.admit, true);
  const pressured = await admitChatStructure(heavyBody(), null, {
    controller,
    heapPressureCheck: () => true,
  });
  assert.equal(pressured.admit, false);
  if (!pressured.admit) {
    assert.equal(pressured.response.status, 503);
    assert.equal(pressured.response.headers.get("Retry-After"), "1");
  }
  if (primary.admit) primary.lease?.release();
});
