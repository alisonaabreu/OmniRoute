import { performance } from "node:perf_hooks";
import v8 from "node:v8";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/**
 * Reserved transient memory for one additional heavyweight request.
 *
 * #7849 measured roughly 253 MiB RSS after its known quadratic defect was
 * removed. The 1 GiB default is four times that observation, reserving room for
 * the full parsed request graph plus native/external allocations that V8 heap
 * telemetry does not include. Operators may tune the estimate only inside the
 * bounded range below; smaller or malformed values disable adaptive growth.
 */
export const DEFAULT_HEAVY_REQUEST_COST_BYTES = GiB;
export const MIN_HEAVY_REQUEST_COST_BYTES = 512 * MiB;
export const MAX_HEAVY_REQUEST_COST_BYTES = 8 * GiB;

/** Capacity recovery must remain healthy for real elapsed time. */
export const DEFAULT_RECOVERY_STABLE_MS = 5_000;
export const MIN_RECOVERY_STABLE_MS = 1_000;
export const MAX_RECOVERY_STABLE_MS = 5 * 60_000;

/** Runtime-derived headroom is bounded even on very large heaps. */
export const MAX_DERIVED_HEALTHY_HEADROOM = 8;

/** Existing pressure threshold shared by the structural and adaptive gates. */
export const CHAT_ADMISSION_HEAP_SHED_RATIO = (() => {
  const parsed = Number(process.env.OMNIROUTE_CHAT_ADMISSION_HEAP_SHED_RATIO);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : 0.75;
})();

export type RuntimeHeavyHeadroomReason =
  | "environment_override"
  | "runtime_capacity"
  | "runtime_cgroup_capacity"
  | "heap_pressure"
  | "cgroup_pressure"
  | "telemetry_unavailable"
  | "telemetry_invalid"
  | "telemetry_contradictory"
  | "configuration_invalid"
  | "recovery_hysteresis";

export type RuntimeMemoryTelemetry = {
  heapLimitBytes: number | null;
  heapUsedBytes: number | null;
  /** Whole-process RSS, including native/external memory outside the V8 heap. */
  rssUsedBytes: number | null;
  /** Optional process/container limit. `null` means no constraint was detected. */
  cgroupLimitBytes: number | null;
  /** Whole-cgroup usage paired with `cgroupLimitBytes`. */
  cgroupUsedBytes: number | null;
};

export type RuntimeHeavyHeadroomInput = RuntimeMemoryTelemetry & {
  /** Primary process-global heavyweight slots already available. */
  baseCapacity: number;
  /** Existing conservative headroom used whenever telemetry cannot be trusted. */
  legacyHeadroom: number;
  /** Existing heap-pressure shed ratio. */
  shedRatio: number;
  perRequestCostBytes?: number;
  maxDerivedHeadroom?: number;
};

export type RuntimeHeavyHeadroomDerivation = {
  memorySafeHeadroom: number;
  reason: RuntimeHeavyHeadroomReason;
};

export type RuntimeHeavyHeadroomSnapshot = RuntimeHeavyHeadroomDerivation & {
  configuredHeadroom: number | null;
  effectiveHeadroom: number;
};

export type RuntimeHeavyHeadroomPolicy = {
  getEffectiveHeadroom(): number;
  snapshot(): RuntimeHeavyHeadroomSnapshot;
};

export type RuntimeHeavyHeadroomPolicyOptions = {
  explicitHeadroom: number | null;
  baseCapacity: number;
  legacyHeadroom: number;
  shedRatio: number;
  sample?: () => RuntimeMemoryTelemetry;
  now?: () => number;
  recoveryStableMs?: number;
  perRequestCostBytes?: number;
  maxDerivedHeadroom?: number;
  configurationValid?: boolean;
};

export type RuntimeHeavyHeadroomConfiguration = {
  perRequestCostBytes: number;
  recoveryStableMs: number;
  valid: boolean;
};

export type RuntimeHeavyHeadroomConfigurationInput = {
  heavyRequestCostBytes?: string;
  recoveryStableMs?: string;
};

