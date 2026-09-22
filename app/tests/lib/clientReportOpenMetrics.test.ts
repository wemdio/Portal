/** @jest-environment node */

/**
 * Открытия писем убраны из клиентского отчёта по кампаниям: трекинг-пиксель
 * недостоверен (Apple Mail Privacy, прокси Gmail, боты защитных шлюзов).
 * Единственное исключение — auto-режим (кабинет Mailganer), туда отчёт
 * приходит с includeOpens: true, пока метрику не переделают отдельно.
 *
 * Тест держит обе формы отчёта: важно, что в manual-варианте открытий нет
 * НИГДЕ — ни в шапке, ни в строках, ни в итогах, ни в summary, — иначе цифра
 * утечёт клиенту через CSV, даже если из UI её убрали.
 */

import { buildClientReport } from '@/lib/tools/instantlyCampaignCatalog';
import { shouldShowOpenMetrics } from '@/lib/clientOpenMetrics';

const ROWS = [
  {
    id: 'c1',
    name: 'Кампания А',
    new_leads_contacted_count: 100,
    emails_sent_count: 300,
    contacted_count: 100,
    open_count: 90,
    open_count_unique: 50,
    reply_count: 12,
    reply_count_unique: 8,
    reply_count_automatic_unique: 2,
    leads_count: 4,
    bounced_count: 3,
  },
] as unknown as Parameters<typeof buildClientReport>[0];

describe('buildClientReport — метрики открытий', () => {
  it('по умолчанию не отдаёт открытия ни в одной части отчёта', () => {
    const report = buildClientReport(ROWS);

    expect(report.tableText).not.toContain('Открыт');
    expect(report.csvText).not.toContain('Открыт');
    expect(report.rows[0]).toEqual([
      'Дата', 'Кампания', 'Контактов', 'Отправлено писем',
      'Ответов', '% ответов', 'Браков',
    ]);
    expect(report.summary.totalOpened).toBeUndefined();
    expect(report.summary.conversion.openPctAllEmails).toBeUndefined();
    // Остальные метрики на месте: убрали открытия, а не отчёт целиком.
    expect(report.summary.totalReplies).toBe(10);
    expect(report.summary.conversion.replyPctByLeads).toBe('10.0');
  });

  it('с includeOpens отдаёт открытия по уникальным контактам', () => {
    const report = buildClientReport(ROWS, { includeOpens: true });

    expect(report.rows[0]).toContain('Открытий');
    expect(report.rows[0]).toContain('% открытий');
    expect(report.summary.totalOpened).toBe(50);
    // 50 уникальных открытий ÷ 100 контактов — ставка на КОНТАКТ, не на письмо.
    expect(report.summary.conversion.openPctAllEmails).toBe('50.0');
  });

  it('открытия показываются только auto-режиму', () => {
    expect(shouldShowOpenMetrics('auto')).toBe(true);
    expect(shouldShowOpenMetrics('manual')).toBe(false);
  });
});
