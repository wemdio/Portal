/** @jest-environment node */

import { createMockSupabase } from '@/../tests/helpers/mockSupabase';
import { AppendLeadsPartialError } from '@/lib/clientLaunch/appendLeads';
import { runContactDeliveryDay } from '@/lib/verticalEngineV2/contactDeliveryRunner';
import { loadVeContactDeliveryCampaignInventory } from '@/lib/verticalEngineV2/contactDeliveryInventory';
import { activateDeliveredContactCampaigns } from '@/lib/verticalEngineV2/contactDeliveryActivation';

jest.mock('@/lib/verticalEngineV2/contactDeliveryActivation', () => ({
  activateDeliveredContactCampaigns: jest.fn(),
}));
const activateDelivered = jest.mocked(activateDeliveredContactCampaigns);

beforeEach(() => {
  activateDelivered.mockReset().mockResolvedValue({ activated: 0, errors: [] });
});

const VE_PROJECT_ID = '10000000-0000-0000-0000-000000000001';
const PORTAL_PROJECT_ID = '20000000-0000-0000-0000-000000000001';
const PERIOD_ID = '30000000-0000-0000-0000-000000000001';
const ITEM_ID = '40000000-0000-0000-0000-000000000001';
const RUN_ID = '50000000-0000-0000-0000-000000000001';
const ATTEMPT_ID = '60000000-0000-0000-0000-000000000001';

function portalDb(options: { replayAfterFirst?: boolean; awaitingDelivery?: boolean; capacityBlocked?: boolean; twoBatches?: boolean } = {}) {
  let reserveCalls = 0;
  return createMockSupabase({
    tables: {
      ve_projects: [{
        id: VE_PROJECT_ID,
        portal_project_id: PORTAL_PROJECT_ID,
        portal_period_id: PERIOD_ID,
        target_contacts: 23,
        delivery_schedule_days: [1, 2, 3, 4, 5],
        delivery_timezone: 'Europe/Moscow',
        sender_daily_capacity: 10,
        launch_preset_id: 'preset-1',
        launch_instantly_account_id: 'workspace-1',
      }],
      project_periods: [{
        id: PERIOD_ID,
        project_id: PORTAL_PROJECT_ID,
        status: 'active',
        contacts_done: '10',
        deadline: '2026-09-11',
      }],
      // A closed period and an identically named unrelated project must never
      // become an implicit fallback for the explicit binding above.
      projects: [
        { id: PORTAL_PROJECT_ID, client: 'Одинаковый клиент' },
        { id: '20000000-0000-0000-0000-000000000099', client: 'Одинаковый клиент' },
      ],
      ve_launch_queue_items: [{
        id: ITEM_ID,
        project_id: VE_PROJECT_ID,
        status: 'active',
      }, {
        id: 'released-item',
        project_id: VE_PROJECT_ID,
        status: 'released',
      }],
      ve_launch_queue_campaigns: [
        { id: 'child-1', item_id: ITEM_ID, campaign_id: 'campaign-a' },
        { id: 'child-2', item_id: ITEM_ID, campaign_id: 'campaign-b' },
        { id: 'child-3', item_id: 'released-item', campaign_id: 'campaign-old' },
      ],
    },
    rpcHandlers: {
      ve_reserve_contact_delivery_day: () => {
        reserveCalls += 1;
        if (options.capacityBlocked) return { data: { status: 'capacity_blocked', run_id: RUN_ID, run_date: '2026-09-07', batches: [] } };
        if (options.awaitingDelivery) {
          return { data: { status: 'awaiting_delivery', run_id: RUN_ID, run_date: '2026-09-07', batches: [] } };
        }
        if (options.replayAfterFirst && reserveCalls > 1) {
          return { data: { status: 'replayed', run_id: RUN_ID, run_date: '2026-09-07', batches: [] } };
        }
        return {
          data: {
            status: 'reserved',
            run_id: RUN_ID,
            run_date: '2026-09-07',
            batches: [
              {
                campaign_id: 'campaign-a',
                row_ids: ['row-1', 'row-2'],
                leads: [{ email: 'one@example.test' }, { email: 'two@example.test' }],
              },
              ...(options.twoBatches ? [{ campaign_id: 'campaign-b', row_ids: ['row-3'], leads: [{ email: 'three@example.test' }] }] : []),
            ],
          },
        };
      },
      ve_mark_contact_delivery_attempt: () => ({ data: { marked: true } }),
      ve_finalize_contact_delivery_capacity: () => ({ data: { finalized: true } }),
      ve_finalize_contact_delivery_attempt: () => ({ data: { finalized: true } }),
    },
  });
}

