/** @jest-environment node */

import fs from 'fs';
import path from 'path';
import { createMockSupabase } from '@/../tests/helpers/mockSupabase';
import {
  claimProjectCampaignLinks,
  describePortalProjectTerm,
  findManualFactIssue,
  LAUNCHABLE_PORTAL_PROJECT_STATUSES,
  localIsoDate,
  PORTAL_TERM_TEXT,
} from '@/lib/verticalEngineV2/portalDeliveryTerm';

// Реальные карточки проектов без периодов с прода (23.09.2026).
const STAFF_LINE = {
  id: '837cbcb1-9afb-49c9-965c-d83d1e7d8e9c',
  client: 'Staff Line',
  name: 'Аутрич',
  status: 'В работе',
  deadline: '2026-09-30',
  launch_date: '2026-08-30',
  contacts_obligation: '4000',
  contacts_done: '25905',
};
const TODAY = '2026-09-23';
// The same cases drive the SQL smoke of ve_try_iso_date: TS and SQL must read a card deadline alike.
const DEADLINE_CASES = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../helpers/projectDeadlineCases.json'), 'utf8'),
) as { accepted: Array<[string, string]>; rejected: string[] };

describe('project card deadline formats', () => {
  it.each(DEADLINE_CASES.accepted)('plans a deadline typed as %j up to %s', (raw, iso) => {
    expect(describePortalProjectTerm({ ...STAFF_LINE, deadline: raw }, [], { today: TODAY })).toMatchObject({ ok: true, deadline: iso });
  });

  it.each(DEADLINE_CASES.rejected)('rejects %j as not a date', (raw) => {
    expect(describePortalProjectTerm({ ...STAFF_LINE, deadline: raw }, [], { today: TODAY })).toEqual({
      ok: false,
      code: 'PROJECT_DEADLINE_INVALID',
      error: PORTAL_TERM_TEXT.deadlineInvalid(raw.trim()),
    });
  });

  it('compares a DD.MM.YY deadline with today as a date, not as text', () => {
    expect(describePortalProjectTerm({ ...STAFF_LINE, deadline: '22.09.26' }, [], { today: TODAY })).toEqual({
      ok: false,
      code: 'PROJECT_DEADLINE_PASSED',
      error: 'Дедлайн проекта (22.09.2026) уже прошёл. Обновите поле «Дедлайн» в карточке проекта.',
    });
  });
});