export type ConfiguredRuntimeHeavyHeadroom = {
  healthyHeadroom: number;
  policy: RuntimeHeavyHeadroomPolicy;
};

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number
): { value: number; valid: boolean } {
  if (value === undefined) return { value: fallback, valid: true };
  if (!/^(0|[1-9]\d*)$/.test(value)) return { value: fallback, valid: false };
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max
    ? { value: parsed, valid: true }
    : { value: fallback, valid: false };
}

function parseOptionalNonNegativeInteger(value: string | undefined): {
  value: number | null;
  valid: boolean;
} {
  if (value === undefined) return { value: null, valid: true };
  if (!/^(0|[1-9]\d*)$/.test(value)) return { value: null, valid: false };
  const parsed = Number(value);
  return Number.isSafeInteger(parsed)
    ? { value: parsed, valid: true }
    : { value: null, valid: false };
}

/** Parse bounded adaptive settings without accepting partial numeric strings. */
export function resolveRuntimeHeavyHeadroomConfiguration(
  input: RuntimeHeavyHeadroomConfigurationInput
): RuntimeHeavyHeadroomConfiguration {
  const cost = parseBoundedInteger(
    input.heavyRequestCostBytes,
    DEFAULT_HEAVY_REQUEST_COST_BYTES,
    MIN_HEAVY_REQUEST_COST_BYTES,
    MAX_HEAVY_REQUEST_COST_BYTES
  );
  const recovery = parseBoundedInteger(
    input.recoveryStableMs,
    DEFAULT_RECOVERY_STABLE_MS,
    MIN_RECOVERY_STABLE_MS,
    MAX_RECOVERY_STABLE_MS
  );
  return {
    perRequestCostBytes: cost.value,
    recoveryStableMs: recovery.value,
    valid: cost.valid && recovery.valid,
  };
}

/** Build the process policy while preserving a valid exact fixed override. */
export function createConfiguredRuntimeHeavyHeadroom(
  baseCapacity: number
): ConfiguredRuntimeHeavyHeadroom {
  const explicit = parseOptionalNonNegativeInteger(
    process.env.OMNIROUTE_CHAT_ADMISSION_HEALTHY_HEADROOM
  );
  const adaptive = resolveRuntimeHeavyHeadroomConfiguration({
    heavyRequestCostBytes: process.env.OMNIROUTE_CHAT_ADMISSION_HEAVY_REQUEST_COST_BYTES,
    recoveryStableMs: process.env.OMNIROUTE_CHAT_ADMISSION_RECOVERY_STABLE_MS,
  });
  return {
    healthyHeadroom: explicit.value ?? baseCapacity,
    policy: createRuntimeHeavyHeadroomPolicy({
      explicitHeadroom: explicit.value,
      baseCapacity,
      legacyHeadroom: baseCapacity,
      shedRatio: CHAT_ADMISSION_HEAP_SHED_RATIO,
      perRequestCostBytes: adaptive.perRequestCostBytes,
      recoveryStableMs: adaptive.recoveryStableMs,
      configurationValid: explicit.valid && adaptive.valid,
    }),
  };
}

/** Live V8 pressure probe, injectable at the admission call site for tests. */
export function defaultHeapPressureCheck(): boolean {
  try {
    const heapUsed = process.memoryUsage().heapUsed;
    const heapLimit = v8.getHeapStatistics().heap_size_limit;
    if (!Number.isFinite(heapLimit) || heapLimit <= 0) return false;
    return heapUsed / heapLimit >= CHAT_ADMISSION_HEAP_SHED_RATIO;
  } catch {
    return false;
  }
}

function conservativeFallback(
  legacyHeadroom: number,
  reason: Extract<
    RuntimeHeavyHeadroomReason,
    "telemetry_unavailable" | "telemetry_invalid" | "telemetry_contradictory"
  >
): RuntimeHeavyHeadroomDerivation {
  return { memorySafeHeadroom: legacyHeadroom, reason };
}

