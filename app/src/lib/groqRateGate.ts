/**
 * Process-wide gate for Groq's free-tier audio quota.
 *
 * Groq caps free-tier Whisper at 7200 audio-seconds per rolling hour (ASPH).
 * Before this gate every scan pipeline called Groq independently: with 5 scan
 * jobs × 3 videos each, up to 15 requests raced for the same budget, most got
 * 429 + Retry-After 15-25 min, slept in place holding a scan slot, then woke
 * up simultaneously and stampeded again. Net effect: hours of wall-clock lost
 * and files erroring out after 12 futile retries.
 *
 * The gate makes the budget explicit on our side:
 *   - a sliding one-hour window of "booked" audio-seconds (we know each
 *     chunk's duration before sending, so we can book it up front);
 *   - a global concurrent-request cap so pipelines queue instead of racing;
 *   - shortest-first dispatch (a 40-min giant shouldn't starve twenty
 *     1-minute clips) with aging so long files still get through;
 *   - a global cooldown driven by Groq's Retry-After, so ONE 429 pauses
 *     everyone instead of each caller discovering the limit separately.
 *
 * All Groq traffic of this process must flow through acquireGroqSlot() —
 * transcription.ts is the single choke point that does it.
 */

const WINDOW_MS = 60 * 60 * 1000;
/** 1 second of queue wait forgives 4 seconds of file size when picking the next request. */
const AGING_CREDIT_PER_WAIT_SECOND = 4;

/**
 * Default budget deliberately below Groq's 7200: the Next.js app (audio
 * transcribe UI) shares the same API key from another container and its
 * usage is invisible to this process. The margin absorbs that.
 */
const DEFAULT_ASPH_BUDGET = 6600;
const DEFAULT_MAX_CONCURRENT = 3;

function budgetSeconds(): number {
  const v = Number(process.env.GROQ_ASPH_BUDGET);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_ASPH_BUDGET;
}

function maxConcurrent(): number {
  const v = Number(process.env.GROQ_MAX_CONCURRENT);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX_CONCURRENT;
}

interface UsageEntry {
  at: number;
  seconds: number;
}

interface Waiter {
  estimateSeconds: number;
  enqueuedAt: number;
  resolve: (slot: GroqSlot) => void;
}

export interface GroqSlot {
  /**
   * Call exactly once when the request finished. Pass refundQuota=true when
   * Groq did NOT count the audio (429, network error, 5xx) so the booked
   * seconds return to the budget immediately.
   */
  release(opts?: { refundQuota?: boolean }): void;
}

let usage: UsageEntry[] = [];
let activeRequests = 0;
let cooldownUntil = 0;
let queue: Waiter[] = [];
let wakeTimer: ReturnType<typeof setTimeout> | null = null;

function trimUsage(now: number): void {
  if (usage.length === 0) return;
  usage = usage.filter((e) => e.at > now - WINDOW_MS);
}

function usedSeconds(): number {
  return usage.reduce((sum, e) => sum + e.seconds, 0);
}

function scheduleWake(inMs: number): void {
  if (wakeTimer) clearTimeout(wakeTimer);
  const t = setTimeout(() => {
    wakeTimer = null;
    pump();
  }, Math.max(250, inMs));
  // Don't keep the worker process alive just for a queued wake-up.
  (t as { unref?: () => void }).unref?.();
  wakeTimer = t;
}

function pickWaiterIndex(now: number): number {
  let best = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let i = 0; i < queue.length; i += 1) {
    const w = queue[i];
    const ageCredit = ((now - w.enqueuedAt) / 1000) * AGING_CREDIT_PER_WAIT_SECOND;
    const score = w.estimateSeconds - ageCredit;
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  }
  return best;
}

/** Milliseconds until enough old bookings expire that `needed` seconds fit. */
function msUntilBudgetFrees(booked: number, needed: number, now: number): number {
  const sorted = [...usage].sort((a, b) => a.at - b.at);
  let freed = 0;
  for (const entry of sorted) {
    freed += entry.seconds;
    if (booked - freed + needed <= budgetSeconds()) {
      return Math.max(0, entry.at + WINDOW_MS - now);
    }
  }
  return WINDOW_MS;
}

