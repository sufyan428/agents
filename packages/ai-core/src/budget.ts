/**
 * Local spend control.
 *
 * This exists because the AI layer polls unattended. The original design made
 * a model call whenever anything looked anomalous, and one permanently
 * unreachable device meant a call every 60 seconds forever. On a metered key
 * that is a bill; on a free key it is a daily quota gone by breakfast.
 *
 * Rolling 24h windows rather than calendar days, so a burst at 23:50 cannot be
 * doubled by waiting ten minutes.
 */
export interface BudgetSnapshot {
  callsUsed: number;
  callsLimit: number;
  tokensUsed: number;
  tokensLimit: number;
  windowResetsAt: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class Budget {
  private calls: number[] = [];
  private tokens: Array<{ at: number; n: number }> = [];

  constructor(
    private readonly callLimit: number,
    private readonly tokenLimit: number,
    private readonly now: () => number = Date.now,
  ) {}

  private prune(): void {
    const cutoff = this.now() - DAY_MS;
    // Both arrays are append-only in time order, so a prefix drop is enough.
    let i = 0;
    while (i < this.calls.length && (this.calls[i] as number) < cutoff) i++;
    if (i > 0) this.calls = this.calls.slice(i);

    let j = 0;
    while (j < this.tokens.length && (this.tokens[j] as { at: number }).at < cutoff) j++;
    if (j > 0) this.tokens = this.tokens.slice(j);
  }

  /** True when another call is permitted right now. */
  canSpend(): boolean {
    if (this.callLimit === 0) return false;
    this.prune();
    if (this.calls.length >= this.callLimit) return false;
    if (this.tokenLimit > 0 && this.totalTokens() >= this.tokenLimit) return false;
    return true;
  }

  /** Records a call. Call this before the request, so failures still count. */
  recordCall(): void {
    this.calls.push(this.now());
  }

  recordTokens(n: number): void {
    if (n > 0) this.tokens.push({ at: this.now(), n });
  }

  private totalTokens(): number {
    return this.tokens.reduce((sum, t) => sum + t.n, 0);
  }

  snapshot(): BudgetSnapshot {
    this.prune();
    const oldest = this.calls[0];
    return {
      callsUsed: this.calls.length,
      callsLimit: this.callLimit,
      tokensUsed: this.totalTokens(),
      tokensLimit: this.tokenLimit,
      windowResetsAt: oldest === undefined ? null : new Date(oldest + DAY_MS).toISOString(),
    };
  }
}

/**
 * Opens after repeated failures so a dead endpoint is not hammered every
 * polling cycle, and closes again after a cooldown.
 *
 * Auth failures are treated as permanently open until the process restarts or
 * a caller explicitly resets: a wrong API key will not become right by being
 * retried every two minutes, and retrying it just fills the logs.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | null = null;
  private permanent = false;

  constructor(
    private readonly threshold: number,
    private readonly cooldownMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get isOpen(): boolean {
    if (this.permanent) return true;
    if (this.openedAt === null) return false;
    if (this.now() - this.openedAt >= this.cooldownMs) {
      // Half-open: allow one probe through.
      this.openedAt = null;
      this.failures = this.threshold - 1;
      return false;
    }
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = null;
  }

  recordFailure(permanent = false): void {
    if (permanent) {
      this.permanent = true;
      return;
    }
    this.failures++;
    if (this.failures >= this.threshold) this.openedAt = this.now();
  }

  reset(): void {
    this.failures = 0;
    this.openedAt = null;
    this.permanent = false;
  }

  get state(): 'closed' | 'open' | 'permanently_open' {
    if (this.permanent) return 'permanently_open';
    return this.openedAt === null ? 'closed' : 'open';
  }
}
