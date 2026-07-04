import type {
  CostBudget,
  EngineConfig,
  EngineFailure,
  EngineResult,
  SearchEngineError,
  Warning,
} from "../types/index.js";
import { makeFailure, makeMetadata } from "./utils.js";

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
  denial(engine: string): SearchEngineError | null {
    if (this.#budget && this.#spentUsd >= this.#budget.maxCostUsd) {
      return {
        kind: "quota",
        message: `Cost budget of $${this.#budget.maxCostUsd} reached (spent ~$${roundUsd(this.#spentUsd)})`,
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

  /**
   * Waits for a concurrency slot and the pacing interval, then returns a
   * release function. Callers must release in a finally block.
   */
  async acquire(
    engine: string,
    config: EngineConfig,
    signal?: AbortSignal,
  ): Promise<() => void> {
    const throttle = config.throttle;
    if (!throttle) {
      return () => undefined;
    }

    const state = this.#state(engine);
    const maxConcurrent = throttle.maxConcurrent ?? Number.POSITIVE_INFINITY;

    while (state.active >= maxConcurrent) {
      await waitForSlot(state, signal);
    }
    state.active += 1;

    try {
      const minIntervalMs = throttle.minIntervalMs ?? 0;
      if (minIntervalMs > 0) {
        const now = Date.now();
        const startAt = Math.max(now, state.nextStartAt);
        state.nextStartAt = startAt + minIntervalMs;
        if (startAt > now) {
          await sleep(startAt - now, signal);
        }
      }
    } catch (cause) {
      this.#release(state);
      throw cause;
    }

    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.#release(state);
      }
    };
  }

  /** Records provider-reported rate limits and accrues estimated cost. */
  record(engine: string, config: EngineConfig, result: EngineResult): void {
    const rateLimit = result.metadata.rateLimit;
    if (rateLimit?.remaining === 0 && rateLimit.resetAt) {
      const resetMs = new Date(rateLimit.resetAt).getTime();
      if (!Number.isNaN(resetMs)) {
        this.#state(engine).blockedUntilMs = resetMs;
      }
    } else if (rateLimit && (rateLimit.remaining ?? 0) > 0) {
      this.#state(engine).blockedUntilMs = null;
    }

    if (result.ok || result.error.kind !== "quota") {
      this.#spentUsd +=
        result.metadata.usage?.costUsd ?? config.costPerRequestUsd ?? 0;
    }
  }

  failure(engine: string, error: SearchEngineError, warnings: Warning[]) {
    return makeFailure({
      engine,
      error,
      metadata: makeMetadata({
        engine,
        latencyMs: 0,
        httpStatus: null,
        warnings,
      }),
    }) as EngineFailure;
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

const waitForSlot = (
  state: EngineState,
  signal?: AbortSignal,
): Promise<void> =>
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
