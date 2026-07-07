import {
  type Attributes,
  type Meter,
  metrics as metricsApi,
  SpanKind,
  SpanStatusCode,
  trace,
  type Tracer,
} from "@opentelemetry/api";

import type { TelemetryHooks } from "../types/index.js";

const scopeName = "agent-web-search";

export interface CreateOtelHooksOptions {
  /** Defaults to trace.getTracer("agent-web-search"). */
  tracer?: Tracer;
  /** Defaults to metrics.getMeter("agent-web-search"). */
  meter?: Meter;
  /** Emit one CLIENT span per engine call. Default true. */
  spans?: boolean;
  /** Record metrics. Default true. */
  metrics?: boolean;
  /**
   * Per-engine cost fallback (USD) for the cost counter when the provider
   * reports no usage.costUsd. Hooks only see results, so an engine's
   * costPerRequestUsd config is not visible here — repeat it in this map
   * to count estimated costs.
   */
  costPerRequestUsd?: Record<string, number>;
}

/**
 * Maps the library's TelemetryHooks to OpenTelemetry spans and metrics.
 * Spread the returned hooks into client, request, or engine hooks:
 *
 * ```ts
 * const client = createSearchClient(engines, { hooks: createOtelHooks() });
 * ```
 *
 * Only `@opentelemetry/api` is required (an optional peer dependency); with
 * no SDK registered, the API's no-op tracer and meter make every hook free.
 *
 * Spans are constructed when an engine call settles, backdated over the
 * call's measured latency, because hooks carry no per-call identity that
 * could pair onRequest with onResponse under concurrency. The trade-off:
 * spans are never active while the request runs, so no trace context is
 * propagated into provider HTTP calls.
 */
export const createOtelHooks = (
  options: CreateOtelHooksOptions = {},
): TelemetryHooks => {
  const tracer = options.tracer ?? trace.getTracer(scopeName);
  const meter = options.meter ?? metricsApi.getMeter(scopeName);
  const spansEnabled = options.spans ?? true;
  const metricsEnabled = options.metrics ?? true;
  const costFallback = options.costPerRequestUsd ?? {};

  // Durations are recorded in milliseconds — the unit the library reports —
  // rather than the seconds OTel semconv prefers for http.* histograms.
  const requests = meter.createCounter("agent_web_search.requests", {
    description: "HTTP request attempts issued to search engines",
  });
  const attemptDuration = meter.createHistogram(
    "agent_web_search.attempt.duration",
    { unit: "ms", description: "Per-attempt response latency" },
  );
  const retries = meter.createCounter("agent_web_search.retries", {
    description: "Retries scheduled after failed attempts",
  });
  const errors = meter.createCounter("agent_web_search.errors", {
    description: "Engine calls that settled as failures",
  });
  const callDuration = meter.createHistogram("agent_web_search.call.duration", {
    unit: "ms",
    description: "Engine call latency including retries",
  });
  const cost = meter.createCounter("agent_web_search.cost", {
    unit: "usd",
    description: "Provider-reported or estimated search spend",
  });

  return {
    onRequest({ engine }) {
      if (metricsEnabled) {
        requests.add(1, { "search.engine": engine });
      }
    },
    onResponse({ engine, status, latencyMs }) {
      if (metricsEnabled) {
        attemptDuration.record(latencyMs, {
          "search.engine": engine,
          "http.response.status_code": status,
        });
      }
    },
    onRetry({ engine, error }) {
      if (metricsEnabled) {
        retries.add(1, { "search.engine": engine, "error.kind": error.kind });
      }
    },
    onError({ engine, error }) {
      if (metricsEnabled) {
        errors.add(1, { "search.engine": engine, "error.kind": error.kind });
      }
    },
    onSettled({ engine, result }) {
      if (metricsEnabled) {
        callDuration.record(result.metadata.latencyMs, {
          "search.engine": engine,
          ok: result.ok,
        });

        const costUsd =
          result.metadata.usage?.costUsd ?? costFallback[engine] ?? 0;
        if (costUsd > 0) {
          cost.add(costUsd, { "search.engine": engine });
        }
      }

      if (spansEnabled) {
        const endTime = Date.now();
        const attributes: Attributes = {
          "search.engine": engine,
          ...(result.metadata.httpStatus === null
            ? {}
            : { "http.response.status_code": result.metadata.httpStatus }),
          ...(result.ok
            ? { "search.results.count": result.results.length }
            : { "error.kind": result.error.kind }),
        };
        const span = tracer.startSpan(`web_search ${engine}`, {
          kind: SpanKind.CLIENT,
          startTime: endTime - result.metadata.latencyMs,
          attributes,
        });
        if (!result.ok) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: result.error.message,
          });
        }
        span.end(endTime);
      }
    },
  };
};
