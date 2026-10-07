import type {
  CostBudget,
  EngineConfig,
  EngineResult,
  RateLimit,
  SearchEngineError,
} from "../types/index.js";

export class DispatchDenied extends Error {
  readonly error: SearchEngineError;

  constructor(error: SearchEngineError) {
    super(error.message);
    this.error = error;
  }
}

export const isDispatchDenied = (cause: unknown): cause is DispatchDenied => {
  try {
    return cause instanceof DispatchDenied;
  } catch {
    return false;
  }
};

export interface AttemptLease {
  dispatched(): void;
  release(): void;
  settle(result?: EngineResult): void;
}

interface EngineState {
  active: number;
  waiters: (() => void)[];
  nextStartAt: number;
  blockedUntilMs: number | null;
}

/**
 * Client-scoped dispatch gate: enforces per-engine concurrency and pacing
 * (config.throttle), a cumulative cost budget (options.budget), and
 * proactive backoff when a provider reported an exhausted rate limit
 * (options.respectRateLimits).
 */
export class DispatchGate {
  readonly #budget?: CostBudget;
  readonly #respectRateLimits: boolean;
  readonly #states = new Map<string, EngineState>();
  #spentUsd = 0;
  #reservedUsd = 0;

  constructor(options: { budget?: CostBudget; respectRateLimits?: boolean }) {
    if (options.budget) {
      this.#budget = options.budget;
    }
    this.#respectRateLimits = options.respectRateLimits ?? false;
  }

  get spentUsd(): number {
    return this.#spentUsd;
  }

  /** Returns a fail-fast error when the engine must not issue a request now. */
  denial(engine: string, estimate = 0): SearchEngineError | null {
    const committed = this.#spentUsd + this.#reservedUsd;
    if (
      this.#budget &&
      committed + estimate > this.#budget.maxCostUsd + 1e-10
    ) {
      return {
        kind: "quota",
        message: `Cost budget of $${this.#budget.maxCostUsd} would be exceeded (spent/reserved ~$${roundUsd(committed)}, next ~$${roundUsd(estimate)})`,
        status: null,
        retryable: false,
      };
    }

    const state = this.#states.get(engine);
    if (
      this.#respectRateLimits &&
      state?.blockedUntilMs !== null &&
      state?.blockedUntilMs !== undefined &&
      state.blockedUntilMs > Date.now()
    ) {
      return {
        kind: "rate_limit",
        message: `${engine} rate limit exhausted; resets at ${new Date(state.blockedUntilMs).toISOString()}`,
        status: null,
        retryable: true,
      };
    }

    return null;
  }

  /** Reserve cost atomically immediately before dispatch; pacing can wait first. */
  begin(
    engine: string,
    config: EngineConfig,
    signal?: AbortSignal,
  ): AttemptLease | Promise<AttemptLease> {
    const estimate = config.costPerRequestUsd ?? 0;
    const check = () => {
      throwIfAborted(signal);
      const denial = this.denial(engine, estimate);
      if (denial) {
        throw new DispatchDenied(denial);
      }
    };
    check();
    const reserve = (release: () => void): AttemptLease => {
      try {
        check();
        this.#reservedUsd += estimate;
        let dispatched = false;
        let settled = false;
        return {
          dispatched: () => {
            dispatched = true;
          },
          release,
          settle: (result) => {
            if (settled) {
              return;
            }
            settled = true;
            this.#reservedUsd = Math.max(0, this.#reservedUsd - estimate);
            if (result) {
              this.observe(engine, result.metadata.rateLimit);
            }
            if (dispatched) {
              const reported = result?.metadata.usage?.costUsd;
              this.#spentUsd +=
                typeof reported === "number" &&
                Number.isFinite(reported) &&
                reported >= 0
                  ? reported
                  : estimate;
            }
          },
        };
      } catch (cause) {
        release();
        throw cause;
      }
    };
    if (!config.throttle) {
      return reserve(() => undefined);
    }
    return this.#acquire(engine, config.throttle, signal, check, reserve);
  }

  /**
   * Waits without reserving cost, then atomically admits and claims pacing.
   */
  async #acquire(
    engine: string,
    throttle: NonNullable<EngineConfig["throttle"]>,
    signal: AbortSignal | undefined,
    check: () => void,
    reserve: (release: () => void) => AttemptLease,
  ): Promise<AttemptLease> {
    const state = this.#state(engine);
    const maxConcurrent = throttle.maxConcurrent ?? Number.POSITIVE_INFINITY;

    while (state.active >= maxConcurrent) {
      check();
      await waitForSlot(state, signal);
    }
    state.active += 1;

    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        this.#release(state);
      }
    };
    try {
      const minIntervalMs = throttle.minIntervalMs ?? 0;
      while (true) {
        check();
        const now = Date.now();
        if (minIntervalMs > 0 && state.nextStartAt > now) {
          await sleep(state.nextStartAt - now, signal);
          continue;
        }
        const lease = reserve(release);
        state.nextStartAt = now + minIntervalMs;
        return lease;
      }
    } catch (cause) {
      release();
      throw cause;
    }
  }

  /** Update provider quota as soon as response headers are available. */
  observe(engine: string, rateLimit: RateLimit | null): void {
    if (rateLimit?.remaining === 0 && rateLimit.resetAt) {
      const resetMs = new Date(rateLimit.resetAt).getTime();
      if (!Number.isNaN(resetMs)) {
        this.#state(engine).blockedUntilMs = resetMs;
      }
    } else if (rateLimit && (rateLimit.remaining ?? 0) > 0) {
      this.#state(engine).blockedUntilMs = null;
    }
  }

  #state(engine: string): EngineState {
    let state = this.#states.get(engine);
    if (!state) {
      state = { active: 0, waiters: [], nextStartAt: 0, blockedUntilMs: null };
      this.#states.set(engine, state);
    }

    return state;
  }

  #release(state: EngineState): void {
    state.active -= 1;
    const waiter = state.waiters.shift();
    waiter?.();
  }
}

const roundUsd = (value: number): number => Math.round(value * 10_000) / 10_000;

const abortError = (signal?: AbortSignal): Error =>
  signal?.reason instanceof Error
    ? signal.reason
    : new Error("Request aborted");

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw abortError(signal);
  }
};

const waitForSlot = (state: EngineState, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }

    const onReady = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };
    const cleanup = () => {
      const index = state.waiters.indexOf(onReady);
      if (index >= 0) {
        state.waiters.splice(index, 1);
      }
      signal?.removeEventListener("abort", onAbort);
    };

    state.waiters.push(onReady);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
