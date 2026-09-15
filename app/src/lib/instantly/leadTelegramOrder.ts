/** The single Instantly worker prepares concurrently; only Telegram sends serialize.
 * Durable delivery/outbox rows remain authoritative after a restart.
 */
type LeadResult = { sent: boolean; messageId: number | null; error: string | null };
type LeadJob = { send: (late: boolean) => Promise<LeadResult>; done: (r: LeadResult) => void };
type HandoffJob = { send: (parent: number) => Promise<number | null>; done: (id: number | null) => void };
type Pair = { lead?: LeadJob; handoff?: HandoffJob; scheduled?: boolean; timer: ReturnType<typeof setTimeout> };
const pending = new Map<string, Pair>();
const tails = new Map<string, Promise<void>>();
const WAIT_MS = 10_000;

function enqueue(chat: string, work: () => Promise<void>): void {
  const next = (tails.get(chat) ?? Promise.resolve()).then(work).catch(() => {});
  tails.set(chat, next);
  void next.finally(() => { if (tails.get(chat) === next) tails.delete(chat); });
}

function flush(key: string, chat: string): void {
  const pair = pending.get(key);
  if (!pair || pair.scheduled) return;
  pair.scheduled = true;
  clearTimeout(pair.timer);
  enqueue(chat, async () => {
    pending.delete(key);
    let parent: number | null = null;
    if (pair.lead) {
      let result: LeadResult;
      try { result = await pair.lead.send(!pair.handoff); }
      catch { result = { sent: false, messageId: null, error: 'Telegram lead send failed' }; }
      parent = result.sent ? result.messageId : null;
      pair.lead.done(result);
    }
    if (pair.handoff) {
      // Never orphan a handoff when the parent alert failed or did not arrive.
      let id: number | null = null;
      try { if (parent) id = await pair.handoff.send(parent); } catch { /* durable retry */ }
      pair.handoff.done(id);
    }
  });
}

function getPair(key: string, chat: string): Pair {
  const existing = pending.get(key);
  if (existing) return existing;
  const pair: Pair = { timer: setTimeout(() => flush(key, chat), WAIT_MS) };
  pending.set(key, pair);
  return pair;
}

export function sendOrderedLead(chat: string, qualificationId: string,
  send: LeadJob['send'], expectHandoff: boolean): Promise<LeadResult> {
  return new Promise((done) => {
    const key = chat + ':' + qualificationId;
    const pair = getPair(key, chat);
    if (pair.lead) { done({ sent: false, messageId: null, error: 'Lead send already queued' }); return; }
    pair.lead = { send, done };
    if (pair.handoff || !expectHandoff) flush(key, chat);
  });
}

export function sendOrderedHandoff(chat: string, qualificationId: string,
  send: HandoffJob['send'], parentId?: number | null): Promise<number | null> {
  return new Promise((done) => {
    if (parentId) {
      enqueue(chat, async () => {
        try { done(await send(parentId)); } catch { done(null); }
      });
      return;
    }
    const key = chat + ':' + qualificationId;
    const pair = getPair(key, chat);
    if (pair.handoff) { done(null); return; }
    pair.handoff = { send, done };
    if (pair.lead) flush(key, chat);
  });
}