function instantlyDb(workspace = 'workspace-1') {
  return createMockSupabase({
    tables: {
      client_campaign_presets: [{ id: 'preset-1', client_user_id: 'client-user-1', instantly_account_id: workspace }],
      instantly_campaign_catalog: [
        { id: 'campaign-a', new_leads_contacted_count: 3 },
        { id: 'campaign-old', new_leads_contacted_count: '7' },
      ],
    },
  });
}

describe('VE2 contact delivery runner', () => {
  it('uses the explicit Portal project, active period and complete child campaign set before reserving rows', async () => {
    const portal = portalDb();
    const instantly = instantlyDb();
    activateDelivered.mockImplementationOnce(async () => {
      if (portal.rpcCalls.at(-1)?.fn !== 've_finalize_contact_delivery_attempt') {
        throw new Error('campaign must not start before exact accepted rows are persisted');
      }
      return { activated: 1, errors: [] };
    });
    const reserveOwnership = jest.fn(async () => ({
      status: 'claimed' as const,
      conflictingProjectIds: [],
    }));
    const appendLeads = jest.fn(async () => ({
      accepted: 2,
      skipped: 0,
      attemptedIndexes: [0, 1],
      acceptedIndexes: [0, 1],
      identityComplete: true,
    }));

    const result = await runContactDeliveryDay({
      portalDb: portal as never,
      instantlyDb: instantly as never,
      veProjectId: VE_PROJECT_ID,
      now: new Date('2026-09-07T06:00:00.000Z'),
      deps: { reservePeriodCampaignLinks: reserveOwnership, appendLeads, createAttemptId: () => ATTEMPT_ID },
    });

    expect(result).toMatchObject({ status: 'completed', accepted: 2, runId: RUN_ID });
    expect(activateDelivered).toHaveBeenCalledWith({ portalDb: portal, veProjectId: VE_PROJECT_ID });
    expect(reserveOwnership).toHaveBeenCalledWith(
      instantly,
      PORTAL_PROJECT_ID,
      [
        expect.objectContaining({ periodId: PERIOD_ID, campaignId: 'campaign-a', baselineContacts: 0 }),
        expect.objectContaining({ periodId: PERIOD_ID, campaignId: 'campaign-b', baselineContacts: 0 }),
      ],
    );
    expect(portal.rpcCalls.map((call) => call.fn)).toEqual([
      've_reserve_contact_delivery_day',
      've_mark_contact_delivery_attempt',
      've_finalize_contact_delivery_attempt',
    ]);
    expect(portal.rpcCalls[0].params.p_observed_ve_first_contacted).toBe(10);
    expect(appendLeads).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'client-user-1',
      campaignId: 'campaign-a',
      leads: [{ email: 'one@example.test' }, { email: 'two@example.test' }],
      // Shared workspaces make Instantly's misleadingly named flag unsafe:
      // our row ledger owns idempotency without suppressing another client.
      skipIfInCampaign: false,
      entitlementMode: 'managed_contract',
      expectedInstantlyAccountId: 'workspace-1',
    }));
  });

  it('keeps attempted rows uncertain and never calls the provider twice on a same-day replay', async () => {
    const portal = portalDb({ replayAfterFirst: true });
    const instantly = instantlyDb();
    const reserveOwnership = jest.fn(async () => ({
      status: 'unchanged' as const,
      conflictingProjectIds: [],
    }));
    const appendLeads = jest.fn()
      .mockRejectedValueOnce(new AppendLeadsPartialError('provider timeout', {
        accepted: 0,
        skipped: 0,
        attemptedIndexes: [0],
        acceptedIndexes: [],
        identityComplete: true,
      }));
    const deps = { reservePeriodCampaignLinks: reserveOwnership, appendLeads, createAttemptId: () => ATTEMPT_ID };

    const first = await runContactDeliveryDay({
      portalDb: portal as never,
      instantlyDb: instantly as never,
      veProjectId: VE_PROJECT_ID,
      now: new Date('2026-09-07T06:00:00.000Z'),
      deps,
    });
    const replay = await runContactDeliveryDay({
      portalDb: portal as never,
      instantlyDb: instantly as never,
      veProjectId: VE_PROJECT_ID,
      now: new Date('2026-09-07T07:00:00.000Z'),
      deps,
    });

    expect(first.status).toBe('uncertain');
    expect(replay.status).toBe('replayed');
    expect(appendLeads).toHaveBeenCalledTimes(1);
    expect(activateDelivered).toHaveBeenCalledTimes(2);
    const finalize = portal.rpcCalls.findLast(
      (call) => call.fn === 've_finalize_contact_delivery_attempt',
    );
    expect(finalize?.params).toMatchObject({
      p_accepted_row_ids: [],
      p_skipped_row_ids: [],
      p_uncertain_row_ids: ['row-1'],
      p_released_row_ids: ['row-2'],
      p_error: 'provider timeout',
    });
  });

  it('does not send another batch while earlier uploads await first contact', async () => {
    const appendLeads = jest.fn();
    const result = await runContactDeliveryDay({
      portalDb: portalDb({ awaitingDelivery: true }) as never,
      instantlyDb: instantlyDb() as never,
      veProjectId: VE_PROJECT_ID,
      deps: {
        reservePeriodCampaignLinks: async () => ({ status: 'claimed', conflictingProjectIds: [] }),
        appendLeads,
        createAttemptId: () => ATTEMPT_ID,
      },
    });
    expect(result.status).toBe('awaiting_delivery');
    expect(appendLeads).not.toHaveBeenCalled();
  });

  it.each([{ source: 'local', attempted: [1] }, { source: 'workspace', attempted: [0, 1] }])(
    'terminally skips $source blocklist cuts instead of retrying them tomorrow', async ({ attempted }) => {
      const portal = portalDb();
      const result = await runContactDeliveryDay({
        portalDb: portal as never,
        instantlyDb: instantlyDb() as never,
        veProjectId: VE_PROJECT_ID,
        deps: {
          reservePeriodCampaignLinks: async () => ({ status: 'claimed', conflictingProjectIds: [] }),
          appendLeads: async () => ({
            accepted: 1, skipped: 1, attemptedIndexes: attempted, acceptedIndexes: [1],
            skippedIndexes: [0], identityComplete: true,
          }),
          createAttemptId: () => ATTEMPT_ID,
        },
      });
      expect(result).toMatchObject({ status: 'completed', accepted: 1, skipped: 1 });
      expect(portal.rpcCalls.at(-1)?.params).toMatchObject({
        p_accepted_row_ids: ['row-2'], p_skipped_row_ids: ['row-1'], p_released_row_ids: [],
      });
    },
  );

  it('rejects a changed workspace before claiming campaign ownership or reserving delivery rows', async () => {
    const portal = portalDb();
    const reserveOwnership = jest.fn();
    const appendLeads = jest.fn();
    await expect(runContactDeliveryDay({
      portalDb: portal as never,
      instantlyDb: instantlyDb('different-workspace') as never,
      veProjectId: VE_PROJECT_ID,
      deps: { reservePeriodCampaignLinks: reserveOwnership, appendLeads, createAttemptId: () => ATTEMPT_ID },
    })).rejects.toThrow('workspace');
    expect(reserveOwnership).not.toHaveBeenCalled();
    expect(portal.rpcCalls).toEqual([]);
    expect(appendLeads).not.toHaveBeenCalled();
  });

  it('counts all campaign history across paginated reads and rejects ambiguous catalog facts', async () => {
    const count = 1_001;
    const items = Array.from({ length: count }, (_, index) => ({
      id: `item-${String(index).padStart(4, '0')}`,
      project_id: VE_PROJECT_ID,
      status: index === 0 ? 'active' : 'released',
    }));
    const campaigns = items.map((item, index) => ({
      id: `child-${index}`,
      item_id: item.id,
      campaign_id: `campaign-${index}`,
    }));
    const portal = createMockSupabase({
      enforceQueryWindows: true,
      maxRowsPerQuery: 100,
      tables: { ve_launch_queue_items: items, ve_launch_queue_campaigns: campaigns },
    });
    const instantly = createMockSupabase({
      enforceQueryWindows: true,
      maxRowsPerQuery: 100,
      tables: {
        instantly_campaign_catalog: campaigns.map((campaign) => ({
          id: campaign.campaign_id,
          new_leads_contacted_count: 1,
        })),
      },
    });
    await expect(loadVeContactDeliveryCampaignInventory(portal as never, instantly as never, VE_PROJECT_ID))
      .resolves.toMatchObject({
        observedFirstContacted: count,
        activeCampaignIds: ['campaign-0'],
      });

    const malformed = createMockSupabase({ tables: {
      instantly_campaign_catalog: [{ id: 'campaign-0', new_leads_contacted_count: '1 contact' }],
    } });
    await expect(loadVeContactDeliveryCampaignInventory(portal as never, malformed as never, VE_PROJECT_ID))
      .rejects.toThrow('exact non-negative first-contacted');
  });
});

