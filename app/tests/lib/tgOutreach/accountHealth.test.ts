/** @jest-environment node */

/**
 * Здоровье рассылки и прокси в строке аккаунта.
 *
 * Проверяем не «функция что-то вернула», а порядок причин: именно он делает
 * колонку полезной. Выключенный аккаунт не должен объясняться прокси, а мёртвая
 * сессия не должна прятаться за кулдауном, который пройдёт сам.
 */

import {
  describeSending,
  describeProxy,
  countSendingAccounts,
  daysWord,
  type HealthAccount,
  type HealthProxy,
} from '@/lib/tgOutreach/accountHealth';

const NOW = new Date('2026-08-27T12:00:00.000Z').getTime();
const HOUR = 3_600_000;
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

const account = (over: Partial<HealthAccount> = {}): HealthAccount => ({
  id: 'a1',
  is_active: true,
  cooldown_until: null,
  check_status: 'ok',
  proxy_id: 'p1',
  ...over,
});

const proxy = (over: Partial<HealthProxy> = {}): HealthProxy => ({
  is_active: true,
  consecutive_errors: 0,
  last_error_at: null,
  last_error_reason: null,
  cooldown_until: null,
  last_used_at: iso(NOW - HOUR),
  total_uses: 100,
  total_errors: 2,
  ...over,
});

const ctx = (over: Partial<Parameters<typeof describeSending>[0]> = {}) => ({
  account: account(),
  stat: { account_id: 'a1', last_sent_at: iso(NOW - HOUR), sent_24h: 12 },
  proxy: proxy(),
  campaignRunning: true,
  firstTouchEnabled: true,
  now: NOW,
  ...over,
});

describe('describeSending', () => {
  it('отправки за сутки есть — рассылает', () => {
    const mark = describeSending(ctx());
    expect(mark.tone).toBe('ok');
    expect(mark.label).toContain('рассылает');
    expect(mark.label).toContain('12');
  });

  it('выключенный аккаунт объясняется выключением, а не прокси', () => {
    // Иначе оператор чинил бы прокси у аккаунта, который всё равно не берут.
    const mark = describeSending(ctx({
      account: account({ is_active: false }),
      proxy: proxy({ is_active: false }),
      stat: { account_id: 'a1', last_sent_at: iso(NOW - 3 * DAY), sent_24h: 0 },
    }));
    expect(mark.tone).toBe('bad');
    expect(mark.label).toBe('выключен');
    expect(mark.days).toBe(3);
  });

  it('мёртвая сессия важнее кулдауна: кулдаун пройдёт сам, сессия — нет', () => {
    const mark = describeSending(ctx({
      account: account({ check_status: 'session_revoked', cooldown_until: iso(NOW + HOUR) }),
      stat: { account_id: 'a1', last_sent_at: null, sent_24h: 0 },
    }));
    expect(mark.tone).toBe('bad');
    expect(mark.label).toBe('сессия мертва');
  });

  it('кулдаун Telegram — временно, поэтому предупреждение, а не поломка', () => {
    const mark = describeSending(ctx({
      account: account({ cooldown_until: iso(NOW + 2 * HOUR) }),
      stat: { account_id: 'a1', last_sent_at: iso(NOW - 5 * HOUR), sent_24h: 0 },
    }));
    expect(mark.tone).toBe('warn');
    expect(mark.label).toBe('на паузе');
  });

  it('истёкший кулдаун состояние не объясняет', () => {
    const mark = describeSending(ctx({ account: account({ cooldown_until: iso(NOW - HOUR) }) }));
    expect(mark.tone).toBe('ok');
  });

  it('без прокси рассылать не через что', () => {
    const mark = describeSending(ctx({
      account: account({ proxy_id: null }),
      proxy: null,
      stat: { account_id: 'a1', last_sent_at: null, sent_24h: 0 },
    }));
    expect(mark.tone).toBe('bad');
    expect(mark.label).toBe('нет прокси');
  });

  it('мёртвый прокси называется прокси, а не молчанием аккаунта', () => {
    const mark = describeSending(ctx({
      proxy: proxy({ cooldown_until: iso(NOW + 20 * 60_000), last_error_reason: 'connect_timeout' }),
      stat: { account_id: 'a1', last_sent_at: iso(NOW - 2 * DAY), sent_24h: 0 },
    }));
    expect(mark.tone).toBe('bad');
    expect(mark.label).toBe('прокси не работает');
  });

  it('сбоящий прокси рассылку не отменяет — она может идти', () => {
    const mark = describeSending(ctx({ proxy: proxy({ consecutive_errors: 2 }) }));
    expect(mark.tone).toBe('ok');
  });

  it('выключенное первое касание — не поломка аккаунта', () => {
    const mark = describeSending(ctx({
      firstTouchEnabled: false,
      stat: { account_id: 'a1', last_sent_at: iso(NOW - 4 * DAY), sent_24h: 0 },
    }));
    expect(mark.tone).toBe('unknown');
    expect(mark.label).toBe('касание выключено');
  });

  it('остановленная кампания — тоже не поломка аккаунта', () => {
    const mark = describeSending(ctx({
      campaignRunning: false,
      stat: { account_id: 'a1', last_sent_at: iso(NOW - 4 * DAY), sent_24h: 0 },
    }));
    expect(mark.tone).toBe('unknown');
    expect(mark.label).toBe('кампания стоит');
  });

  it('запретов нет, а отправок нет вторые сутки — это поломка', () => {
    // Худший случай: всё «зелёное», а людям никто не пишет.
    const mark = describeSending(ctx({
      stat: { account_id: 'a1', last_sent_at: iso(NOW - 3 * DAY), sent_24h: 0 },
    }));
    expect(mark.tone).toBe('bad');
    expect(mark.label).toBe('молчит 3 дня');
    expect(mark.days).toBe(3);
  });

  it('молчит меньше двух суток — ещё предупреждение', () => {
    const mark = describeSending(ctx({
      stat: { account_id: 'a1', last_sent_at: iso(NOW - 30 * HOUR), sent_24h: 0 },
    }));
    expect(mark.tone).toBe('warn');
  });

  it('никогда не отправлял — отдельная формулировка, а не «молчит 0 дней»', () => {
    const mark = describeSending(ctx({ stat: undefined }));
    expect(mark.label).toBe('ещё не рассылал');
    expect(mark.days).toBeNull();
  });
});