function validateCoreInput(input: RuntimeHeavyHeadroomInput): void {
  if (!isPositiveSafeInteger(input.baseCapacity)) {
    throw new RangeError("baseCapacity must be a positive safe integer");
  }
  if (!isNonNegativeSafeInteger(input.legacyHeadroom)) {
    throw new RangeError("legacyHeadroom must be a non-negative safe integer");
  }
  if (!Number.isFinite(input.shedRatio) || input.shedRatio <= 0 || input.shedRatio > 1) {
    throw new RangeError("shedRatio must be finite and in (0, 1]");
  }
  const perRequestCostBytes = input.perRequestCostBytes ?? DEFAULT_HEAVY_REQUEST_COST_BYTES;
  if (!isPositiveSafeInteger(perRequestCostBytes)) {
    throw new RangeError("perRequestCostBytes must be a positive safe integer");
  }
  const maxDerivedHeadroom = input.maxDerivedHeadroom ?? MAX_DERIVED_HEALTHY_HEADROOM;
  if (!isNonNegativeSafeInteger(maxDerivedHeadroom)) {
    throw new RangeError("maxDerivedHeadroom must be a non-negative safe integer");
  }
}

function classifyByteTelemetry(value: number | null, allowZero: boolean) {
  if (value === null) return "unavailable" as const;
  if (!Number.isFinite(value) || !Number.isSafeInteger(value) || value < 0) {
    return "invalid" as const;
  }
  if (!allowZero && value === 0) return "invalid" as const;
  return "valid" as const;
}

/**
 * Derive process-global healthy headroom from every applicable memory budget.
 *
 * The V8 budget covers heap allocations. A cgroup budget is evaluated whenever
 * it is valid, even when its numeric limit exceeds the V8 heap limit, because
 * cgroup/RSS usage also includes native and external memory. The lower current
 * available-byte budget wins. Account/provider counts are intentionally absent.
 */
export function deriveRuntimeHeavyHeadroom(
  input: RuntimeHeavyHeadroomInput
): RuntimeHeavyHeadroomDerivation {
  validateCoreInput(input);

  const heapLimitState = classifyByteTelemetry(input.heapLimitBytes, false);
  const heapUsedState = classifyByteTelemetry(input.heapUsedBytes, true);
  if (heapLimitState === "unavailable" || heapUsedState === "unavailable") {
    return conservativeFallback(input.legacyHeadroom, "telemetry_unavailable");
  }
  if (heapLimitState === "invalid" || heapUsedState === "invalid") {
    return conservativeFallback(input.legacyHeadroom, "telemetry_invalid");
  }

  const rssState = classifyByteTelemetry(input.rssUsedBytes, true);
  if (rssState === "invalid") {
    return conservativeFallback(input.legacyHeadroom, "telemetry_invalid");
  }

  const cgroupLimitState = classifyByteTelemetry(input.cgroupLimitBytes, false);
  const cgroupUsedState = classifyByteTelemetry(input.cgroupUsedBytes, true);
  if (cgroupLimitState === "invalid" || cgroupUsedState === "invalid") {
    return conservativeFallback(input.legacyHeadroom, "telemetry_invalid");
  }
  if (cgroupLimitState === "valid" && cgroupUsedState === "unavailable") {
    return conservativeFallback(input.legacyHeadroom, "telemetry_unavailable");
  }
  if (cgroupLimitState === "unavailable" && cgroupUsedState === "valid") {
    return conservativeFallback(input.legacyHeadroom, "telemetry_contradictory");
  }

  const heapLimitBytes = input.heapLimitBytes as number;
  const heapUsedBytes = input.heapUsedBytes as number;
  if (heapUsedBytes > heapLimitBytes) {
    return conservativeFallback(input.legacyHeadroom, "telemetry_contradictory");
  }

  const heapAvailableBytes = Math.floor(heapLimitBytes * input.shedRatio) - heapUsedBytes;
  let availableBytes = heapAvailableBytes;
  let reason: RuntimeHeavyHeadroomReason =
    heapAvailableBytes <= 0 ? "heap_pressure" : "runtime_capacity";

  if (cgroupLimitState === "valid") {
    const cgroupLimitBytes = input.cgroupLimitBytes as number;
    const cgroupUsedBytes = input.cgroupUsedBytes as number;
    const rssUsedBytes = rssState === "valid" ? (input.rssUsedBytes as number) : 0;
    if (cgroupUsedBytes > cgroupLimitBytes || rssUsedBytes > cgroupLimitBytes) {
      return conservativeFallback(input.legacyHeadroom, "telemetry_contradictory");
    }
    const totalUsedBytes = Math.max(cgroupUsedBytes, rssUsedBytes);
    const cgroupAvailableBytes = Math.floor(cgroupLimitBytes * input.shedRatio) - totalUsedBytes;
    if (cgroupAvailableBytes < availableBytes) {
      availableBytes = cgroupAvailableBytes;
      reason = cgroupAvailableBytes <= 0 ? "cgroup_pressure" : "runtime_cgroup_capacity";
    }
  }

  if (availableBytes <= 0) return { memorySafeHeadroom: 0, reason };

  const perRequestCostBytes = input.perRequestCostBytes ?? DEFAULT_HEAVY_REQUEST_COST_BYTES;
  const maxDerivedHeadroom = input.maxDerivedHeadroom ?? MAX_DERIVED_HEALTHY_HEADROOM;
  const memorySafeTotalCapacity = Math.floor(availableBytes / perRequestCostBytes);
  const derivedHeadroom = Math.max(0, memorySafeTotalCapacity - input.baseCapacity);
  return {
    memorySafeHeadroom: Math.min(maxDerivedHeadroom, derivedHeadroom),
    reason,
  };
}

