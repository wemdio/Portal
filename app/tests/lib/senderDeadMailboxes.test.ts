/** @jest-environment node */
/**
 * Упавшие ящики «Рассылки»: когда перепроверять вход, какой сбой временный,
 * и что делать с лидами, закреплёнными за ящиком, который не поднимается.
 */

jest.mock('server-only', () => ({}));

import type { SupabaseClient } from '@supabase/supabase-js';
import { createMockSupabase } from '../helpers/mockSupabase';
import {
  planDeadMailboxRelease,
  releaseDeadMailboxRecipients,
  RELEASE_UNWRITTEN_AFTER_MS,
  STOP_CHAIN_AFTER_MS,
} from '@/lib/sender/deadMailboxes';
import { isTransientCheckFailure, nextRecheckAt, STOP_RECHECK_AFTER_MS } from '@/lib/sender/mailboxRecheck';
import { classifySmtpError } from '@/lib/sender/smtp';

const NOW = Date.parse('2026-10-23T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const HOUR = 3600_000;

describe('перепроверка упавшего ящика', () => {
  it('идёт по лестнице 1 ч → 3 ч → 6 ч → 12 ч и через неделю останавливается', () => {
    const failedAt = ago(HOUR);
    const delay = (attempts: number) => Date.parse(nextRecheckAt(attempts, failedAt, NOW)!) - NOW;
    expect([1, 2, 3, 4, 9].map(delay)).toEqual([HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, 12 * HOUR]);
    expect(nextRecheckAt(5, ago(STOP_RECHECK_AFTER_MS), NOW)).toBeNull();
  });

  it('провайдер занят или сеть моргнула — не поломка ящика; неверный пароль — поломка', () => {
    expect(isTransientCheckFailure('temporary')).toBe(true);
    expect(isTransientCheckFailure('network')).toBe(true);
    expect(isTransientCheckFailure('auth')).toBe(false);
    expect(isTransientCheckFailure(undefined)).toBe(false);
  });

  it('4xx на входе — временный отказ входа, а не неверный пароль', () => {
    const err = (message: string, responseCode: number) => Object.assign(new Error(message), { responseCode });
    expect(classifySmtpError(err('Invalid login: 421 4.4.5 Server busy, try again later', 421))).toBe('auth_temporary');
    expect(classifySmtpError(err('Invalid login: 454 4.7.0 Too many login attempts', 454))).toBe('auth_temporary');
    expect(isTransientCheckFailure('auth_temporary')).toBe(true);
    expect(classifySmtpError(err('451 4.3.0 Temporary local problem', 451))).toBe('temporary');
    expect(classifySmtpError(err('Invalid login: 534-5.7.14 Please log in via your web browser', 534))).toBe('auth');
    expect(classifySmtpError(err('Invalid login: 535 5.7.8 authentication failed', 535))).toBe('auth');
  });
});

describe('лиды упавшего ящика', () => {
  const box = (id: string, downMs: number) => ({ id, email: `${id}@x.ru`, failed_at: ago(downMs) });
  const lead = (id: string, mailboxId: string, lastStep: number) => ({
    id, campaign_id: 'c1', email: `${id}@lead.ru`, mailbox_id: mailboxId, last_step_sent: lastStep,
  });

  it('кому не писали — другой ящик через 30 минут; через 3 дня — конец цепочки всем, кого не отдали', () => {
    const boxes = [box('fresh', 10 * 60_000), box('down', RELEASE_UNWRITTEN_AFTER_MS + 1), box('dead', STOP_CHAIN_AFTER_MS + 1)];
    const { release, stop } = planDeadMailboxRelease(boxes, [
      lead('a', 'fresh', 0),
      lead('b', 'down', 0),
      lead('c', 'down', 2),
      lead('d', 'dead', 0),
      lead('e', 'dead', 3),
    ], NOW);
    expect(release.map((r) => r.id)).toEqual(['b', 'd']);
    expect(stop.map((r) => r.id)).toEqual(['d', 'e']);
  });

  it('откреплённому лиду письмо первого шага убирается, а ушедшее или неясное не трогается', async () => {
    const db = createMockSupabase({
      tables: {
        sender_mailboxes: [{ id: 'm1', email: 'm1@x.ru', status: 'failed', failed_at: ago(HOUR) }],
        sender_recipients: [
          { id: 'r1', campaign_id: 'c1', email: 'r1@lead.ru', mailbox_id: 'm1', last_step_sent: 0, status: 'active', next_step_at: null },
          { id: 'r2', campaign_id: 'c1', email: 'r2@lead.ru', mailbox_id: 'm1', last_step_sent: 0, status: 'active', next_step_at: ago(HOUR) },
          { id: 'r3', campaign_id: 'c1', email: 'r3@lead.ru', mailbox_id: 'm1', last_step_sent: 0, status: 'active', next_step_at: null },
        ],
        sender_messages: [
          { id: 's1', recipient_id: 'r1', step_no: 1, status: 'scheduled' },
          { id: 's3', recipient_id: 'r3', step_no: 1, status: 'unknown' },
        ],
      },
    });

    const result = await releaseDeadMailboxRecipients({ db: db as unknown as SupabaseClient, now: NOW });

    expect(result).toEqual({ released: 2, stopped: 0 });
    const recipients = db.getRows('sender_recipients');
    expect(recipients.find((r) => r.id === 'r1')).toMatchObject({ mailbox_id: null });
    expect(recipients.find((r) => r.id === 'r2')).toMatchObject({ mailbox_id: null });
    expect(recipients.find((r) => r.id === 'r3')).toMatchObject({ mailbox_id: 'm1' });
    expect(db.getRows('sender_messages').map((m) => m.id)).toEqual(['s3']);
  });

  it('цепочка лида мёртвого ящика завершается: стоп-лист кампании с причиной, «стоп», письма отменены', async () => {
    const db = createMockSupabase({
      tables: {
        sender_mailboxes: [{ id: 'm1', email: 'm1@x.ru', status: 'failed', failed_at: ago(STOP_CHAIN_AFTER_MS + HOUR) }],
        sender_recipients: [
          { id: 'r1', campaign_id: 'c1', email: 'r1@lead.ru', mailbox_id: 'm1', last_step_sent: 2, status: 'active', next_step_at: null },
        ],
        sender_messages: [{ id: 's1', recipient_id: 'r1', step_no: 3, status: 'scheduled' }],
        sender_campaign_suppressions: [],
      },
    });

    const result = await releaseDeadMailboxRecipients({ db: db as unknown as SupabaseClient, now: NOW });

    expect(result).toEqual({ released: 0, stopped: 1 });
    expect(db.getRows('sender_campaign_suppressions')).toEqual([
      expect.objectContaining({ campaign_id: 'c1', email: 'r1@lead.ru', reason: 'mailbox_lost' }),
    ]);
    expect(db.getRows('sender_recipients')[0]).toMatchObject({ status: 'stopped', next_step_at: null });
    expect(db.getRows('sender_messages')[0]).toMatchObject({ status: 'canceled' });
  });

  it('лид, чьё первое письмо отвергнуто, не переезжает на другой ящик, а через 3 дня завершается', async () => {
    const db = createMockSupabase({
      tables: {
        sender_mailboxes: [{ id: 'm1', email: 'm1@x.ru', status: 'failed', failed_at: ago(STOP_CHAIN_AFTER_MS + HOUR) }],
        sender_recipients: [
          { id: 'r1', campaign_id: 'c1', email: 'r1@lead.ru', mailbox_id: 'm1', last_step_sent: 0, status: 'active', next_step_at: null },
          { id: 'r2', campaign_id: 'c1', email: 'r2@lead.ru', mailbox_id: 'm1', last_step_sent: 0, status: 'active', next_step_at: null },
        ],
        sender_messages: [
          { id: 's1', recipient_id: 'r1', step_no: 1, status: 'failed' },
          { id: 's2', recipient_id: 'r2', step_no: 1, status: 'scheduled' },
        ],
        sender_campaign_suppressions: [],
      },
    });

    const result = await releaseDeadMailboxRecipients({ db: db as unknown as SupabaseClient, now: NOW });

    expect(result).toEqual({ released: 1, stopped: 1 });
    expect(db.getRows('sender_recipients').find((r) => r.id === 'r1')).toMatchObject({ status: 'stopped', mailbox_id: 'm1' });
    expect(db.getRows('sender_recipients').find((r) => r.id === 'r2')).toMatchObject({ status: 'active', mailbox_id: null });
    expect(db.getRows('sender_campaign_suppressions').map((r) => r.email)).toEqual(['r1@lead.ru']);
  });
});