describe('describeProxy', () => {
  it('прокси прошёл круг — работает', () => {
    expect(describeProxy(proxy(), NOW).tone).toBe('ok');
  });

  it('отлёжка — считаем дни от последнего успешного круга, не от ошибки', () => {
    // Ошибка повторяется каждый круг и всегда свежая; оператору нужен ответ
    // «когда через него в последний раз что-то прошло».
    const mark = describeProxy(proxy({
      cooldown_until: iso(NOW + 10 * 60_000),
      last_error_at: iso(NOW - 60_000),
      last_used_at: iso(NOW - 4 * DAY),
    }), NOW);
    expect(mark.tone).toBe('bad');
    expect(mark.days).toBe(4);
    expect(mark.label).toBe('не работает 4 дня');
  });

  it('счётчик ошибок без отлёжки — предупреждение', () => {
    const mark = describeProxy(proxy({ consecutive_errors: 2, last_error_reason: 'tcp_dead' }), NOW);
    expect(mark.tone).toBe('warn');
    expect(mark.label).toBe('сбоит · 2');
    expect(mark.detail).toContain('не отвечает совсем');
  });

  it('ни одного круга — «не проверялся», а не «работает»', () => {
    const mark = describeProxy(proxy({ last_used_at: null, total_uses: 0 }), NOW);
    expect(mark.tone).toBe('unknown');
  });

  it('прокси нет вовсе', () => {
    expect(describeProxy(null, NOW).tone).toBe('bad');
  });
});

describe('countSendingAccounts', () => {
  it('считает тех, от кого за сутки что-то ушло, а не включённых галочкой', () => {
    const accounts = [account({ id: 'a1' }), account({ id: 'a2' }), account({ id: 'a3' })];
    const stats = {
      a1: { account_id: 'a1', last_sent_at: iso(NOW - HOUR), sent_24h: 5 },
      a2: { account_id: 'a2', last_sent_at: iso(NOW - 3 * DAY), sent_24h: 0 },
    };
    expect(countSendingAccounts(accounts, stats)).toBe(1);
  });
});

describe('daysWord', () => {
  it('склоняет по-русски', () => {
    expect(daysWord(1)).toBe('1 день');
    expect(daysWord(3)).toBe('3 дня');
    expect(daysWord(5)).toBe('5 дней');
    expect(daysWord(11)).toBe('11 дней');
    expect(daysWord(21)).toBe('21 день');
  });
});
