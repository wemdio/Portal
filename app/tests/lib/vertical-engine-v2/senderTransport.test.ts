/** @jest-environment node */

/**
 * Запуски VE2 через «Рассылку» (решение владельца 24.10.2026): куда идёт
 * запуск, как это записывается и как статусы «Рассылки» читаются проверками
 * подачи контактов. Единственный файл тестов этой работы — согласован с
 * владельцем 24.10.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { parseLaunchInfo } from '@/lib/verticalEngineV2/launchHandoff';
import {
  decideVeLaunchTransport,
  resolveVeLaunchTransport,
  senderRemoteStatus,
  transportOf,
} from '@/lib/verticalEngineV2/senderTransport/transport';

/** База с одним проектом и настройками рынка. */
function transportDb(project: Record<string, unknown> | null, settings: Record<string, unknown> | null, failSettings = false): SupabaseClient {
  return {
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => {
          if (table === 've_projects') return { data: project, error: null };
          if (failSettings) return { data: null, error: { message: 'нет таблицы' } };
          return { data: settings, error: null };
        },
      };
      return chain;
    },
  } as unknown as SupabaseClient;
}

describe('куда идёт запуск VE2', () => {
  it('instantly главнее переопределения проекта, pilot — только переопределённым, sender — всем, кроме исключённых', () => {
    const decide = (mode: unknown, override: unknown) => decideVeLaunchTransport({ killed: false, mode, override }).transport;
    expect(decide('instantly', 'sender')).toBe('instantly');
    expect(decide('pilot', 'sender')).toBe('sender');
    expect(decide('pilot', null)).toBe('instantly');
    expect(decide('sender', null)).toBe('sender');
    expect(decide('sender', 'instantly')).toBe('instantly');
    expect(decide('что-то', 'sender')).toBe('instantly');
    expect(decideVeLaunchTransport({ killed: true, mode: 'sender', override: 'sender' }).transport).toBe('instantly');
  });

  it('ошибка чтения, нет настроек или выключатель в окружении — Instantly', async () => {
    const project = { market: 'ru', launch_transport_override: 'sender' };
    expect(await resolveVeLaunchTransport(transportDb(project, { mode: 'sender' }), 'p1', {})).toEqual({ transport: 'sender', source: 'market' });
    expect((await resolveVeLaunchTransport(transportDb(project, null), 'p1', {})).transport).toBe('instantly');
    expect((await resolveVeLaunchTransport(transportDb(project, { mode: 'sender' }, true), 'p1', {})).source).toBe('error');
    expect((await resolveVeLaunchTransport(transportDb(null, { mode: 'sender' }), 'p1', {})).source).toBe('error');
    expect(await resolveVeLaunchTransport(transportDb(project, { mode: 'sender' }), 'p1', { VE2_SENDER_LAUNCHES_DISABLED: '1' }))
      .toEqual({ transport: 'instantly', source: 'env_kill' });
  });

  it('запуск помнит «Рассылку», старые записи и Instantly читаются как Instantly', () => {
    const base = { campaign_id: 'c1', campaign_name: 'К', campaign_url: '', leads_count: 0, preset_id: 'p', created_at: '' };
    expect(parseLaunchInfo({ ...base, transport: 'sender' })?.transport).toBe('sender');
    expect(parseLaunchInfo(base)?.transport).toBeUndefined();
    expect(transportOf(parseLaunchInfo({ ...base, transport: 'instantly' })?.transport)).toBe('instantly');
  });

  it('статусы «Рассылки» в числах Instantly: остановленная — «завершена» (3), по ней очередь отпускает запуск', () => {
    expect(['draft', 'running', 'paused', 'done'].map(senderRemoteStatus)).toEqual([0, 1, 2, 3]);
    expect(() => senderRemoteStatus('archived')).toThrow();
  });
});