describe('VE2 contact delivery runner for a Portal project without periods', () => {
  async function portalWithoutPeriod(project: Record<string, unknown> = {}, periods: Array<Record<string, unknown>> = []) {
    const portal = portalDb();
    await portal.from('ve_projects').update({ portal_period_id: null }).eq('id', VE_PROJECT_ID);
    await portal.from('project_periods').delete().eq('project_id', PORTAL_PROJECT_ID);
    await portal.from('projects').update({
      client: 'Staff Line', name: 'Аутрич', status: 'В работе', deadline: '2026-09-30',
      launch_date: '2026-08-30', contacts_obligation: '4000', contacts_done: '25905', ...project,
    }).eq('id', PORTAL_PROJECT_ID);
    for (const period of periods) await portal.from('project_periods').insert({ project_id: PORTAL_PROJECT_ID, ...period });
    return portal;
  }

  function ownershipDeps() {
    return {
      reservePeriodCampaignLinks: jest.fn(),
      checkCampaignProjectOwnershipConflicts: jest.fn(async (_db: unknown, _projectId: string, _campaignIds: string[]) =>
        [] as Array<{ campaignId: string; conflictingProjectIds: string[] }>),
      claimCampaignProjectOwnership: jest.fn(async (_db: unknown, _claim: Record<string, unknown>) =>
        ({ status: 'claimed' as const, conflictingProjectIds: [] as string[] })),
      appendLeads: jest.fn(async () => ({
        accepted: 2, skipped: 0, attemptedIndexes: [0, 1], acceptedIndexes: [0, 1], identityComplete: true,
      })),
      createAttemptId: () => ATTEMPT_ID,
    };
  }

  it('links active campaigns to the project (legacy link) and reserves with the observed VE2 fact', async () => {
    const portal = await portalWithoutPeriod();
    const instantly = instantlyDb();
    const deps = ownershipDeps();
    const writesBefore = portal.mutations.length;
    const result = await runContactDeliveryDay({
      portalDb: portal as never, instantlyDb: instantly as never, veProjectId: VE_PROJECT_ID,
      now: new Date('2026-09-23T06:00:00.000Z'), deps: deps as never,
    });
    expect(result).toMatchObject({ status: 'completed', accepted: 2 });
    expect(deps.reservePeriodCampaignLinks).not.toHaveBeenCalled();
    expect(deps.checkCampaignProjectOwnershipConflicts).toHaveBeenCalledWith(instantly, PORTAL_PROJECT_ID, ['campaign-a', 'campaign-b']);
    expect(deps.claimCampaignProjectOwnership.mock.calls.map(([, claim]) => claim)).toEqual(['campaign-a', 'campaign-b'].map((campaignId) => ({
      projectId: PORTAL_PROJECT_ID, campaignId, matchSource: 'manual', periodId: null,
      matchConfidence: 1, matchReason: `Vertical Engine v2 delivery · ${VE_PROJECT_ID}`, replaceAutomatic: false,
    })));
    expect(portal.rpcCalls[0]).toMatchObject({ fn: 've_reserve_contact_delivery_day', params: { p_observed_ve_first_contacted: 10 } });
    // The Portal project's own fact and periods are never written by delivery.
    expect(portal.mutations.slice(writesBefore)).toEqual([]);
  });

  it('stops before ownership on a conflict', async () => {
    const portal = await portalWithoutPeriod();
    const deps = ownershipDeps();
    deps.checkCampaignProjectOwnershipConflicts.mockResolvedValueOnce([{ campaignId: 'campaign-a', conflictingProjectIds: ['other'] }]);
    await expect(runContactDeliveryDay({
      portalDb: portal as never, instantlyDb: instantlyDb() as never, veProjectId: VE_PROJECT_ID,
      now: new Date('2026-09-23T06:00:00.000Z'), deps: deps as never,
    })).rejects.toThrow('campaign ownership conflict');
    expect(deps.claimCampaignProjectOwnership).not.toHaveBeenCalled();
    expect(portal.rpcCalls).toEqual([]);
  });

  it.each([
    ['a conflict that appears at the claim', 'conflict' as const, 'delivery campaign ownership conflict: campaign-b → other'],
    ['a failed claim', 'error' as const, 'campaign ownership claim failed'],
  ])('stops on %s before the day reservation', async (_name, outcome, error) => {
    const portal = await portalWithoutPeriod();
    const deps = ownershipDeps();
    deps.claimCampaignProjectOwnership
      .mockResolvedValueOnce({ status: 'claimed', conflictingProjectIds: [] })
      .mockImplementationOnce(async () => {
        if (outcome === 'error') throw new Error('campaign ownership claim failed: instantly db unavailable');
        return { status: 'conflict', conflictingProjectIds: ['other'] } as never;
      });
    await expect(runContactDeliveryDay({
      portalDb: portal as never, instantlyDb: instantlyDb() as never, veProjectId: VE_PROJECT_ID,
      now: new Date('2026-09-23T06:00:00.000Z'), deps: deps as never,
    })).rejects.toThrow(error);
    expect(deps.claimCampaignProjectOwnership).toHaveBeenCalledTimes(2);
    expect(portal.rpcCalls.some((call) => call.fn === 've_reserve_contact_delivery_day')).toBe(false);
    expect(deps.appendLeads).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'a period created after the launch',
      project: {},
      periods: [{ id: 'new-period', status: 'active', deadline: '2026-10-31', contacts_done: '0' }],
      error: 'Проекту в Portal создан период. Загрузка новых контактов по этому плану остановлена: план рассчитан на проект без периодов. Уже загруженные контакты продолжают отправляться.',
    },
    {
      name: 'a finished project',
      project: { status: 'Завершен' },
      periods: [],
      error: 'Проект в Portal не в работе (статус «Завершен»). Верните рабочий статус в карточке проекта. Загрузка продолжится сама, если к этому времени кампании плана ещё не завершились; иначе понадобится новый запуск.',
    },
    {
      name: 'a passed card deadline',
      project: { deadline: '2026-09-22' },
      periods: [],
      error: 'Дедлайн проекта (22.09.2026) уже прошёл. Обновите поле «Дедлайн» в карточке проекта. Загрузка продолжится сама, если к этому времени кампании плана ещё не завершились; иначе понадобится новый запуск.',
    },
    {
      // 21:30 UTC — уже 00:30 следующего дня по Москве, часовому поясу отправки.
      name: 'a card deadline that ended at midnight in the delivery timezone',
      project: { deadline: '2026-09-22' },
      periods: [],
      now: '2026-09-22T21:30:00.000Z',
      error: 'Дедлайн проекта (22.09.2026) уже прошёл. Обновите поле «Дедлайн» в карточке проекта. Загрузка продолжится сама, если к этому времени кампании плана ещё не завершились; иначе понадобится новый запуск.',
    },
    {
      name: 'a card deadline that is not a date',
      project: { deadline: '31.02.26' },
      periods: [],
      error: 'В карточке проекта в поле «Дедлайн» указана не дата («31.02.26»). Укажите дату в формате ГГГГ-ММ-ДД — темп рассчитается до неё. Загрузка продолжится сама, если к этому времени кампании плана ещё не завершились; иначе понадобится новый запуск.',
    },
  ])('pauses on $name before ownership, reservation and uploads', async ({ project, periods, error, now }: {
    project: Record<string, unknown>; periods: Array<Record<string, unknown>>; error: string; now?: string;
  }) => {
    const portal = await portalWithoutPeriod(project, periods);
    const deps = ownershipDeps();
    await expect(runContactDeliveryDay({
      portalDb: portal as never, instantlyDb: instantlyDb() as never, veProjectId: VE_PROJECT_ID,
      now: new Date(now ?? '2026-09-23T06:00:00.000Z'), deps: deps as never,
    })).rejects.toThrow(error);
    expect(deps.checkCampaignProjectOwnershipConflicts).not.toHaveBeenCalled();
    expect(deps.claimCampaignProjectOwnership).not.toHaveBeenCalled();
    expect(portal.rpcCalls).toEqual([]);
    expect(deps.appendLeads).not.toHaveBeenCalled();
  });
});


