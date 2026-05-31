/**
 * Per-source token bucket + circuit breaker.
 *
 * Used by `PromptProxyEngine.collectAugmentedSections()` to keep a single
 * misbehaving augment source (memory ingestion blowing up, peer SQLite
 * hammering, KG infinite loop) from dragging every prompt's latency.
 *
 * Each named source gets:
 *   - a token bucket (configurable RPS) so we don't fan out faster than
 *     the user's disk can keep up;
 *   - a counter of consecutive failures.  After `threshold` failures the
 *     breaker opens and skips the source until `cooldownMs` elapses.
 *
 * The class is process-local — for fleet-level coordination, wire its
 * counters out via the existing `MetricsRegistry`.
 */

export interface BreakerConfig {
  ratePerSec: number;
  failureThreshold: number;
  cooldownMs: number;
}

interface SourceState {
  tokens: number;
  lastRefill: number;
  consecutiveFailures: number;
  openUntil: number;
}

export class AugmentBreaker {
  private readonly states = new Map<string, SourceState>();
  private readonly capacity: number;

  constructor(private readonly cfg: BreakerConfig) {
    this.capacity = Math.max(1, Math.ceil(cfg.ratePerSec));
  }

  /** Returns true when the source should be skipped this turn. */
  shouldSkip(source: string): boolean {
    const state = this.ensure(source);
    const now = Date.now();
    if (state.openUntil > now) { return true; }
    this.refill(state, now);
    if (state.tokens < 1) { return true; }
    state.tokens -= 1;
    return false;
  }

  /** Mark a successful invocation — resets consecutive failure counter. */
  recordSuccess(source: string): void {
    const state = this.ensure(source);
    state.consecutiveFailures = 0;
    state.openUntil = 0;
  }

  /** Mark a failed invocation — may trip the breaker. */
  recordFailure(source: string): void {
    const state = this.ensure(source);
    state.consecutiveFailures += 1;
    if (state.consecutiveFailures >= this.cfg.failureThreshold) {
      state.openUntil = Date.now() + this.cfg.cooldownMs;
    }
  }

  /** Snapshot for diagnostics / health surface. */
  snapshot(): Record<string, { failures: number; openForMs: number }> {
    const now = Date.now();
    const out: Record<string, { failures: number; openForMs: number }> = {};
    for (const [name, state] of this.states.entries()) {
      out[name] = {
        failures: state.consecutiveFailures,
        openForMs: Math.max(0, state.openUntil - now),
      };
    }
    return out;
  }

  private ensure(source: string): SourceState {
    let state = this.states.get(source);
    if (!state) {
      state = {
        tokens: this.capacity,
        lastRefill: Date.now(),
        consecutiveFailures: 0,
        openUntil: 0,
      };
      this.states.set(source, state);
    }
    return state;
  }

  private refill(state: SourceState, now: number): void {
    const elapsedSec = (now - state.lastRefill) / 1000;
    if (elapsedSec <= 0) { return; }
    const refill = elapsedSec * this.cfg.ratePerSec;
    state.tokens = Math.min(this.capacity, state.tokens + refill);
    state.lastRefill = now;
  }
}
