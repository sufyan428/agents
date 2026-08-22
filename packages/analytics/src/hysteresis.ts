/**
 * Hysteresis and flap damping.
 *
 * A single threshold with a value sitting on top of it produces an alarm that
 * raises and clears on alternate samples. At a 30s poll that is 120 state
 * changes an hour from one condition that never actually changed. The same
 * mechanism applied to failover is worse than noisy: a link hovering at the
 * decision boundary will fail over, fail back, and fail over again, and each
 * transition costs real packets.
 *
 * Every alarm system that survives contact with production has two properties
 * this framework lacked:
 *
 *   Separate raise and clear thresholds, so leaving a state is harder than
 *   entering it and a value on the boundary cannot oscillate.
 *
 *   Consecutive-sample requirements, so a single bad reading - a dropped SNMP
 *   packet, one slow poll - does not trigger anything on its own.
 */

export type AlarmState = 'clear' | 'raised';

export interface HysteresisOptions {
  /** Crossing this begins the raise. */
  raiseAt: number;
  /**
   * Falling below this begins the clear. Must be strictly below raiseAt for
   * anything above the boundary; the gap between them IS the hysteresis.
   */
  clearAt: number;
  /** Consecutive breaching samples required before raising. */
  raiseAfter?: number;
  /** Consecutive non-breaching samples required before clearing. */
  clearAfter?: number;
  /**
   * When true, low values are the problem: raise when below raiseAt, clear
   * when above clearAt. For metrics like available bandwidth or uptime.
   */
  inverted?: boolean;
}

export interface HysteresisResult {
  state: AlarmState;
  /** True only on the sample where the state actually changed. */
  changed: boolean;
  /** Consecutive samples currently pushing toward the opposite state. */
  progress: number;
  /** How many are needed to get there. */
  required: number;
  value: number;
}

export class Hysteresis {
  private readonly raiseAt: number;
  private readonly clearAt: number;
  private readonly raiseAfter: number;
  private readonly clearAfter: number;
  private readonly inverted: boolean;

  private _state: AlarmState = 'clear';
  private streak = 0;
  private _raisedAt: number | null = null;

  constructor(opts: HysteresisOptions) {
    const { raiseAt, clearAt, raiseAfter = 2, clearAfter = 3, inverted = false } = opts;

    // Getting this backwards silently produces an alarm that never clears, so
    // it is rejected outright rather than left to be discovered in production.
    if (!inverted && clearAt >= raiseAt) {
      throw new RangeError(
        `clearAt (${clearAt}) must be below raiseAt (${raiseAt}); the gap is the hysteresis`,
      );
    }
    if (inverted && clearAt <= raiseAt) {
      throw new RangeError(
        `for an inverted alarm, clearAt (${clearAt}) must be above raiseAt (${raiseAt})`,
      );
    }

    this.raiseAt = raiseAt;
    this.clearAt = clearAt;
    this.raiseAfter = Math.max(1, raiseAfter);
    this.clearAfter = Math.max(1, clearAfter);
    this.inverted = inverted;
  }

  get state(): AlarmState {
    return this._state;
  }
  get isRaised(): boolean {
    return this._state === 'raised';
  }
  /** Epoch ms of the current raise, or null while clear. */
  get raisedAt(): number | null {
    return this._raisedAt;
  }

  private breaching(value: number): boolean {
    return this.inverted ? value < this.raiseAt : value > this.raiseAt;
  }

  private clearing(value: number): boolean {
    return this.inverted ? value > this.clearAt : value < this.clearAt;
  }

  /** Feeds one sample and reports the resulting state. */
  update(value: number, now: number = Date.now()): HysteresisResult {
    if (!Number.isFinite(value)) {
      return {
        state: this._state,
        changed: false,
        progress: this.streak,
        required: this._state === 'clear' ? this.raiseAfter : this.clearAfter,
        value,
      };
    }

    let changed = false;

    if (this._state === 'clear') {
      if (this.breaching(value)) {
        this.streak += 1;
        if (this.streak >= this.raiseAfter) {
          this._state = 'raised';
          this._raisedAt = now;
          this.streak = 0;
          changed = true;
        }
      } else {
        // Any non-breaching sample resets progress. A condition has to be
        // sustained, not merely frequent.
        this.streak = 0;
      }
    } else {
      if (this.clearing(value)) {
        this.streak += 1;
        if (this.streak >= this.clearAfter) {
          this._state = 'clear';
          this._raisedAt = null;
          this.streak = 0;
          changed = true;
        }
      } else {
        this.streak = 0;
      }
    }

    return {
      state: this._state,
      changed,
      progress: this.streak,
      required: this._state === 'clear' ? this.raiseAfter : this.clearAfter,
      value,
    };
  }

  reset(): void {
    this._state = 'clear';
    this.streak = 0;
    this._raisedAt = null;
  }
}

export interface FlapDetectorOptions {
  /** Transitions within the window before the entity is called flapping. */
  threshold?: number;
  windowMs?: number;
  /** Once flapping, stay suppressed at least this long after it settles. */
  cooldownMs?: number;
}

/**
 * Detects an entity changing state too often to be believed.
 *
 * A link that has bounced six times in five minutes is not six incidents, it
 * is one: a flapping link. Reporting each transition buries the actual finding
 * under its own symptoms, and if failover is wired to those transitions it
 * will follow the link up and down.
 *
 * While flapping, callers should suppress per-transition actions and report
 * the flap itself instead.
 */
export class FlapDetector {
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly cooldownMs: number;
  private transitions: number[] = [];
  private flappingSince: number | null = null;
  private lastTransition = 0;

  constructor({
    threshold = 4,
    windowMs = 300_000,
    cooldownMs = 300_000,
  }: FlapDetectorOptions = {}) {
    this.threshold = threshold;
    this.windowMs = windowMs;
    this.cooldownMs = cooldownMs;
  }

  /** Records a state change. Returns true if the entity is now flapping. */
  recordTransition(now: number = Date.now()): boolean {
    this.transitions.push(now);
    this.lastTransition = now;
    this.prune(now);
    if (this.transitions.length >= this.threshold && this.flappingSince === null) {
      this.flappingSince = now;
    }
    return this.isFlapping(now);
  }

  isFlapping(now: number = Date.now()): boolean {
    this.prune(now);
    if (this.flappingSince === null) return false;
    // Stay flagged through the cooldown, so a brief pause mid-flap does not
    // release the suppression and let the next bounce through.
    if (this.transitions.length < this.threshold && now - this.lastTransition >= this.cooldownMs) {
      this.flappingSince = null;
      return false;
    }
    return true;
  }

  get transitionCount(): number {
    return this.transitions.length;
  }
  get since(): number | null {
    return this.flappingSince;
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    let i = 0;
    while (i < this.transitions.length && (this.transitions[i] as number) < cutoff) i++;
    if (i > 0) this.transitions = this.transitions.slice(i);
  }

  reset(): void {
    this.transitions = [];
    this.flappingSince = null;
    this.lastTransition = 0;
  }
}
