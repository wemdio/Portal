/** @jest-environment node */
/**
 * Монитор сендера (5.7/5.8): правила «что считать проблемой» — чистые функции
 * без БД и телеграма. Пороги меняются редко, а ошибиться в них легко: слишком
 * чувствительный алерт превращается в спам, слишком толстый — в молчание.
 */

jest.mock('server-only', () => ({}));
jest.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: null }));
jest.mock('@/lib/loggerServer', () => ({ logError: jest.fn(), logInfo: jest.fn() }));

import { DEFAULT_THRESHOLDS, evaluateSenderHealth, type MonitorMetrics } from '@/lib/sender/monitorWorker';

const BASE: MonitorMetrics = {
  sentLastHour: 12,
  dueScheduled: 3,
  oldestDueMinutes: 4,
  failedMailboxesLastHour: 0,
  domains: [],
};

describe('отправка стоит', () => {
  it('ни одного письма за час при назревшей очереди — алерт', () => {
    const { alerts } = evaluateSenderHealth(
      { ...BASE, sentLastHour: 0, dueScheduled: 20, oldestDueMinutes: 90 },
      DEFAULT_THRESHOLDS,
    );
    const stalled = alerts.find((a) => a.key === 'send_stalled');
    expect(stalled).toBeDefined();
    expect(stalled?.lines.join(' ')).toContain('90');
  });

  it('пара хвостовых писем после остановки кампании — не алерт', () => {
    const { alerts } = evaluateSenderHealth(
      { ...BASE, sentLastHour: 0, dueScheduled: 2 },
      DEFAULT_THRESHOLDS,
    );
    expect(alerts.find((a) => a.key === 'send_stalled')).toBeUndefined();
  });

  it('отправка идёт — не алерт, сколько бы ни стояло в очереди', () => {
    const { alerts } = evaluateSenderHealth(
      { ...BASE, sentLastHour: 40, dueScheduled: 900 },
      DEFAULT_THRESHOLDS,
    );
    expect(alerts.find((a) => a.key === 'send_stalled')).toBeUndefined();
    // но глубокая очередь при живой отправке — отдельное предупреждение
    expect(alerts.find((a) => a.key === 'queue_depth')).toBeDefined();
  });
});

describe('автопауза домена по bounce rate', () => {
  const domains = (sent: number, bounced: number) => [{ domain: 'x.ru', sent, bounced }];

  it('высокий отбой при достаточном объёме — домен на паузу и алерт', () => {
    const { alerts, pauseDomains } = evaluateSenderHealth(
      { ...BASE, domains: domains(100, 15) },
      DEFAULT_THRESHOLDS,
    );
    expect(pauseDomains).toHaveLength(1);
    expect(pauseDomains[0].rate).toBeCloseTo(0.15);
    expect(alerts.find((a) => a.key === 'domain_bounce:x.ru')).toBeDefined();
  });

  it('малый объём не считается: три отбоя из пяти — шум, не приговор', () => {
    const { alerts, pauseDomains } = evaluateSenderHealth(
      { ...BASE, domains: domains(5, 3) },
      DEFAULT_THRESHOLDS,
    );
    expect(pauseDomains).toHaveLength(0);
    expect(alerts.find((a) => a.key === 'domain_bounce:x.ru')).toBeUndefined();
  });

  it('здоровый домен не трогаем', () => {
    const { pauseDomains } = evaluateSenderHealth(
      { ...BASE, domains: domains(200, 4) },
      DEFAULT_THRESHOLDS,
    );
    expect(pauseDomains).toHaveLength(0);
  });
});

describe('ящики отваливаются', () => {
  it('упавшие за час считаются алертом', () => {
    const { alerts } = evaluateSenderHealth({ ...BASE, failedMailboxesLastHour: 3 }, DEFAULT_THRESHOLDS);
    expect(alerts.find((a) => a.key === 'mailboxes_failed')).toBeDefined();
  });
});
