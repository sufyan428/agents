import { AsyncLocalStorage } from 'node:async_hooks';
import { newCorrelationId } from '@ragent/agent-protocol';

/**
 * Correlation IDs that survive across agents.
 *
 * Ten processes watch one network. When something goes wrong, the evidence is
 * spread across ten log files with no shared identifier, so reconstructing what
 * happened means matching timestamps by eye and hoping the clocks agree.
 *
 * The HTTP layer already accepts and echoes an inbound `x-correlation-id`. What
 * was missing is the other two halves: carrying that id through the async work
 * a request triggers, and putting it on outbound calls to other agents so the
 * trace continues rather than restarting at every hop.
 *
 * AsyncLocalStorage rather than threading an id through every function
 * signature. Passing it explicitly is cleaner in principle and does not survive
 * contact with a polling loop, a timer callback and an axios interceptor.
 */

interface TraceContext {
  correlationId: string;
  /** Which agent started this trace. Useful when reading a merged log. */
  origin: string;
}

const storage = new AsyncLocalStorage<TraceContext>();

/** Runs `fn` with a correlation context that everything downstream inherits. */
export function withTrace<T>(correlationId: string, origin: string, fn: () => T): T {
  return storage.run({ correlationId, origin }, fn);
}

/** Starts a new trace. Use only at an origin - a poll cycle, a cron tick. */
export function startTrace<T>(origin: string, fn: () => T): T {
  return withTrace(newCorrelationId(), origin, fn);
}

/** The current correlation id, or undefined outside any trace. */
export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

export function currentTrace(): TraceContext | undefined {
  return storage.getStore();
}

/**
 * Headers to attach to an outbound request so the trace continues.
 *
 * Without this every agent-to-agent call starts a fresh trace, and a single
 * incident produces as many unrelated ids as there are hops.
 */
export function traceHeaders(): Record<string, string> {
  const id = currentCorrelationId();
  return id ? { 'x-correlation-id': id } : {};
}

/**
 * Installs an axios interceptor that adds the trace header automatically.
 *
 * Automatic rather than per-call, because a propagation scheme that has to be
 * remembered at every call site is one that will be missed at some of them, and
 * a trace with a hole in it is worse than no trace: it looks complete.
 */
export function instrumentAxios(axiosInstance: {
  interceptors: { request: { use(fn: (c: AxiosLikeConfig) => AxiosLikeConfig): void } };
}): void {
  axiosInstance.interceptors.request.use((config) => {
    const id = currentCorrelationId();
    if (id) {
      config.headers = { ...(config.headers ?? {}), 'x-correlation-id': id };
    }
    return config;
  });
}

interface AxiosLikeConfig {
  headers?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * A winston format that stamps the current correlation id onto every record.
 *
 * Applied once at logger construction, so no log call has to remember it.
 */
export function correlationFormat(): (info: Record<string, unknown>) => Record<string, unknown> {
  return (info) => {
    const trace = currentTrace();
    if (trace && info.correlationId === undefined) {
      info.correlationId = trace.correlationId;
      if (info.traceOrigin === undefined) info.traceOrigin = trace.origin;
    }
    return info;
  };
}