describe('Portal project term without periods', () => {
  it('lets Staff Line launch although its accumulated fact is far above the obligation', () => {
    expect(describePortalProjectTerm(STAFF_LINE, [], { today: TODAY })).toEqual({
      ok: true,
      deadline: '2026-09-30',
      startsAt: '2026-08-30',
      obligationText: '4000',
      factTotal: 25905,
    });
  });

  it.each([
    ['a range obligation', '8000-16000'],
    ['an empty obligation', ''],
    ['a missing obligation', null],
  ])('does not parse or block on %s', (_name, obligation) => {
    const term = describePortalProjectTerm({ ...STAFF_LINE, client: 'Мекомо (ДАНИ)', contacts_obligation: obligation }, [], { today: TODAY });
    expect(term).toMatchObject({ ok: true, obligationText: obligation || null });
  });

  it('names the «Дедлайн» field when the card has no deadline (ENagency)', () => {
    const term = describePortalProjectTerm({ ...STAFF_LINE, client: 'ENagency', deadline: null, contacts_obligation: null, contacts_done: '6360' }, []);
    expect(term).toEqual({ ok: false, code: 'PROJECT_DEADLINE_REQUIRED', error: PORTAL_TERM_TEXT.deadlineRequired });
    expect(PORTAL_TERM_TEXT.deadlineRequired).toBe(
      'В карточке проекта не заполнено поле «Дедлайн». Укажите дату в формате ГГГГ-ММ-ДД — темп рассчитается до неё.',
    );
  });

  it('rejects a deadline that is not an ISO date and a deadline that has passed', () => {
    const notDate = describePortalProjectTerm({ ...STAFF_LINE, deadline: '05.18.2026' }, [], { today: TODAY });
    expect(notDate).toMatchObject({ ok: false, code: 'PROJECT_DEADLINE_INVALID' });
    expect(!notDate.ok && notDate.error).toContain('«Дедлайн»');
    expect(!notDate.ok && notDate.error).toBe(
      'В карточке проекта в поле «Дедлайн» указана не дата («05.18.2026»). Укажите дату в формате ГГГГ-ММ-ДД — темп рассчитается до неё.',
    );
    expect(describePortalProjectTerm({ ...STAFF_LINE, deadline: '2026-02-30' }, [])).toMatchObject({ code: 'PROJECT_DEADLINE_INVALID' });

    const passed = describePortalProjectTerm({ ...STAFF_LINE, deadline: '2026-09-22' }, [], { today: TODAY });
    expect(passed).toMatchObject({ ok: false, code: 'PROJECT_DEADLINE_PASSED' });
    expect(!passed.ok && passed.error).toBe('Дедлайн проекта (22.09.2026) уже прошёл. Обновите поле «Дедлайн» в карточке проекта.');
    // The deadline day itself is still a working day of the plan.
    expect(describePortalProjectTerm({ ...STAFF_LINE, deadline: TODAY }, [], { today: TODAY }).ok).toBe(true);
  });

  it('asks to open a new period when every period is closed', () => {
    expect(describePortalProjectTerm(STAFF_LINE, [{ id: 'p1', status: 'closed' }, { id: 'p2', status: 'closed' }]))
      .toEqual({
        ok: false,
        code: 'PORTAL_PERIODS_CLOSED',
        error: 'Все периоды проекта закрыты. Откройте новый период в карточке проекта.',
      });
  });

  it('distinguishes a period created after a no-period launch from a fresh choice', () => {
    const periods = [{ id: 'p1', status: 'active' }];
    // Seen only when the page's project list is stale: choosing again reuses it, so ask for a reload.
    expect(describePortalProjectTerm(STAFF_LINE, periods)).toEqual({
      ok: false,
      code: 'PORTAL_PROJECT_HAS_ACTIVE_PERIOD',
      error: 'У проекта уже есть активный период. Обновите страницу — запуск привяжется к периоду.',
    });
    expect(describePortalProjectTerm(STAFF_LINE, periods, { bound: true })).toEqual({
      ok: false,
      code: 'PORTAL_PERIOD_CREATED_AFTER_LAUNCH',
      error: PORTAL_TERM_TEXT.periodCreatedAfterLaunch,
    });
  });

  it('blocks a project that is no longer in work', () => {
    const term = describePortalProjectTerm({ ...STAFF_LINE, status: 'Завершен' }, [], { today: TODAY });
    expect(term).toEqual({
      ok: false,
      code: 'PORTAL_PROJECT_NOT_IN_WORK',
      error: 'Проект в Portal не в работе (статус «Завершен»). Верните рабочий статус в карточке проекта.',
    });
  });

  it('warns a running plan that a card fix resumes it only while its campaigns are unfinished', () => {
    const note = 'Загрузка продолжится сама, если к этому времени кампании плана ещё не завершились; иначе понадобится новый запуск.';
    expect(PORTAL_TERM_TEXT.boundResumeNote).toBe(note);
    expect(describePortalProjectTerm({ ...STAFF_LINE, status: 'Завершен' }, [], { today: TODAY, bound: true })).toEqual({
      ok: false,
      code: 'PORTAL_PROJECT_NOT_IN_WORK',
      error: `Проект в Portal не в работе (статус «Завершен»). Верните рабочий статус в карточке проекта. ${note}`,
    });
    expect(describePortalProjectTerm({ ...STAFF_LINE, deadline: '2026-09-22' }, [], { today: TODAY, bound: true })).toEqual({
      ok: false,
      code: 'PROJECT_DEADLINE_PASSED',
      error: `Дедлайн проекта (22.09.2026) уже прошёл. Обновите поле «Дедлайн» в карточке проекта. ${note}`,
    });
    expect(describePortalProjectTerm({ ...STAFF_LINE, deadline: null }, [], { bound: true })).toEqual({
      ok: false,
      code: 'PROJECT_DEADLINE_REQUIRED',
      error: `${PORTAL_TERM_TEXT.deadlineRequired} ${note}`,
    });
    expect(describePortalProjectTerm({ ...STAFF_LINE, deadline: '05.18.2026' }, [], { bound: true })).toMatchObject({
      code: 'PROJECT_DEADLINE_INVALID',
      error: `${PORTAL_TERM_TEXT.deadlineInvalid('05.18.2026')} ${note}`,
    });
    // A period that appeared is final for this plan: no resume promise at all.
    expect(describePortalProjectTerm(STAFF_LINE, [{ id: 'p1', status: 'active' }], { bound: true })).toMatchObject({
      error: PORTAL_TERM_TEXT.periodCreatedAfterLaunch,
    });
    expect(PORTAL_TERM_TEXT.periodCreatedAfterLaunch).not.toContain('продолжится сама');
  });

  it('computes the business date in the delivery timezone', () => {
    expect(localIsoDate(new Date('2026-09-23T21:30:00.000Z'), 'Europe/Moscow')).toBe('2026-09-24');
    expect(localIsoDate(new Date('2026-09-23T21:30:00.000Z'), 'UTC')).toBe('2026-09-23');
  });
});

