import { z } from 'zod';
import { FindingSchema } from './finding';
import { HealthReportSchema } from './health';

/**
 * The envelope every inter-agent message travels in.
 *
 * `correlationId` is the point of this type: with ten processes, tracing one
 * real-world incident across them is impossible without an identifier that is
 * created once at the origin and copied — never regenerated — by everything
 * downstream.
 */
export const EventEnvelopeSchema = z.object({
  /** Unique per event. */
  id: z.string().min(1),
  /** Emitting agent, e.g. "agent2-resilience". */
  source: z.string().min(1),
  ts: z.string().datetime(),
  /** Shared by every event tracing back to the same originating cause. */
  correlationId: z.string().min(1),
  /** Schema version of the payload, so consumers can refuse what they can't read. */
  v: z.literal(1).default(1),
});

export const FindingEventSchema = EventEnvelopeSchema.extend({
  type: z.literal('finding'),
  payload: FindingSchema,
});

export const HealthEventSchema = EventEnvelopeSchema.extend({
  type: z.literal('health'),
  payload: HealthReportSchema,
});

export const FindingResolvedEventSchema = EventEnvelopeSchema.extend({
  type: z.literal('finding_resolved'),
  payload: z.object({
    dedupeKey: z.string().min(1),
    resolvedAt: z.string().datetime(),
    /** Why it cleared: "below_threshold", "device_reachable", "manual". */
    reason: z.string().min(1),
  }),
});

export const AgentEventSchema = z.discriminatedUnion('type', [
  FindingEventSchema,
  HealthEventSchema,
  FindingResolvedEventSchema,
]);

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
export type FindingEvent = z.infer<typeof FindingEventSchema>;
export type HealthEvent = z.infer<typeof HealthEventSchema>;
export type FindingResolvedEvent = z.infer<typeof FindingResolvedEventSchema>;
export type AgentEvent = z.infer<typeof AgentEventSchema>;

let eventCounter = 0;

export function newCorrelationId(): string {
  // Not cryptographic — this is a trace identifier, not a secret.
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function newEventId(): string {
  eventCounter = (eventCounter + 1) % 1_000_000;
  return `e-${Date.now().toString(36)}-${eventCounter.toString(36)}`;
}

/**
 * Wraps a payload in an envelope.
 *
 * Pass an existing `correlationId` whenever this event is a consequence of
 * another. Omitting it starts a new trace, which is correct only at an origin.
 */
export function envelope<T extends AgentEvent['type']>(
  type: T,
  source: string,
  payload: Extract<AgentEvent, { type: T }>['payload'],
  correlationId?: string,
): Extract<AgentEvent, { type: T }> {
  return AgentEventSchema.parse({
    id: newEventId(),
    source,
    ts: new Date().toISOString(),
    correlationId: correlationId ?? newCorrelationId(),
    v: 1,
    type,
    payload,
  }) as Extract<AgentEvent, { type: T }>;
}