describe('VE2 workspace capacity pause', () => {
  const deps = (appendLeads: jest.Mock) => ({ appendLeads, createAttemptId: () => ATTEMPT_ID,
    reservePeriodCampaignLinks: jest.fn(async () => ({ status: 'claimed' as const, conflictingProjectIds: [] })) });
  const run = (portal: ReturnType<typeof portalDb>, append: jest.Mock) => runContactDeliveryDay({
    portalDb: portal as never, instantlyDb: instantlyDb() as never, veProjectId: VE_PROJECT_ID,
    now: new Date('2026-09-07T06:00:00Z'), deps: deps(append),
  });

  it('persists a capacity pause with exact accepted and deferred rows and stops sibling campaigns', async () => {
    const portal = portalDb({ twoBatches: true });
    const append = jest.fn().mockResolvedValue({ accepted: 1, skipped: 0, attemptedIndexes: [0, 1],
      acceptedIndexes: [1], deferredIndexes: [0], identityComplete: true, capacityBlocked: true });
    expect(await run(portal, append)).toMatchObject({ status: 'capacity_blocked', accepted: 1, skipped: 0 });
    expect(append).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ pauseOnWorkspaceCapacity: true }));
    expect(portal.rpcCalls.at(-1)).toMatchObject({ fn: 've_finalize_contact_delivery_capacity', params: {
      p_accepted_row_ids: ['row-2'], p_released_row_ids: ['row-1'], p_uncertain_row_ids: [], p_skipped_row_ids: [],
    } });
    expect(portal.rpcCalls.filter((call) => call.fn === 've_mark_contact_delivery_attempt')).toHaveLength(1);
  });

  it('leaves unknown identities protected when a partial upload exhausts the plan', async () => {
    const portal = portalDb();
    const append = jest.fn().mockResolvedValue({ accepted: 1, skipped: 0, attemptedIndexes: [0, 1],
      acceptedIndexes: null, identityComplete: false, capacityBlocked: true });
    expect(await run(portal, append)).toMatchObject({ status: 'uncertain', uncertain: 2 });
    expect(portal.rpcCalls.at(-1)).toMatchObject({ fn: 've_finalize_contact_delivery_capacity', params: {
      p_accepted_row_ids: [], p_released_row_ids: [], p_uncertain_row_ids: ['row-1', 'row-2'],
    } });
  });

  it('releases definitively refused contacts from a partial error for explicit retry', async () => {
    const portal = portalDb();
    const append = jest.fn().mockRejectedValue(new AppendLeadsPartialError('Contact limit reached', {
      accepted: 0, skipped: 0, attemptedIndexes: [0, 1], acceptedIndexes: [], deferredIndexes: [0, 1],
      identityComplete: true, capacityBlocked: true,
    }));
    expect(await run(portal, append)).toMatchObject({ status: 'capacity_blocked', uncertain: 0 });
    expect(portal.rpcCalls.at(-1)?.params).toMatchObject({ p_released_row_ids: ['row-1', 'row-2'], p_uncertain_row_ids: [] });
  });

  it('does not call the provider on later ticks of a paused project', async () => {
    const append = jest.fn();
    expect(await run(portalDb({ capacityBlocked: true }), append)).toMatchObject({ status: 'capacity_blocked' });
    expect(append).not.toHaveBeenCalled();
  });

  it('never releases contacts when a resolved provider result has invalid identities', async () => {
    const portal = portalDb();
    const append = jest.fn().mockResolvedValue({ accepted: 1, skipped: 0, attemptedIndexes: [0, 1],
      acceptedIndexes: [9], identityComplete: true });
    expect(await run(portal, append)).toMatchObject({ status: 'uncertain' });
    expect(portal.rpcCalls.at(-1)?.params).toMatchObject({ p_released_row_ids: [], p_uncertain_row_ids: ['row-1', 'row-2'] });
  });
});