describe('manual contacts fact guard', () => {
  function instantly(links: Array<{ project_id: string; campaign_id: string }>) {
    return createMockSupabase({ tables: { project_instantly_campaigns: links } });
  }
  const LAW_RUSSIA = { id: 'law-russia', contacts_done: '10860' };

  it('blocks a hand-kept fact without campaign links (Law Russia 10860)', async () => {
    const issue = await findManualFactIssue(instantly([{ project_id: 'other', campaign_id: 'c' }]) as never, LAW_RUSSIA);
    expect(issue).toEqual({
      ok: false,
      code: 'PORTAL_PROJECT_MANUAL_FACT',
      error: PORTAL_TERM_TEXT.manualFact((10860).toLocaleString('ru-RU')),
    });
    expect(issue?.error).toContain('ручное число пропадёт');
  });

  it.each([['empty', ''], ['missing', null], ['zero', '0']])('allows a %s fact without links', async (_name, fact) => {
    const db = instantly([]);
    await expect(findManualFactIssue(db as never, { id: 'wolly', contacts_done: fact })).resolves.toBeNull();
    expect(db.selects).toHaveLength(0);
  });

  it('allows a fact already counted from linked campaigns', async () => {
    await expect(findManualFactIssue(
      instantly([{ project_id: STAFF_LINE.id, campaign_id: 'campaign-1' }]) as never,
      STAFF_LINE,
    )).resolves.toBeNull();
  });

  it('fails closed when the links cannot be read', async () => {
    const db = createMockSupabase({ errorTables: { project_instantly_campaigns: 'instantly db down' } });
    await expect(findManualFactIssue(db as never, LAW_RUSSIA)).rejects.toThrow('instantly db down');
  });
});

describe('project campaign links without a period', () => {
  const claimed = { status: 'claimed' as const, conflictingProjectIds: [] as string[] };

  it('claims nothing when the batch check already finds a conflict', async () => {
    const check = jest.fn(async () => [{ campaignId: 'campaign-b', conflictingProjectIds: ['other'] }]);
    const claim = jest.fn(async () => claimed);
    await expect(claimProjectCampaignLinks({} as never, STAFF_LINE.id, ['campaign-a', 'campaign-b'], 'reason', { check, claim }))
      .resolves.toEqual([{ campaignId: 'campaign-b', conflictingProjectIds: ['other'] }]);
    expect(claim).not.toHaveBeenCalled();
  });

  it('stops at a conflict that appears between the check and the claim', async () => {
    const check = jest.fn(async () => []);
    const claim = jest.fn()
      .mockResolvedValueOnce(claimed)
      .mockResolvedValueOnce({ status: 'conflict', conflictingProjectIds: ['other'] });
    await expect(claimProjectCampaignLinks({} as never, STAFF_LINE.id, ['campaign-a', 'campaign-b', 'campaign-c'], 'reason', { check, claim }))
      .resolves.toEqual([{ campaignId: 'campaign-b', conflictingProjectIds: ['other'] }]);
    expect(claim).toHaveBeenCalledTimes(2);
    expect(claim.mock.calls[0][1]).toEqual({
      projectId: STAFF_LINE.id, campaignId: 'campaign-a', matchSource: 'manual', periodId: null,
      matchConfidence: 1, matchReason: 'reason', replaceAutomatic: false,
    });
  });

  it('lets a failed claim surface as an error', async () => {
    const claim = jest.fn(async () => { throw new Error('campaign ownership claim failed: down'); });
    await expect(claimProjectCampaignLinks({} as never, STAFF_LINE.id, ['campaign-a'], 'reason', { check: jest.fn(async () => []), claim }))
      .rejects.toThrow('campaign ownership claim failed: down');
  });
});

describe('launchable statuses', () => {
  it('match the literal in the SQL term function', () => {
    const sql = fs.readFileSync(
      path.resolve(__dirname, '../../../../supabase/migrations/20260924_0010_ve_contact_delivery_without_period.sql'),
      'utf8',
    );
    const literal = /when p\.status in \(([^)]*)\) then\s/.exec(sql);
    expect(literal).not.toBeNull();
    const statuses = [...(literal as RegExpExecArray)[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
    expect(statuses).toEqual([...LAUNCHABLE_PORTAL_PROJECT_STATUSES]);
  });
});
