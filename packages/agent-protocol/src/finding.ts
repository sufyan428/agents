import { z } from 'zod';

/**
 * Severity ordering matters — comparisons and sorting depend on this exact
 * order, so it is declared once here and derived everywhere else.
 */
export const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
export const SeveritySchema = z.enum(SEVERITIES);
export type Severity = z.infer<typeof SeveritySchema>;

const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/** Positive if `a` is more severe than `b`. Suitable for `Array.sort`. */
export function compareSeverity(a: Severity, b: Severity): number {
  return SEVERITY_RANK[a] - SEVERITY_RANK[b];
}

export function isAtLeast(actual: Severity, threshold: Severity): boolean {
  return SEVERITY_RANK[actual] >= SEVERITY_RANK[threshold];
}

/**
 * What a finding is about. Kept deliberately small — a finding points at one
 * thing, and anything richer belongs in `evidence`.
 */
export const EntitySchema = z.object({
  /** router, interface, agent, policy, config — open set, lowercase. */
  type: z.string().min(1),
  /** Stable identifier within that type, e.g. an IP or an interface index. */
  id: z.string().min(1),
  /** Human-facing label. Falls back to `id` when absent. */
  name: z.string().optional(),
});
export type Entity = z.infer<typeof EntitySchema>;

/**
 * The single normalized unit every agent emits.
 *
 * Agents 1-5 produce these; agent6 correlates them; agents 7-10 enrich them.
 * Nothing downstream should have to know which agent authored a finding in
 * order to reason about it.
 */
export const FindingSchema = z.object({
  /** Unique per emission. See `newFindingId`. */
  id: z.string().min(1),

  /** Emitting agent, e.g. "agent3-security". */
  agent: z.string().min(1),

  /**
   * Stable machine-readable category, e.g. "cpu_threshold_exceeded" or
   * "auth_failure_burst". Dashboards and suppression rules key off this, so it
   * must not be a free-text sentence.
   */
  kind: z.string().regex(/^[a-z0-9_]+$/, 'kind must be lower_snake_case'),

  severity: SeveritySchema,
  entity: EntitySchema,

  /** One line, human-facing. No trailing period. */
  title: z.string().min(1),

  /** Optional longer explanation. */
  detail: z.string().optional(),

  /**
   * Structured supporting data — measured values, thresholds, sample counts.
   * Never prose; this is what a human or a model reasons over.
   */
  evidence: z.record(z.unknown()).default({}),

  firstSeen: z.string().datetime(),
  lastSeen: z.string().datetime(),

  /** How many times this finding has recurred since `firstSeen`. */
  count: z.number().int().positive().default(1),

  /** Identity for deduplication. See `dedupeKeyFor`. */
  dedupeKey: z.string().min(1),

  /**
   * True when any input to this finding came from a simulated or placeholder
   * code path rather than a real device.
   *
   * This flag is load-bearing. A monitoring tool that reports fabricated
   * results as real is worse than one that reports nothing, so anything
   * consuming a finding — dashboards, reports, the AI layer — must surface
   * this rather than quietly dropping it.
   */
  simulated: z.boolean().default(false),

  /** Free-form labels for routing and filtering. */
  tags: z.array(z.string()).default([]),

  /** Ties this finding to the request or cycle that produced it. */
  correlationId: z.string().optional(),
});

export type Finding = z.infer<typeof FindingSchema>;

/** A finding as an author supplies it, before defaults and identity are applied. */
export type FindingInput = Omit<
  Finding,
  'id' | 'firstSeen' | 'lastSeen' | 'count' | 'dedupeKey' | 'evidence' | 'simulated' | 'tags'
> &
  Partial<Pick<Finding, 'evidence' | 'simulated' | 'tags' | 'correlationId' | 'detail'>>;

let idCounter = 0;

/**
 * Monotonic within a process, so two findings created in the same millisecond
 * cannot collide — a real defect in the original per-agent implementations,
 * which used a bare `Date.now()`.
 */
export function newFindingId(prefix = 'f'): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}

/**
 * Identity for deduplication: the same problem, on the same thing, from the
 * same agent. Deliberately excludes severity and timestamps so that a
 * condition worsening updates one finding instead of creating a second.
 */
export function dedupeKeyFor(agent: string, kind: string, entity: Entity): string {
  return `${agent}::${kind}::${entity.type}:${entity.id}`;
}

/** Builds a complete, validated finding from the minimum an author must supply. */
export function createFinding(input: FindingInput, now: Date = new Date()): Finding {
  const ts = now.toISOString();
  const dedupeKey = dedupeKeyFor(input.agent, input.kind, input.entity);
  return FindingSchema.parse({
    ...input,
    id: newFindingId(),
    firstSeen: ts,
    lastSeen: ts,
    count: 1,
    dedupeKey,
  });
}

/**
 * Folds a recurrence into an existing finding: bumps the count, advances
 * `lastSeen`, keeps the original `firstSeen`, and takes the worse severity.
 *
 * Severity escalates but never de-escalates on its own — a condition that was
 * critical five minutes ago should not silently become "low" because the most
 * recent sample happened to be milder. Clearing is an explicit action, not a
 * side effect of the next poll.
 */
export function mergeFinding(existing: Finding, next: Finding): Finding {
  return {
    ...existing,
    severity: compareSeverity(next.severity, existing.severity) > 0 ? next.severity : existing.severity,
    lastSeen: next.lastSeen,
    count: existing.count + 1,
    evidence: { ...existing.evidence, ...next.evidence },
    // Once anything simulated has contributed, the finding stays marked.
    simulated: existing.simulated || next.simulated,
    detail: next.detail ?? existing.detail,
  };
}
