/** @jest-environment node */

/**
 * Инцидент 18-19.08.2026: пять TG-кампаний простояли 16 часов, показывая в
 * интерфейсе «running».
 *
 * Механика: start-джоба помечается completed только в `.finally()` цикла
 * кампании, поэтому `running` означает «цикл жив в этом процессе». Процесс
 * перезапустился в 21:20, finally не выполнился, пять джоб остались `running`
 * навсегда. Авто-резюм каждые пять минут видел активную start-джобу, решал, что
 * старт уже запланирован, и не делал ничего — 319 раз подряд. Сброс на старте
 * (resetStuckJobs) в тот раз не отработал: он игнорировал ошибку запроса, а
 * перезапуск совпал с морганием базы.
 */

import { selectOrphanedStartJobs, type StartJobRow } from '@/lib/tgOutreach/watchdog';

const NOW = Date.parse('2026-08-19T10:00:00.000Z');
const GRACE = 2 * 60_000;

const job = (over: Partial<StartJobRow> = {}): StartJobRow => ({
  id: 'job-1',
  campaign_id: 'camp-1',
  started_at: new Date(NOW - 60 * 60_000).toISOString(),
  ...over,
});

describe('selectOrphanedStartJobs', () => {
  it('забирает джобу, чья кампания не живёт в процессе', () => {
    const orphans = selectOrphanedStartJobs({
      jobs: [job()],
      liveCampaignIds: new Set(),
      now: NOW,
      graceMs: GRACE,
    });
    expect(orphans.map((j) => j.id)).toEqual(['job-1']);
  });

  it('не трогает живую джобу — её кампания есть в памяти', () => {
    const orphans = selectOrphanedStartJobs({
      jobs: [job()],
      liveCampaignIds: new Set(['camp-1']),
      now: NOW,
      graceMs: GRACE,
    });
    expect(orphans).toEqual([]);
  });

  it('щадит только что захваченную джобу: кампания ещё регистрируется', () => {
    // Между захватом джобы и записью в runningCampaigns идут чтение кампании,
    // старт трейса и апдейт trace_spans. Тик, попавший в это окно, не должен
    // счесть стартующую кампанию сиротой и запустить её второй раз.
    const orphans = selectOrphanedStartJobs({
      jobs: [job({ started_at: new Date(NOW - 5_000).toISOString() })],
      liveCampaignIds: new Set(),
      now: NOW,
      graceMs: GRACE,
    });
    expect(orphans).toEqual([]);
  });

  it('забирает джобу без started_at — такую уже некому доводить', () => {
    const orphans = selectOrphanedStartJobs({
      jobs: [job({ started_at: null })],
      liveCampaignIds: new Set(),
      now: NOW,
      graceMs: GRACE,
    });
    expect(orphans).toHaveLength(1);
  });

  it('забирает джобу с битой датой, а не молча её пропускает', () => {
    const orphans = selectOrphanedStartJobs({
      jobs: [job({ started_at: 'не дата' })],
      liveCampaignIds: new Set(),
      now: NOW,
      graceMs: GRACE,
    });
    expect(orphans).toHaveLength(1);
  });

  it('разбирает реальный случай: пять джоб, ни одной живой кампании', () => {
    const jobs = ['ATOL-1', 'Polza_test', 'Polza_Старые', 'TG_VBI', 'TG_Roistat'].map((c, i) =>
      job({ id: `job-${i}`, campaign_id: c }),
    );
    const orphans = selectOrphanedStartJobs({
      jobs,
      liveCampaignIds: new Set(),
      now: NOW,
      graceMs: GRACE,
    });
    expect(orphans).toHaveLength(5);
  });

  it('в смешанном наборе забирает только сирот', () => {
    const orphans = selectOrphanedStartJobs({
      jobs: [
        job({ id: 'live', campaign_id: 'camp-live' }),
        job({ id: 'orphan', campaign_id: 'camp-dead' }),
      ],
      liveCampaignIds: new Set(['camp-live']),
      now: NOW,
      graceMs: GRACE,
    });
    expect(orphans.map((j) => j.id)).toEqual(['orphan']);
  });
});