/** Read privacy-sensitive memory values for internal derivation only. */
export function sampleRuntimeMemoryTelemetry(): RuntimeMemoryTelemetry {
  let heapLimitBytes: number | null = null;
  let heapUsedBytes: number | null = null;
  let rssUsedBytes: number | null = null;
  let cgroupLimitBytes: number | null = null;
  let cgroupUsedBytes: number | null = null;

  try {
    const heap = v8.getHeapStatistics();
    heapLimitBytes = heap.heap_size_limit;
    heapUsedBytes = heap.used_heap_size;
  } catch {
    // Required V8 telemetry remains unavailable and fails conservatively.
  }

  try {
    const memory = process.memoryUsage();
    rssUsedBytes = memory.rss;
    if (heapUsedBytes === null) heapUsedBytes = memory.heapUsed;
    const constrained = process.constrainedMemory();
    // libuv can expose UINT64_MAX rounded by JavaScript when no constraint
    // exists. Treat that sentinel like no applicable cgroup budget.
    if (constrained > 0 && constrained <= Number.MAX_SAFE_INTEGER) {
      cgroupLimitBytes = constrained;
      const available = process.availableMemory();
      cgroupUsedBytes =
        Number.isSafeInteger(available) && available >= 0 && available <= constrained
          ? Math.max(constrained - available, rssUsedBytes ?? 0)
          : Number.NaN;
    } else if (!Number.isFinite(constrained) || constrained < 0) {
      cgroupLimitBytes = Number.NaN;
    }
  } catch {
    // Keep the V8 sample. An applicable but incomplete cgroup pair fails closed.
  }

  return {
    heapLimitBytes,
    heapUsedBytes,
    rssUsedBytes,
    cgroupLimitBytes,
    cgroupUsedBytes,
  };
}

/**
 * Stateful policy: bootstrap from the first trustworthy sample, contract on the
 * first lower sample, and recover only after a candidate remains healthy for a
 * real elapsed interval. Repeated acquisitions in one millisecond cannot advance
 * recovery.
 */