function makeSlot(entry: UsageEntry): GroqSlot {
  let released = false;
  return {
    release(opts?: { refundQuota?: boolean }): void {
      if (released) return;
      released = true;
      activeRequests = Math.max(0, activeRequests - 1);
      if (opts?.refundQuota) {
        const i = usage.indexOf(entry);
        if (i >= 0) usage.splice(i, 1);
      }
      pump();
    },
  };
}

function pump(): void {
  if (wakeTimer) {
    clearTimeout(wakeTimer);
    wakeTimer = null;
  }
  for (;;) {
    if (queue.length === 0) return;
    const now = Date.now();
    trimUsage(now);

    if (now < cooldownUntil) {
      scheduleWake(cooldownUntil - now);
      return;
    }
    if (activeRequests >= maxConcurrent()) return; // a release() will re-pump

    const idx = pickWaiterIndex(now);
    const waiter = queue[idx];
    const booked = usedSeconds();
    // A single request larger than the whole budget can only ever go out on
    // an empty window — cap its requirement so it doesn't deadlock the queue.
    const needed = Math.min(waiter.estimateSeconds, budgetSeconds());
    if (booked + needed > budgetSeconds()) {
      scheduleWake(msUntilBudgetFrees(booked, needed, now));
      return;
    }

    queue.splice(idx, 1);
    const entry: UsageEntry = { at: now, seconds: waiter.estimateSeconds };
    usage.push(entry);
    activeRequests += 1;
    waiter.resolve(makeSlot(entry));
  }
}

/**
 * Wait until the request may be sent to Groq. Resolves with a slot that MUST
 * be released when the HTTP round-trip finishes (see GroqSlot.release).
 */
export function acquireGroqSlot(estimateSeconds: number): Promise<GroqSlot> {
  return new Promise<GroqSlot>((resolve) => {
    queue.push({
      estimateSeconds: Math.max(1, Math.round(estimateSeconds)),
      enqueuedAt: Date.now(),
      resolve,
    });
    pump();
  });
}

/**
 * Feed Groq's Retry-After back into the gate: pause ALL dispatches until the
 * cooldown passes. Call on every 429 regardless of which caller got it.
 */
export function reportGroqRateLimit(retryAfterSeconds: number): void {
  const until = Date.now() + Math.max(1, retryAfterSeconds) * 1000;
  if (until > cooldownUntil) cooldownUntil = until;
  pump();
}

/**
 * Rough answer to "if I ask for `estimateSeconds` now, how long will I wait?".
 * Accounts for the active cooldown, current bookings and everything already
 * queued ahead. Used to decide whether routing a file to the local Whisper
 * worker beats waiting for Groq quota.
 */
export function estimateGroqWaitSeconds(estimateSeconds: number): number {
  const now = Date.now();
  trimUsage(now);
  let waitMs = Math.max(0, cooldownUntil - now);

  const queuedAhead = queue.reduce((sum, w) => sum + w.estimateSeconds, 0);
  const total = usedSeconds() + queuedAhead + Math.min(estimateSeconds, budgetSeconds());
  if (total > budgetSeconds()) {
    const over = total - budgetSeconds();
    const sorted = [...usage].sort((a, b) => a.at - b.at);
    let freed = 0;
    let budgetWaitMs = WINDOW_MS;
    for (const entry of sorted) {
      freed += entry.seconds;
      if (freed >= over) {
        budgetWaitMs = Math.max(0, entry.at + WINDOW_MS - now);
        break;
      }
    }
    waitMs = Math.max(waitMs, budgetWaitMs);
  }
  return Math.round(waitMs / 1000);
}

/** Test hook — wipes all gate state. */
export function _resetGroqGateForTests(): void {
  usage = [];
  activeRequests = 0;
  cooldownUntil = 0;
  queue = [];
  if (wakeTimer) {
    clearTimeout(wakeTimer);
    wakeTimer = null;
  }
}
