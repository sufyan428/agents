import {
  createFinding, mergeFinding, dedupeKeyFor,
  type Finding, type FindingInput, type Severity,
} from '@ragent/agent-protocol';

/**
 * Per-agent store of active findings.
 *
 * Every agent keeps its own; agent6 collects them over HTTP and correlates
 * across all of them. That is what turns ten agents reporting separately into
 * one system with a shared view.
 *
 * The important behaviour is that a recurring condition updates one finding
 * rather than creating a new one each poll. Without that, the correlation
 * engine downstream sees a thousand findings for one ongoing problem and
 * groups noise instead of incidents.
 */

export interface FindingStoreOptions {
  /** Distinct active findings kept before the oldest is evicted. */
  maxActive?: number;
  /** Silence after which an unrefreshed finding is considered resolved. */
  resolveAfterMs?: number;
  /** Resolved findings retained for history. */
  maxResolved?: number;
}

export interface ResolvedFinding {
  dedupeKey: string;
  finding: Finding;
  resolvedAt: string;
  reason: string;
  durationMs: number;
}

export class FindingStore {
  private readonly active = new Map<string, Finding>();
  private resolved: ResolvedFinding[] = [];
  private readonly maxActive: number;
  private readonly resolveAfterMs: number;
  private readonly maxResolved: number;

  constructor({ maxActive = 500, resolveAfterMs = 300_000, maxResolved = 200 }: FindingStoreOptions = {}) {
    this.maxActive = maxActive;
    this.resolveAfterMs = resolveAfterMs;
    this.maxResolved = maxResolved;
  }

  /**
   * Records a finding, merging into an existing one for the same condition.
   *
   * Returns the stored finding and whether this was the first occurrence, so
   * the caller can decide whether it is worth notifying about.
   */
  report(input: FindingInput, now: Date = new Date()): { finding: Finding; isNew: boolean } {
    const candidate = createFinding(input, now);
    const existing = this.active.get(candidate.dedupeKey);

    if (existing) {
      const merged = mergeFinding(existing, candidate);
      this.active.set(merged.dedupeKey, merged);
      return { finding: merged, isNew: false };
    }

    if (this.active.size >= this.maxActive) {
      const oldest = this.active.keys().next().value as string | undefined;
      if (oldest !== undefined) this.active.delete(oldest);
    }
    this.active.set(candidate.dedupeKey, candidate);
    return { finding: candidate, isNew: true };
  }

  /** Explicitly clears a condition the agent knows has recovered. */
  clear(agent: string, kind: string, entity: Finding['entity'], reason = 'condition_cleared', now: Date = new Date()): boolean {
    return this.clearByKey(dedupeKeyFor(agent, kind, entity), reason, now);
  }

  clearByKey(dedupeKey: string, reason = 'condition_cleared', now: Date = new Date()): boolean {
    const finding = this.active.get(dedupeKey);
    if (!finding) return false;
    this.active.delete(dedupeKey);
    this.pushResolved({
      dedupeKey,
      finding,
      resolvedAt: now.toISOString(),
      reason,
      durationMs: now.getTime() - new Date(finding.firstSeen).getTime(),
    });
    return true;
  }

  /**
   * Resolves findings that have stopped recurring.
   *
   * Call on a timer. An agent that only ever reports problems starting, never
   * ending, leaves an operator unable to tell a current incident from an
   * historical one.
   */
  sweep(now: Date = new Date()): ResolvedFinding[] {
    const out: ResolvedFinding[] = [];
    for (const [key, finding] of [...this.active]) {
      const silentFor = now.getTime() - new Date(finding.lastSeen).getTime();
      if (silentFor >= this.resolveAfterMs) {
        this.active.delete(key);
        const entry: ResolvedFinding = {
          dedupeKey: key,
          finding,
          resolvedAt: now.toISOString(),
          reason: 'stopped_recurring',
          durationMs: new Date(finding.lastSeen).getTime() - new Date(finding.firstSeen).getTime(),
        };
        this.pushResolved(entry);
        out.push(entry);
      }
    }
    return out;
  }

  private pushResolved(entry: ResolvedFinding): void {
    this.resolved.push(entry);
    if (this.resolved.length > this.maxResolved) {
      this.resolved = this.resolved.slice(-this.maxResolved);
    }
  }

  /** Active findings, most severe first. */
  list(minSeverity?: Severity): Finding[] {
    const rank: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
    const floor = minSeverity ? rank[minSeverity] : -1;
    return [...this.active.values()]
      .filter((f) => rank[f.severity] >= floor)
      .sort((a, b) => rank[b.severity] - rank[a.severity] || b.count - a.count);
  }

  recentlyResolved(limit = 50): ResolvedFinding[] {
    return this.resolved.slice(-limit);
  }

  get activeCount(): number { return this.active.size; }

  /** True if any active finding came from a simulated path. */
  get hasSimulated(): boolean {
    for (const f of this.active.values()) if (f.simulated) return true;
    return false;
  }

  summary(): { active: number; bySeverity: Record<string, number>; simulated: boolean } {
    const bySeverity: Record<string, number> = {};
    for (const f of this.active.values()) {
      bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
    }
    return { active: this.active.size, bySeverity, simulated: this.hasSimulated };
  }

  reset(): void {
    this.active.clear();
    this.resolved = [];
  }
}

/**
 * Mounts GET /api/findings on an agent.
 *
 * Uniform across every agent so agent6 can poll one path rather than knowing
 * each agent's individual shape - which is exactly the coupling the shared
 * protocol package exists to remove.
 */
export function mountFindingsRoute(
  app: { get: (path: string, handler: (req: unknown, res: { json: (body: unknown) => void }) => void) => void },
  store: FindingStore,
  agentName: string,
): void {
  app.get('/api/findings', (_req, res) => {
    res.json({
      success: true,
      agent: agentName,
      generatedAt: new Date().toISOString(),
      summary: store.summary(),
      findings: store.list(),
      recentlyResolved: store.recentlyResolved(20),
    });
  });
}