export function createRuntimeHeavyHeadroomPolicy(
  options: RuntimeHeavyHeadroomPolicyOptions
): RuntimeHeavyHeadroomPolicy {
  if (options.explicitHeadroom !== null && !isNonNegativeSafeInteger(options.explicitHeadroom)) {
    throw new RangeError("explicitHeadroom must be a non-negative safe integer or null");
  }
  const recoveryStableMs = options.recoveryStableMs ?? DEFAULT_RECOVERY_STABLE_MS;
  if (!isPositiveSafeInteger(recoveryStableMs)) {
    throw new RangeError("recoveryStableMs must be a positive safe integer");
  }

  if (options.explicitHeadroom !== null) {
    const fixed = options.explicitHeadroom;
    const snapshot: RuntimeHeavyHeadroomSnapshot = {
      configuredHeadroom: fixed,
      effectiveHeadroom: fixed,
      memorySafeHeadroom: fixed,
      reason: "environment_override",
    };
    return {
      getEffectiveHeadroom: () => fixed,
      snapshot: () => ({ ...snapshot }),
    };
  }

  if (options.configurationValid === false) {
    const fallback: RuntimeHeavyHeadroomSnapshot = {
      configuredHeadroom: null,
      effectiveHeadroom: options.legacyHeadroom,
      memorySafeHeadroom: options.legacyHeadroom,
      reason: "configuration_invalid",
    };
    return {
      getEffectiveHeadroom: () => fallback.effectiveHeadroom,
      snapshot: () => ({ ...fallback }),
    };
  }

  const sample = options.sample ?? sampleRuntimeMemoryTelemetry;
  const now = options.now ?? (() => performance.now());
  let initialized = false;
  let effectiveHeadroom = options.legacyHeadroom;
  let memorySafeHeadroom = options.legacyHeadroom;
  let reason: RuntimeHeavyHeadroomReason = "telemetry_unavailable";
  let pendingGrowth: number | null = null;
  let pendingGrowthSince: number | null = null;

  const derive = (): RuntimeHeavyHeadroomDerivation => {
    let current: RuntimeMemoryTelemetry;
    try {
      current = sample();
    } catch {
      current = {
        heapLimitBytes: null,
        heapUsedBytes: null,
        rssUsedBytes: null,
        cgroupLimitBytes: null,
        cgroupUsedBytes: null,
      };
    }
    return deriveRuntimeHeavyHeadroom({
      ...current,
      baseCapacity: options.baseCapacity,
      legacyHeadroom: options.legacyHeadroom,
      shedRatio: options.shedRatio,
      perRequestCostBytes: options.perRequestCostBytes,
      maxDerivedHeadroom: options.maxDerivedHeadroom,
    });
  };

  const readNow = (): number | null => {
    try {
      const value = now();
      return Number.isFinite(value) && value >= 0 ? value : null;
    } catch {
      return null;
    }
  };

  const refresh = (): number => {
    const derived = derive();
    memorySafeHeadroom = derived.memorySafeHeadroom;

    if (!initialized) {
      initialized = true;
      effectiveHeadroom = memorySafeHeadroom;
      reason = derived.reason;
      return effectiveHeadroom;
    }

    if (memorySafeHeadroom <= effectiveHeadroom) {
      effectiveHeadroom = memorySafeHeadroom;
      pendingGrowth = null;
      pendingGrowthSince = null;
      reason = derived.reason;
      return effectiveHeadroom;
    }

    const currentTime = readNow();
    if (currentTime === null) {
      pendingGrowth = null;
      pendingGrowthSince = null;
      reason = "recovery_hysteresis";
      return effectiveHeadroom;
    }
    if (
      pendingGrowth !== memorySafeHeadroom ||
      pendingGrowthSince === null ||
      currentTime < pendingGrowthSince
    ) {
      pendingGrowth = memorySafeHeadroom;
      pendingGrowthSince = currentTime;
      reason = "recovery_hysteresis";
      return effectiveHeadroom;
    }
    if (currentTime - pendingGrowthSince < recoveryStableMs) {
      reason = "recovery_hysteresis";
      return effectiveHeadroom;
    }

    effectiveHeadroom = memorySafeHeadroom;
    pendingGrowth = null;
    pendingGrowthSince = null;
    reason = derived.reason;
    return effectiveHeadroom;
  };

  return {
    getEffectiveHeadroom: refresh,
    snapshot: () => ({
      configuredHeadroom: null,
      effectiveHeadroom,
      memorySafeHeadroom,
      reason,
    }),
  };
}
