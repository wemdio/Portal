/** @jest-environment node */

/**
 * Запуски VE2 через «Рассылку» (решение владельца 24.10.2026): куда идёт
 * запуск, как это записывается и как статусы «Рассылки» читаются проверками
 * подачи контактов. Единственный файл тестов этой работы — согласован с
 * владельцем 24.10.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { createMockSupabase } from '@/../tests/helpers/mockSupabase';
import { AppendLeadsPartialError } from '@/lib/clientLaunch/appendLeads';
import { completeAppendLedgerBatch } from '@/lib/clientReports/ledgerStore';
import { getCampaign, listLeads } from '@/lib/instantly/client';
import { importRecipients, SenderOpError, startCampaign } from '@/lib/sender/campaignOps';
import { syncProjectContactsFromInstantly } from '@/lib/projectContactsSync';
import { activateDeliveredContactCampaigns } from '@/lib/verticalEngineV2/contactDeliveryActivation';
import { loadVeContactDeliveryCampaignInventory } from '@/lib/verticalEngineV2/contactDeliveryInventory';
import { loadContactUploadStatus } from '@/lib/verticalEngineV2/contactUploadStatus';
import { reconcileContactDeliveries } from '@/lib/verticalEngineV2/contactDeliveryReconciliation';
import { parseLaunchInfo } from '@/lib/verticalEngineV2/launchHandoff';
import { appendLeadsToVeSenderCampaign } from '@/lib/verticalEngineV2/senderTransport/senderAppend';
import { createCampaign as createSenderCampaign } from '@/lib/sender/campaignOps';
import { createCampaign as createInstantlyCampaign } from '@/lib/instantly/client';
import { runVeTemplateLaunch } from '@/lib/verticalEngineV2/launchTemplate';
import { validateStoredAuditSnapshot } from '@/lib/verticalEngineV2/stages/segmentationAudit';
import {
  veSenderScheduleFromPreset,
  veSenderSyntaxIssue,
  veSequenceToSenderSteps,
} from '@/lib/verticalEngineV2/senderTransport/senderLaunchPlan';
import {
  senderCampaignHint,
  senderCampaignStartable,
  senderCampaignStateLabel,
  senderCreateCampaignsLabel,
  senderMarketBannerLines,
  senderPaceWarning,
  senderPoolLine,
  senderStartButtonLabel,
  senderStartReport,
  veTransportView,
} from '@/lib/verticalEngineV2/senderTransport/labels';
import { summarizeVeSenderPool } from '@/lib/verticalEngineV2/senderTransport/senderPool';
import { startVeSenderBundle } from '@/lib/verticalEngineV2/senderTransport/senderStart';
import { loadSenderThread } from '@/lib/senderLeads/context';
import { qualifyReply } from '@/lib/instantly/leadQualifier';
import { runSenderLeadsPass } from '@/lib/senderLeads/process';
import { loadCampaignSettings } from '@/lib/senderLeads/settings';
import { isClientPartyReply, withProjectLeadSettings } from '@/lib/senderLeads/projectScope';
import { runSenderProjectLeadCardsPass } from '@/lib/senderLeads/projectLeadCards';
import { handleSenderProjectLeadCallback } from '@/lib/senderLeads/projectLeadCallbacks';
import { signSenderLeadAction, verifySenderLeadAction } from '@/lib/senderLeads/projectLeadTelegram';
import { readVe2SendingSwitch, ve2SendingRefusal } from '@/lib/sender/ve2SendingSwitch';
import {
  keepVeCampaignPaused,
  readVeSenderSwitchState,
  restoreVeLaunches,
  resumeVeSenderSending,
  setProjectLeadCards,
  setVeSenderUploads,
  stopVeLaunches,
  stopVeSenderSending,
} from '@/lib/verticalEngineV2/senderTransport/switches';
import {
  decideVeLaunchTransport,
  resolveVeLaunchTransport,
  senderRemoteStatus,
  transportExpectationIssue,
  transportOf,
} from '@/lib/verticalEngineV2/senderTransport/transport';

jest.mock('@/lib/instantly/client', () => ({
  getCampaign: jest.fn(), getCampaignAnalyticsOverview: jest.fn(), listLeads: jest.fn(),
  createCampaign: jest.fn(), updateCampaign: jest.fn(),
}));
jest.mock('@/lib/loggerServer', () => ({ logAudit: jest.fn(async () => {}), logError: jest.fn(async () => {}) }));
jest.mock('@/lib/verticalEngineV2/projectLaunchPresetBinding', () => ({
  ensureVeProjectLaunchPresetBinding: jest.fn(async () => ({
    status: 'bound', newlyBound: false, binding: { launch_preset_id: 'preset-1', launch_instantly_account_id: 'workspace-a' },
  })),
}));
jest.mock('@/lib/verticalEngineV2/stages/segmentationAudit', () => ({ validateStoredAuditSnapshot: jest.fn() }));
jest.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));
jest.mock('@/lib/clientReports/ledgerStore', () => ({
  startAppendLedgerBatch: jest.fn(async () => ({ batchId: 'batch-1' })),
  completeAppendLedgerBatch: jest.fn(async () => undefined),
  failAppendLedgerBatch: jest.fn(async () => undefined),
}));
jest.mock('@/lib/senderLeads/context', () => ({ loadSenderThread: jest.fn() }));
jest.mock('@/lib/instantly/leadQualifier', () => ({
  ...jest.requireActual('@/lib/instantly/leadQualifier'),
  qualifyReply: jest.fn(),
}));
jest.mock('@/lib/sender/campaignOps', () => {
  class SenderOpError extends Error {
    constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
  }
  return { importRecipients: jest.fn(), createCampaign: jest.fn(), startCampaign: jest.fn(), SenderOpError };
});

beforeEach(() => {
  jest.mocked(getCampaign).mockReset().mockRejectedValue(new Error('Instantly must not be called'));
  jest.mocked(listLeads).mockReset().mockRejectedValue(new Error('Instantly must not be called'));
  jest.mocked(importRecipients).mockReset();
  jest.mocked(completeAppendLedgerBatch).mockClear();
});

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

/** Проект VE2 с кампанией «Рассылки» c1, привязанной к проекту Portal pp1. */
function senderDb(campaign: Record<string, unknown> = {}, extra: Record<string, Record<string, unknown>[]> = {}) {
  return createMockSupabase({
    tables: {
      ve_projects: [{ id: 've1', portal_project_id: 'pp1', market: 'ru', launch_transport_override: null }],
      ve_launch_transport_settings: [{ market: 'ru', mode: 'sender', sender_uploads_enabled: true }],
      sender_campaigns: [{ id: 'c1', status: 'draft', source_kind: 've2', project_id: 'pp1', client_user_id: 'client-1', ...campaign }],
      project_sender_campaigns: [{ id: 'l1', campaign_id: 'c1', project_id: 'pp1', period_id: null, baseline_contacts: 0 }],
      sender_campaign_steps: [{ campaign_id: 'c1', step_no: 1, subject: '{{companyName}}', body: 'Здравствуйте, {{companyName}}' }],
      sender_recipients: [],
      ...extra,
    },
  });
}

/** importRecipients, который пишет строки с номерами `write` и отвечает как настоящий. */
function importWriting(db: ReturnType<typeof senderDb>, write: number[], failAfterWrite = false) {
  return async (campaignId: string, rows: Array<{ email: string }>, opts?: { beforeWrite?: () => Promise<void> }) => {
    await opts?.beforeWrite?.();
    for (const index of write) {
      await db.from('sender_recipients').insert({ id: `r-${index}`, campaign_id: campaignId, email: rows[index].email });
    }
    if (failAfterWrite) throw new SenderOpError('ответ записи потерян', 500);
    return { inserted: write.length, accepted: rows.length, skippedInvalid: 0, skippedEmptyLetter: 0, skippedDuplicates: 0,
      skippedSuppressed: 0, skippedStopList: rows.length - write.length, skippedExisting: 0, inCampaignRows: write };
  };
}

const LEADS = [
  // Две колонки сводятся к одной переменной «Рассылки» — берётся написанная в письме.
  { email: 'a@acme.ru', custom_variables: { companyName: 'Acme', company_name: 'ООО «Акме-Трейд»' },
    _ve_company_identity: { inns: ['7700000001'], domains: [] } },
  { email: 'not-an-email', custom_variables: { companyName: 'Beta' } },
  { email: 'c@gamma.ru', custom_variables: { companyName: 'Gamma' } },
  // Тема — одна переменная, а у контакта она пустая: этим шаблоном ему не написать.
  { email: 'd@delta.ru', custom_variables: { companyName: '' } },
];

function appendInput(leads: Array<Record<string, unknown>> = LEADS, beforeProviderRequest = jest.fn(async () => undefined)) {
  return { userId: 'client-1', campaignId: 'c1', leads: leads as never, beforeProviderRequest,
    ledgerSource: { kind: 've2_contact_delivery', runId: 'run-1', campaignName: 'c1' } };
}

describe('подача контактов VE2 в «Рассылку»', () => {
  it('каждая строка либо принята, либо пропущена навсегда; переменная — в написании письма', async () => {
    const db = senderDb();
    jest.mocked(importRecipients).mockImplementation(importWriting(db, [0]) as never);
    const lease = jest.fn(async () => undefined);
    const result = await appendLeadsToVeSenderCampaign(appendInput(LEADS, lease), { veProjectId: 've1', portalDb: db as never });

    expect(result).toMatchObject({ acceptedIndexes: [0], attemptedIndexes: [0, 2], skippedIndexes: [1, 2, 3],
      identityComplete: true, capacityBlocked: false });
    expect(lease).toHaveBeenCalledTimes(1);
    const [, rows] = jest.mocked(importRecipients).mock.calls[0];
    expect(rows.map((row) => row.email)).toEqual(['a@acme.ru', 'c@gamma.ru']);
    expect(rows[0]).toMatchObject({ groupKey: 've2:inn:7700000001', vars: { companyName: 'Acme' } });
    expect(rows[0].vars).not.toHaveProperty('company_name');
    expect(JSON.stringify(rows)).not.toContain('_ve_company_identity');
    expect(jest.mocked(completeAppendLedgerBatch).mock.calls[0][1]).toMatchObject({
      accepted: 1, createdLeads: [{ id: 'r-0', email: 'a@acme.ru', index: 0 }],
    });
  });

  it('сбой до записи отпускает строки, после записи — неясные; остановленная кампания и поломка шаблона — без заливки', async () => {
    const before = senderDb();
    jest.mocked(importRecipients).mockRejectedValueOnce(new SenderOpError('Сервис не настроен', 503));
    const released = await appendLeadsToVeSenderCampaign(appendInput(), { veProjectId: 've1', portalDb: before as never })
      .catch((error: unknown) => error);
    expect(released).toBeInstanceOf(AppendLeadsPartialError);
    expect((released as AppendLeadsPartialError).partialResult.attemptedIndexes).toEqual([]);

    const after = senderDb();
    jest.mocked(importRecipients).mockImplementationOnce(importWriting(after, [0], true) as never);
    const ambiguous = await appendLeadsToVeSenderCampaign(appendInput(), { veProjectId: 've1', portalDb: after as never })
      .catch((error: unknown) => error);
    expect((ambiguous as AppendLeadsPartialError).partialResult).toMatchObject({ attemptedIndexes: [0, 2], acceptedIndexes: [0] });

    const refusals: Array<[ReturnType<typeof senderDb>, Array<Record<string, unknown>>]> = [
      [senderDb({ status: 'done' }), LEADS],
      // Переменной нет ни у одного контакта — шаги правили после запуска.
      [senderDb({}, { sender_campaign_steps: [{ campaign_id: 'c1', step_no: 1, subject: 'Тема', body: '{{inn_note}}' }] }), LEADS],
      // Недописанный вариант черновика: темы нет.
      [senderDb({}, { sender_campaign_steps: [
        { campaign_id: 'c1', step_no: 1, subject: '{{companyName}}', body: 'А' },
        { campaign_id: 'c1', step_no: 1, subject: ' ', body: 'Б' },
      ] }), LEADS],
      // Письмо пустое у большинства большой пачки — поломка шаблона, а не данных.
      [senderDb(), Array.from({ length: 20 }, (_, index) => ({
        email: `lead${index}@acme.ru`, custom_variables: { companyName: index < 9 ? 'Acme' : '' } }))],
    ];
    for (const [db, leads] of refusals) {
      const refused = await appendLeadsToVeSenderCampaign(appendInput(leads), { veProjectId: 've1', portalDb: db as never })
        .catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(Error);
      expect(refused).not.toBeInstanceOf(AppendLeadsPartialError);
    }
    expect(importRecipients).toHaveBeenCalledTimes(2);
  });

  it('состояние кампаний «Рассылки» читается из базы; сломанный шаблон и остановка закрывают только эту кампанию', async () => {
    const db = senderDb({ status: 'running' }, {
      ve_launch_queue_items: [
        { id: 'i1', project_id: 've1', status: 'active', instantly_account_id: 'ws', mailbox_ids: ['box@x.ru'], transport: 'instantly' },
        { id: 'i2', project_id: 've1', status: 'active', instantly_account_id: 'ws', mailbox_ids: ['Box@x.ru', 'b2@x.ru'], transport: 'sender' },
      ],
      ve_launch_queue_campaigns: [{ id: 'q1', item_id: 'i1', campaign_id: 'ic1' }, { id: 'q2', item_id: 'i2', campaign_id: 'c1' }],
      sender_campaign_mailboxes: [{ campaign_id: 'c1', mailbox_id: 'm1' }],
      sender_mailboxes: [{ id: 'm1', email: 'box@x.ru' }],
    });
    jest.mocked(getCampaign).mockResolvedValue({ id: 'ic1', status: 1, email_list: ['box@x.ru'] } as never);
    const rpcs: Array<Record<string, unknown>> = [];
    Object.assign(db, { rpc: async (fn: string, params: Record<string, unknown>) => { rpcs.push({ fn, ...params }); return { data: { observed: true }, error: null }; } });

    expect(await activateDeliveredContactCampaigns({ portalDb: db as never, veProjectId: 've1' })).toEqual({ activated: 0, errors: [] });
    expect(jest.mocked(getCampaign).mock.calls.map(([id]) => id)).toEqual(['ic1']);
    expect(rpcs.find((call) => call.p_item_id === 'i2')).toMatchObject({ p_campaigns: [{ campaign_id: 'c1', status: 1 }] });

    // Письмо пустое у большинства начала очереди: кампания «требует проверки» (−1) — подача в неё закрыта и у черновика.
    for (let index = 0; index < 20; index += 1) {
      await db.from('ve_contact_delivery_rows').insert({ campaign_row_id: 'q2', status: 'ready', drip_order: index,
        lead_payload: { email: `lead${index}@acme.ru`, custom_variables: { companyName: index < 5 ? 'Acme' : '' } } });
    }
    const broken = await activateDeliveredContactCampaigns({ portalDb: db as never, veProjectId: 've1' });
    expect(broken.senderErrors).toEqual([expect.stringContaining('пустым у 15 из 20')]);
    expect(rpcs.filter((call) => call.p_item_id === 'i2').at(-1)).toMatchObject({ p_campaigns: [{ campaign_id: 'c1', status: -1 }] });

    await db.from('sender_campaigns').update({ status: 'done' }).eq('id', 'c1');
    const stopped = await activateDeliveredContactCampaigns({ portalDb: db as never, veProjectId: 've1' });
    expect(stopped.errors).toEqual([]);
    expect(stopped.senderErrors).toEqual([expect.stringContaining('остановлена')]);
    expect(rpcs.filter((call) => call.p_item_id === 'i1')).toHaveLength(3);
  });

  it('первые письма «Рассылки» входят в факт плана, а сверка ищет получателя в базе — без Instantly', async () => {
    const portal = senderDb({}, {
      ve_launch_queue_items: [
        { id: 'i1', project_id: 've1', status: 'active', instantly_account_id: 'ws', transport: 'instantly' },
        { id: 'i2', project_id: 've1', status: 'active', instantly_account_id: 'ws', transport: 'sender' },
      ],
      ve_launch_queue_campaigns: [
        { id: 'q1', item_id: 'i1', campaign_id: 'ic1', instantly_account_id: 'ws', leads_count: 9, activated_at: 'x', remote_status: 1, status_observed_at: 'x' },
        { id: 'q2', item_id: 'i2', campaign_id: 'c1', instantly_account_id: 'ws', transport: 'sender', leads_count: 9, activated_at: 'x', remote_status: 1, status_observed_at: 'x' },
      ],
      sender_recipients: [{ id: 'r-1', campaign_id: 'c1', email: 'lead@acme.ru' }],
    });
    const instantly = createMockSupabase({ tables: {
      instantly_campaign_catalog: [{ id: 'ic1', new_leads_contacted_count: 5, analytics_synced_at: 'x' }],
    } });
    const rpc = portal.rpc.bind(portal);
    const claims = [{ token: 't1', email: 'Lead@Acme.ru' }, { token: 't2', email: 'other@acme.ru' }];
    const finished: Array<Record<string, unknown>> = [];
    Object.assign(portal, { rpc: async (fn: string, params: Record<string, unknown>) => {
      if (fn === 'sender_campaign_first_contacted') return { data: [{ campaign_id: 'c1', first_contacted: 3 }], error: null };
      if (fn === 've_claim_contact_delivery_reconciliation') {
        const claim = claims.shift();
        return { data: claim ? { ...claim, campaign_id: 'c1', account_id: 'ws', mailbox_ids: ['box@x.ru'] } : null, error: null };
      }
      if (fn === 've_finish_contact_delivery_reconciliation') { finished.push(params); return { data: { status: 'present' }, error: null }; }
      return rpc(fn, params);
    } });

    expect(await loadVeContactDeliveryCampaignInventory(portal as never, instantly as never, 've1')).toMatchObject({
      observedFirstContacted: 8, observedFirstContactedByCampaignRow: { q1: 5, q2: 3 },
      campaignTransports: { ic1: 'instantly', c1: 'sender' },
    });
    await reconcileContactDeliveries({ portalDb: portal as never, veProjectId: 've1' });
    expect(finished).toEqual([
      expect.objectContaining({ p_token: 't1', p_provider_lead_id: 'r-1', p_absent: false, p_error: null }),
      expect.objectContaining({ p_token: 't2', p_provider_lead_id: null, p_absent: true, p_error: null }),
    ]);
    expect(getCampaign).not.toHaveBeenCalled();
    expect(listLeads).not.toHaveBeenCalled();
  });

  it('ночной пересчёт считает письма «Рассылки» с открытия периода и не пишет ничего, если счёт не прочитался', async () => {
    const OPENED = '2030-01-10T00:00:00.000Z';
    const sent = (campaign: string, day: string, n: number) =>
      Array.from({ length: n }, () => ({ campaign_id: campaign, step_no: 1, status: 'sent', sent_at: `2030-01-${day}T12:00:00.000Z` }));
    const main = (fail = false) => createMockSupabase({
      tables: {
        projects: [{ id: 'p1', contacts_done: '0' }, { id: 'p2', contacts_done: '0' }, { id: 'p3', contacts_done: '1500' }],
        project_periods: [
          { id: 'per1', project_id: 'p1', status: 'active', contacts_done: '0', created_at: OPENED },
          { id: 'per3', project_id: 'p3', status: 'active', contacts_done: '1500', created_at: OPENED },
        ],
        // s1 привязана к прошлому периоду: в новый идут только её письма после открытия.
        project_sender_campaigns: [
          { id: 'l1', project_id: 'p1', period_id: 'per0', campaign_id: 's1', baseline_contacts: 0 },
          { id: 'l2', project_id: 'p1', period_id: 'per1', campaign_id: 's2', baseline_contacts: 0 },
          { id: 'l3', project_id: 'p2', period_id: null, campaign_id: 's3', baseline_contacts: 0 },
          // Старая кампания p3 в новом периоде молчит — ручной факт периода не трогаем.
          { id: 'l4', project_id: 'p3', period_id: 'per2', campaign_id: 's4', baseline_contacts: 0 },
        ],
        sender_messages: [...sent('s1', '05', 3), ...sent('s1', '12', 2), ...sent('s2', '11', 1), ...sent('s3', '02', 4), ...sent('s4', '03', 7)],
        project_contacts_history: [],
      },
      rpcHandlers: { sender_campaign_first_contacted_since: (params, db) => fail ? { data: null, error: { message: 'down' } } : {
        data: (params.p_campaign_ids as string[]).map((id, index) => {
          const since = (params.p_since as Array<string | null>)[index];
          return { campaign_id: id, first_contacted: db.getRows('sender_messages')
            .filter((m) => m.campaign_id === id && (since === null || String(m.sent_at) >= since)).length };
        }),
      } },
    });
    const instantly = createMockSupabase({ tables: { project_instantly_campaigns: [], project_period_instantly_campaigns: [] } });
    const db = main();
    const result = await syncProjectContactsFromInstantly({ mainDb: db as never, instantlyDb: instantly as never, now: new Date('2030-01-01T07:00:00Z') });
    expect(result).toMatchObject({ projectsUpdated: 2, senderCampaignsResolved: 4 });
    expect(db.getRows('projects').map((row) => row.contacts_done)).toEqual(['3', '4', '1500']);
    expect(db.getRows('project_periods').map((row) => row.contacts_done)).toEqual(['3', '1500']);

    const broken = main(true);
    await expect(syncProjectContactsFromInstantly({ mainDb: broken as never, instantlyDb: instantly as never, now: new Date() }))
      .rejects.toThrow('sender_campaign_first_contacted_since');
    expect(broken.updates).toEqual([]);
  });
});

describe('запуск VE2 в «Рассылку»', () => {
  it('пресет и письма переносятся в «Рассылку» без молчаливых потерь, а лишнее — отказ', () => {
    expect(veSenderScheduleFromPreset({ schedule_from: '09:30', schedule_to: '18:30', schedule_days: [0, 1, 1],
      schedule_timezone: 'Europe/Moscow', email_gap_minutes: 10 })).toEqual({ ok: true, schedule: {
      timezone: 'Europe/Moscow', sendHourFrom: 10, sendHourTo: 18, sendWeekdays: [1, 7], gapSeconds: 600, gapJitterSeconds: 120 } });
    expect(veSenderScheduleFromPreset({ schedule_from: '09:00', schedule_to: '00:00', schedule_days: [1],
      schedule_timezone: 'Europe/Moscow', email_gap_minutes: 0 })).toMatchObject({ ok: true, schedule: { sendHourTo: 24, gapSeconds: 60 } });
    for (const [from, to] of [['22:00', '06:00'], ['09:30', '10:15']]) {
      expect(veSenderScheduleFromPreset({ schedule_from: from, schedule_to: to, schedule_days: [1],
        schedule_timezone: 'Europe/Moscow', email_gap_minutes: 10 })).toMatchObject({ ok: false, code: 'VE_SENDER_SCHEDULE_INVALID' });
    }

    const sequence = (steps: Array<{ subject: string; body: string; wait_days: number; variants?: Array<{ subject?: string; body: string }> }>) =>
      ({ steps, droppedSegmentVariants: 0, lettersWithSegmentVariants: 0, appliedSegmentVariants: 0 });
    expect(veSequenceToSenderSteps(sequence([
      { subject: 'Для {{companyName}}', body: 'А', wait_days: 0, variants: [{ subject: '', body: 'Б' }] },
      { subject: '', body: 'Напоминание', wait_days: 3 },
    ]))).toEqual({ ok: true, steps: [
      { delayHours: 0, variants: [{ subject: 'Для {{companyName}}', body: 'А' }, { subject: 'Для {{companyName}}', body: 'Б' }] },
      { delayHours: 72, variants: [{ subject: '', body: 'Напоминание' }] },
    ] });
    const letter = { subject: 'Т', body: 'Т', wait_days: 1 };
    expect(veSequenceToSenderSteps(sequence(Array.from({ length: 6 }, () => letter)))).toMatchObject({ code: 'VE_SENDER_CHAIN_TOO_LONG' });
    expect(veSequenceToSenderSteps(sequence([{ ...letter, variants: Array.from({ length: 4 }, () => ({ subject: 'Т', body: 'Т' })) }])))
      .toMatchObject({ code: 'VE_SENDER_TOO_MANY_VARIANTS' });
    for (const body of ['{{firstName|коллеги}}', '{% if x %}', '{{RANDOM | a | b}}']) {
      expect(veSenderSyntaxIssue([{ variants: [{ subject: 'Т', body }] }])).toMatchObject({ code: 'VE_SENDER_TEMPLATE_UNSUPPORTED' });
    }
    expect(veSenderSyntaxIssue([{ variants: [{ subject: '{{companyName}}', body: '[сайт](https://acme.ru)' }] }])).toBeNull();
    expect(transportExpectationIssue({ transport: 'sender', source: 'override' }, undefined)).toMatchObject({ code: 'VE_LAUNCH_TRANSPORT_CHANGED' });
    expect(transportExpectationIssue({ transport: 'instantly', source: 'error' }, 'sender')).toMatchObject({ status: 503 });
    expect(transportExpectationIssue({ transport: 'instantly', source: 'error' }, undefined)).toBeNull();
  });

  const STAFF = '837cbcb1-9afb-49c9-965c-d83d1e7d8e9c';
  const CLIENT = '0f1e2d3c-4b5a-4968-8776-655443322110';
  const BOX = '11111111-2222-4333-8444-555555555555';
  const launchLeads = [{ email: 'hr@acme.ru' }, { email: 'ceo@acme.ru' }];

  function launchDbs(links: 'ok' | 'conflict' = 'ok', finalizeRaises = false) {
    const portal = createMockSupabase({
      tables: {
        ve_projects: [{ id: 've-project-1', market: 'ru', launch_transport_override: 'sender' }],
        ve_launch_transport_settings: [{ market: 'ru', mode: 'pilot', sender_uploads_enabled: true }],
        ve_templates: [{ id: 'template-1', base_id: 'base-1', status: 'ready', updated_at: '2026-10-24T10:00:00.000Z', launch_info: null,
          letters: [{ subject: 'Для вас', body: 'Письмо', wait_days: 0 }, { subject: '', body: 'Ещё раз', wait_days: 2 }] }],
        ve_bases: [{ id: 'base-1', project_id: 've-project-1', vertical_id: 'vertical-1', hypothesis_id: null,
          filename: 'base.csv', columns: ['email'], data: launchLeads, source: 'auto' }],
        ve_segmentation_audits: [{ id: 'audit-1', template_id: 'template-1', base_id: 'base-1', status: 'ready', launch_status: 'idle', input_hash: 'h' }],
        ve_verticals: [{ id: 'vertical-1', potential_pct: 50 }],
        projects: [{ id: STAFF, client: 'Staff Line', name: 'Аутрич', status: 'В работе', deadline: '2026-12-30',
          launch_date: '2026-08-30', contacts_obligation: '4000', contacts_done: '0' }],
        project_periods: [],
        sender_campaigns: [],
        sender_recipients: [],
        project_sender_campaigns: [],
      },
      rpcHandlers: {
        ve_reserve_final_template_launch: async (params, db) => {
          await db.from('ve_segmentation_audits').update({ launch_status: 'running', launch_reservation_id: params.p_reservation_id }).eq('id', params.p_audit_id);
          return { data: true };
        },
        ve_bind_contact_delivery_plan: async () => ({ data: { bound: true, replayed: false } }),
        ve_finalize_template_launch: async () => ({ data: { finalized: true } }),
        ve_finalize_template_contact_delivery: async () => (finalizeRaises
          ? { data: null, error: { message: 'bound Portal project period is not active at launch finalize', code: 'P0001' } as never }
          : { data: { finalized: true } }),
        ve_sender_pool_for_emails: () => ({ data: [{ id: BOX, email: 'Sender@Example.test', status: 'verified', enabled: true }] }),
        reserve_project_sender_campaigns: () => ({ data: links === 'ok' ? { status: 'ok' } : { status: 'conflict', conflicting_project_ids: [] } }),
      },
    });
    const instantly = createMockSupabase({
      tables: { client_campaign_presets: [{ id: 'preset-1', client_user_id: CLIENT, instantly_account_id: 'workspace-a',
        email_account_ids: ['sender@example.test'], daily_limit: 30, schedule_from: '09:00', schedule_to: '18:00',
        schedule_days: [1, 2, 3, 4, 5], schedule_timezone: 'Europe/Moscow', email_gap_minutes: 10 }] },
      rpcHandlers: { client_blocklist_snapshot: () => ({ data: { count: 0, emails: [] } }) },
    });
    jest.mocked(validateStoredAuditSnapshot).mockReturnValue({
      state: 'complete',
      snapshot: { audience: { rows: launchLeads, leads: launchLeads, totalRows: 2,
        excluded: { lowRelevance: 0, relevanceUnchecked: 0, invalidEmailStatus: 0, invalidEmail: 0, duplicateEmail: 0 } }, segments: [] },
      assignments: new Map<number, string | null>([[0, null], [1, null]]),
    } as never);
    jest.mocked(createSenderCampaign).mockReset().mockImplementation(async (input) => {
      const id = '99999999-8888-4777-8666-555555555555';
      await portal.from('sender_campaigns').insert({ id, status: 'draft', source_kind: input.sourceKind, source_job_id: input.sourceJobId,
        source_ref: input.sourceRef, project_id: input.projectId });
      return { id };
    });
    const launch = (expectedTransport?: 'sender') => runVeTemplateLaunch({
      portalDb: portal as never, instantlyDb: instantly as never, templateId: 'template-1', presetId: 'preset-1', force: false,
      segmentationAuditId: 'audit-1', confirmSegmentation: true, userId: 'staff-1', portalProjectId: STAFF,
      expectedPortalPeriodId: null, targetContacts: 4000, locale: 'ru', eventPrefix: 'test.ve2.launch',
      ...(expectedTransport ? { expectedTransport } : {}),
    });
    return { portal, instantly, launch };
  }

  it('при «Рассылке» запуск создаёт черновики с ящиками пресета и пишет transport в запуск — Instantly не трогается', async () => {
    const { portal, instantly, launch } = launchDbs();
    // Обзор показывал Instantly, а переключатель уже на «Рассылке» — отказ до любой записи.
    expect((await launch()).body).toMatchObject({ code: 'VE_LAUNCH_TRANSPORT_CHANGED' });
    expect(portal.rpcCalls).toEqual([]);

    const outcome = await launch('sender');
    expect(outcome.status).toBe(200);
    expect(createInstantlyCampaign).not.toHaveBeenCalled();
    expect(instantly.rpcCalls.map((call) => call.fn)).toEqual(['client_blocklist_snapshot']);
    const reservation = portal.rpcCalls.find((call) => call.fn === 've_reserve_final_template_launch')?.params.p_reservation_id;
    expect(jest.mocked(createSenderCampaign).mock.calls[0][0]).toMatchObject({
      mailboxIds: [BOX], timezone: 'Europe/Moscow', sendHourFrom: 9, sendHourTo: 18, sendWeekdays: [1, 2, 3, 4, 5], gapSeconds: 600,
      projectId: STAFF, clientUserId: CLIENT, sourceKind: 've2', sourceJobId: reservation, sourceRef: 'default',
      steps: [{ delayHours: 0, variants: [{ subject: 'Для вас', body: 'Письмо' }] }, { delayHours: 48, variants: [{ subject: '', body: 'Ещё раз' }] }],
    });
    expect(portal.rpcCalls.find((call) => call.fn === 'reserve_project_sender_campaigns')?.params)
      .toMatchObject({ p_project_id: STAFF, p_period_id: null });
    expect(portal.rpcCalls.at(-1)).toMatchObject({ fn: 've_finalize_template_contact_delivery', params: {
      p_launch_status: 'succeeded',
      p_launch_info: { transport: 'sender', instantly_account_id: 'workspace-a', mailbox_ids: ['sender@example.test'],
        campaign_url: '/tools/sender/campaigns/99999999-8888-4777-8666-555555555555' },
      p_drip_rows: [expect.objectContaining({ email_normalized: 'hr@acme.ru' }), expect.objectContaining({ email_normalized: 'ceo@acme.ru' })],
    } });
  });

  it('привязка или запись запуска отказали — черновик удалён, запуск не записан и его можно повторить', async () => {
    for (const [links, finalizeRaises] of [['conflict', false], ['ok', true]] as const) {
      const { portal, launch } = launchDbs(links, finalizeRaises);
      const outcome = await launch('sender');
      expect(outcome).toMatchObject({ status: 500, body: { code: 'VE_SENDER_LAUNCH_FAILED' } });
      expect(portal.getRows('sender_campaigns')).toEqual([]);
      expect(portal.rpcCalls.at(-1)).toMatchObject({ fn: 've_finalize_template_launch',
        params: { p_launch_status: 'failed', p_launch_info: null } });
    }
  });
});

describe('экраны VE2 для «Рассылки»', () => {
  it('подписи «Рассылки» не путаются с Instantly, а ящики пресета считаются как у запуска: один на адрес, лимиты и окно', () => {
    expect(veTransportView(undefined)).toBe('instantly');
    expect(veTransportView('sender')).toBe('sender');
    expect([0, 1, 2, 3, -1, null].map((status) => senderCampaignStateLabel(status))).toEqual([
      'Черновик в «Рассылке» — ожидает запуска',
      'Идёт в «Рассылке» — отправка по расписанию',
      'На паузе в «Рассылке» — отправка выключена',
      'Завершена в «Рассылке» — новые контакты в неё не подаются',
      'Письма кампании не подходят к контактам — подача в неё остановлена',
      'Статус «Рассылки» ещё не получен',
    ]);
    // Запустить можно черновик или паузу, и только с контактами: пустой «Рассылка» не запустит.
    expect([[0, 3], [2, 1], [0, 0], [1, 3], [3, 3], [-1, 3]].map(([remote_status, leads_count]) =>
      senderCampaignStartable({ remote_status, leads_count }))).toEqual([true, true, false, false, false, false]);

    const pool = summarizeVeSenderPool(
      ['Box1@x.ru', 'box2@x.ru', 'box3@x.ru', 'box4@x.ru'],
      [
        { id: 'm1', email: 'box1@x.ru', status: 'verified', enabled: true },
        { id: 'm1b', email: 'BOX1@x.ru', status: 'verified', enabled: true },
        { id: 'm2', email: 'box2@x.ru', status: 'verified', enabled: true },
        { id: 'm3', email: 'box3@x.ru', status: 'failed', enabled: true },
        { id: 'm9', email: 'stranger@x.ru', status: 'verified', enabled: true },
      ],
      [
        { id: 'm1', daily_campaign_limit: 5, daily_total_limit: 100 },
        { id: 'm1b', daily_campaign_limit: 50, daily_total_limit: 500 },
        { id: 'm2', daily_campaign_limit: 5, daily_total_limit: 12 },
      ],
      // 9 часов, пауза 10 мин + в среднем 1 мин: 49 писем — новых с ящика не больше 49/4 при цепочке из 4.
      { steps: 4, window: { sendHourFrom: 9, sendHourTo: 18, gapSeconds: 600, gapJitterSeconds: 120 } },
    );
    expect(pool).toEqual({ preset_mailboxes: 4, in_sender: 3, ready: 2, new_per_day: 5 + 3 });
    expect(senderPoolLine(pool)).toBe('В «Рассылке» готово 2 из 4 ящиков пресета · около 8 новых контактов в рабочий день.');
    expect(senderPoolLine({ ...pool, ready: 0, new_per_day: 0 })).toContain('Запуск в «Рассылку» невозможен');
    expect(senderPoolLine(null)).toContain('Не удалось проверить');
    expect(senderPaceWarning(8, pool)).toBeNull();
    expect(senderPaceWarning(100, pool)).toContain('ящики «Рассылки» отправят около 8');

    expect(senderCreateCampaignsLabel(1)).toBe('Создать черновик в «Рассылке»');
    expect(senderCreateCampaignsLabel(5)).toBe('Создать 5 черновиков в «Рассылке»');
    expect(senderStartButtonLabel(2)).toBe('Запустить 2 кампании в «Рассылке»');
    expect(senderStartReport([], [])).toEqual(['Запускать нечего: кампании уже идут или ждут первую порцию контактов.']);
    // Кнопка в «Рассылке» у паузы — «Продолжить», у черновика — «Запустить».
    expect(senderCampaignHint({ remote_status: 2, leads_count: 3, scheduled_start_at: '2099-10-27T06:00:00.000Z' })).toContain('нажмите «Продолжить»');
    expect(senderMarketBannerLines([{ market: 'ru', mode: 'pilot', sender_uploads_enabled: false }])).toEqual([
      'РФ: пилот — в «Рассылку» идут новые запуски только выбранных проектов, остальные — в Instantly. Подача контактов в кампании «Рассылки» сейчас выключена.',
    ]);
  });

  it('«Запустить в «Рассылке»» запускает только свои черновики и паузы с контактами — и только после свежей проверки состояния', async () => {
    const campaign = (id: string, status: string, extra: Record<string, unknown> = {}) =>
      ({ id, status, source_kind: 've2', project_id: 'pp1', client_user_id: 'client-1', ...extra });
    const child = (n: number, remote_status: number, leads_count = 3) =>
      ({ id: `q${n}`, item_id: 'i1', campaign_id: `c${n}`, campaign_name: 'АБВГДЕЖЗИКЛМН'[n - 1], remote_status, leads_count, status_observed_at: null });
    const db = senderDb({}, {
      sender_campaigns: [
        campaign('c1', 'draft'), campaign('c2', 'running'), campaign('c3', 'draft'), campaign('c4', 'paused'),
        campaign('c5', 'draft'), campaign('c6', 'draft'), campaign('c7', 'draft', { project_id: 'pp-other' }),
        campaign('c8', 'draft'), campaign('c9', 'draft'), campaign('c10', 'draft'), campaign('c11', 'draft'),
        campaign('c12', 'draft', { scheduled_start_at: '2099-10-27T06:00:00.000Z' }), campaign('c13', 'draft'),
      ],
      ve_launch_queue_items: [
        { id: 'i1', project_id: 've1', template_id: 't1', status: 'prepared', instantly_account_id: 'ws', mailbox_ids: ['box@x.ru'], transport: 'sender' },
        { id: 'i2', project_id: 've1', template_id: 't2', status: 'active', instantly_account_id: 'ws', mailbox_ids: ['box@x.ru'], transport: 'instantly' },
      ],
      // c1 черновик, c2 идёт, c3 без контактов, c4 пауза, c5 письма сломаны, c6 чужие ящики, c7 чужой проект, c8/c9 — для отказов
      // запуска, c10 — контакты уже в кампании (очереди нет), а follow-up просит переменную, которой у них нет; c11 — у
      // контактов колонка под {{city}} пустая: «Рассылка» пустое не хранит, но переменная у них есть — запускаем.
      ve_launch_queue_campaigns: [child(1, 0), child(2, 1), child(3, 0, 0), child(4, 2), { ...child(5, 0), campaign_name: 'ООО «Ромашка» · Клиники' },
        child(6, 0), child(7, 0), child(8, 0), child(9, 0), child(10, 0), child(11, 0), child(12, 0), child(13, 0)],
      // c12 — запуск уже назначен в «Рассылке»; c13 — запущена, но часть базы не встала в очередь.
      sender_campaign_mailboxes: ['c1', 'c2', 'c3', 'c4', 'c5', 'c7', 'c8', 'c9', 'c10', 'c11', 'c12', 'c13'].map((id) => ({ campaign_id: id, mailbox_id: 'm1' }))
        .concat([{ campaign_id: 'c6', mailbox_id: 'm2' }]),
      sender_mailboxes: [{ id: 'm1', email: 'Box@x.ru' }, { id: 'm2', email: 'other@x.ru' }],
      sender_campaign_steps: ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c10', 'c11', 'c12', 'c13'].map((id) => ({ campaign_id: id, step_no: 1, subject: '{{companyName}}', body: 'Здравствуйте, {{companyName}}' }))
        .concat([{ campaign_id: 'c10', step_no: 2, subject: '', body: 'Как дела у {{position}}?' }, { campaign_id: 'c11', step_no: 2, subject: '', body: 'Как погода, {{city}}?' }]),
      sender_recipients: [
        { id: 'r10', campaign_id: 'c10', email: 'a@acme.ru', name: null, vars: { company_name: 'Acme' }, status: 'active' },
        { id: 'r11', campaign_id: 'c11', email: 'b@acme.ru', name: null, vars: { company_name: 'Acme' }, status: 'active' },
      ],
      // Письмо c5 пустое у большинства начала её очереди — проверка ставит −1.
      ve_contact_delivery_rows: Array.from({ length: 20 }, (_, index) => ({ campaign_row_id: 'q5', status: 'ready', drip_order: index,
        lead_payload: { email: `lead${index}@acme.ru`, custom_variables: { companyName: index < 5 ? 'Acme' : '' } as Record<string, string> } }))
        .concat([{ campaign_row_id: 'q11', status: 'accepted', drip_order: 0,
          lead_payload: { email: 'b@acme.ru', custom_variables: { companyName: 'Acme', city: '' } } }]),
    });
    const rpcs: string[] = [];
    Object.assign(db, { rpc: async (fn: string, params: { p_item_id: string; p_campaigns: Array<{ campaign_id: string; status: number; status_observed_at: string }> }) => {
      rpcs.push(fn);
      for (const row of params.p_campaigns) {
        await db.from('ve_launch_queue_campaigns').update({ remote_status: row.status, status_observed_at: row.status_observed_at })
          .eq('item_id', params.p_item_id).eq('campaign_id', row.campaign_id);
      }
      return { data: { observed: true }, error: null };
    } });
    jest.mocked(startCampaign).mockReset().mockImplementation(async (id: string) => {
      if (id === 'c4') throw new SenderOpError('Стоп-листы клиента и проекта не сверены — запуск отложен', 503);
      if (id === 'c8') throw new SenderOpError('Кампанию уже запустили или завершили — обновите экран', 409);
      if (id === 'c9') throw new Error('socket hang up');
      if (id === 'c13') throw new SenderOpError('Кампания запущена, но часть базы не встала в очередь: timeout. Нажмите «Пауза» и «Запустить» ещё раз', 500);
    });

    // Чужая кампания в запуске — проверка состояния не прошла: ничего не запускаем по старому состоянию.
    const unchecked = await startVeSenderBundle(db as never, null, { veProjectId: 've1', templateId: 't1' });
    expect(jest.mocked(startCampaign)).not.toHaveBeenCalled();
    expect(rpcs).toEqual([]);
    expect(unchecked.results.find((row) => row.campaign_id === 'c1')).toMatchObject({ outcome: 'failed', message: expect.stringContaining('Не удалось проверить состояние') });
    // Причина — по названию кампании, без id строки очереди и кампании.
    expect(unchecked.notes).toEqual(['Кампания «Рассылки» «Ж» не принадлежит этому запуску.']);

    await db.from('ve_launch_queue_campaigns').delete().in('id', ['q6', 'q7']);
    const { results, notes, diagnostics } = await startVeSenderBundle(db as never, null, { veProjectId: 've1', templateId: 't1' });
    expect(jest.mocked(startCampaign).mock.calls.map(([id]) => id)).toEqual(['c1', 'c4', 'c8', 'c9', 'c11', 'c13']);
    expect(results.map((row) => [row.campaign_id, row.outcome])).toEqual([
      ['c1', 'started'], ['c2', 'skipped'], ['c3', 'skipped'], ['c4', 'failed'], ['c5', 'failed'], ['c8', 'skipped'], ['c9', 'failed'],
      ['c10', 'failed'], ['c11', 'started'], ['c12', 'skipped'], ['c13', 'started'],
    ]);
    // Назначенный в «Рассылке» запуск не отменяем молча; частичный запуск — запуск, с советом «Рассылки».
    expect(results.find((row) => row.campaign_id === 'c12')?.message).toBe('Запуск назначен в «Рассылке» на 27.10, 09:00 МСК — она запустит кампанию сама. Раньше — откройте кампанию в «Рассылке» и нажмите «Запустить».');
    expect(results.find((row) => row.campaign_id === 'c13')?.message).toContain('поставьте её на паузу и запустите ещё раз');
    expect(results.find((row) => row.campaign_id === 'c10')?.message).toContain('{{position}}');
    // Ошибка базы (5xx) — общей фразой; сырой текст — только в журнал.
    expect(results.find((row) => row.campaign_id === 'c4')?.message).toBe('Стоп-листы клиента и проекта не сверены — запуск отложен. Повторите позже.');
    expect(results.find((row) => row.campaign_id === 'c5')?.message).toContain('Письма кампании не подходят');
    expect(results.find((row) => row.campaign_id === 'c9')?.message).toBe('Не удалось запустить — повторите.');
    expect(diagnostics).toEqual(['c4: Стоп-листы клиента и проекта не сверены — запуск отложен', 'c9: socket hang up',
      'c13: Кампания запущена, но часть базы не встала в очередь: timeout. Нажмите «Пауза» и «Запустить» ещё раз']);
    // «» в названии кампании не сбивают разбор: причина видна, а не общая фраза.
    expect(notes).toEqual([expect.stringMatching(/^Кампания «Рассылки» «ООО «Ромашка» · Клиники»: .*пустым у 15 из 20.* — подача в неё остановлена\.$/)]);
    // Состояние записано до запуска и после — «Идёт» видно сразу.
    expect(rpcs).toEqual(['ve_observe_manual_campaigns', 've_observe_manual_campaigns']);
    expect(senderStartReport(results, [])[0]).toBe('Запущено в «Рассылке»: 3 кампании. Отправка пойдёт по расписанию.');

    await expect(startVeSenderBundle(db as never, null, { veProjectId: 've1', templateId: 't2' }))
      .rejects.toMatchObject({ status: 409, code: 'VE_SENDER_START_NOT_SENDER' });
    expect(jest.mocked(startCampaign)).toHaveBeenCalledTimes(6);

    // Закрытый запуск: карточка не предлагает запуск, который всё равно откажет.
    const status = await loadContactUploadStatus(db as never, 've1', 't1');
    expect(status).toMatchObject({ transport: 'sender' });
    // Назначенный в «Рассылке» запуск виден на карточке, и кнопка его не предлагает.
    const c12 = status.campaigns?.find((campaign) => campaign.campaign_id === 'c12');
    expect(c12).toMatchObject({ scheduled_start_at: '2099-10-27T06:00:00.000Z' });
    expect(senderCampaignStartable({ ...c12!, leads_count: 3 })).toBe(false);
    expect(status.campaigns?.find((campaign) => campaign.campaign_id === 'c1')).not.toHaveProperty('scheduled_start_at');
    expect(await loadContactUploadStatus(db as never, 've1', 't1')).not.toHaveProperty('launch_closed');
    // Отправку кампаний Движка остановил администратор — карточка говорит об этом (этап 6).
    expect(await loadContactUploadStatus(db as never, 've1', 't1')).not.toHaveProperty('sending_stopped');
    await db.from('ve_sender_global_settings').insert({ id: true, sending_enabled: false, sending_changed_at: '2026-10-26T12:00:00Z' });
    expect(await loadContactUploadStatus(db as never, 've1', 't1')).toMatchObject({ sending_stopped: { at: '2026-10-26T12:00:00Z' } });
    await db.from('ve_sender_global_settings').update({ sending_enabled: true }).eq('id', true);
    await db.from('ve_launch_queue_items').update({ status: 'released' }).eq('id', 'i1');
    expect(await loadContactUploadStatus(db as never, 've1', 't1')).toMatchObject({ transport: 'sender', launch_closed: true });
    expect(await loadContactUploadStatus(db as never, 've1', 't2')).not.toHaveProperty('transport');
  });
});

describe('лиды кампаний Движка в «Рассылке» — как у Instantly (этап 5)', () => {
  const RID = '11111111-1111-4111-8111-111111111111';
  const REPLY = '22222222-2222-4222-8222-222222222222';
  const TOKEN = 'bot-token';
  const ENV = {
    LEAD_ALERTS_TELEGRAM_BOT_TOKEN: TOKEN, LEAD_ALERTS_TELEGRAM_CHAT_ID: '-100500', LEAD_HANDOFF_ENABLED: 'true',
    PORTAL_PUBLIC_URL: 'https://portal.test',
  } as unknown as NodeJS.ProcessEnv;
  const project = (extra: Record<string, unknown> = {}) => ({
    id: 'pp1', client: 'ООО Клиент', specialist_user_id: 'u-spec', specialist: null, manager: null,
    handoff_email: 'client@client.ru', handoff_legend: 'Добрый день, [Имя]! Передаю вас коллегам.', handoff_auto_send: false,
    handoff_ai_adapt: false, tag_project_lead_in_telegram: false, brief_text: 'Продаём CRM клиникам', lead_criteria: 'Лид — просит КП',
    client_user_id: 'client-1', ...extra,
  });

  /** Таблицы основной базы и функции миграции 20261026_0010 поверх них. */
  function leadDb(
    projectExtra: Record<string, unknown> = {},
    extra: Record<string, Record<string, unknown>[]> = {},
    errorUpdates: Record<string, { message: string; patchIncludes?: Record<string, unknown> }> = {},
  ) {
    return createMockSupabase({
      errorUpdates,
      tables: {
        sender_project_lead_settings: [{ id: true, enabled: true, enabled_at: '2026-10-26T00:00:00Z' }],
        projects: [project(projectExtra)],
        profiles: [
          { id: 'u-spec', full_name: 'Анна Специалист', email: 'anna@polza.ru', role: 'manager' },
          { id: 'u-other', full_name: 'Пётр Другой', email: 'petr@polza.ru', role: 'manager' },
        ],
        telegram_links: [{ user_id: 'u-spec', telegram_id: 111, telegram_username: 'anna' }, { user_id: 'u-other', telegram_id: 222, telegram_username: 'petr' }],
        sender_campaigns: [
          { id: 'c1', name: 'Клиники · 26.10', source_kind: 've2', project_id: 'pp1', client_user_id: 'client-1', sender_folders: null },
          { id: 'cf', name: 'Папка', source_kind: 'polza_ru', project_id: null, client_user_id: null,
            sender_folders: { id: 'f1', key: 'auto_ru', name: 'Авто', lead_criteria: null, leads_enabled: true, leads_telegram: true } },
        ],
        sender_recipients: [{
          id: RID, campaign_id: 'c1', email: 'lead@acme.ru', name: 'Иван', vars: { company_name: 'Acme', website: 'acme.ru' },
          mailbox_id: 'm1', thread_message_id: '<t1@x>', status: 'replied', lead_verdict: 'lead', lead_verdict_source: 'ai', last_step_sent: 2,
        }],
        sender_mailboxes: [{ id: 'm1', email: 'box@x.ru', status: 'verified', enabled: true }],
        sender_messages: [{ recipient_id: RID, step_no: 1, subject: 'Предложение' }],
        sender_replies: [{
          id: REPLY, recipient_id: RID, kind: 'human', from_email: 'lead@acme.ru', from_name: 'Иван', subject: 'Re: Предложение',
          body: 'Пришлите КП. Тел. +7 999 123-45-67', message_id: '<r1@acme>', received_at: '2026-10-26T10:00:00Z',
          created_at: '2026-10-26T10:00:01Z', to_emails: ['box@x.ru'], cc_emails: [],
        }],
        sender_reply_qualifications: [{ reply_id: REPLY, recipient_id: RID, campaign_id: 'c1', status: 'lead', ai_reason: 'Просит КП', qualified_at: '2026-10-26T10:01:00Z' }],
        sender_manual_messages: [],
        sender_project_lead_cards: [],
        notifications: [],
        deadline_notification_log: [],
        ...extra,
      },
      rpcHandlers: {
        sender_project_lead_candidates: (_params, db) => {
          const settings = db.getRows('sender_project_lead_settings')[0];
          if (!settings?.enabled) return { data: [] };
          const cards = db.getRows('sender_project_lead_cards');
          const data = db.getRows('sender_reply_qualifications').flatMap((q) => {
            const campaign = db.getRows('sender_campaigns').find((c) => c.id === q.campaign_id);
            const recipient = db.getRows('sender_recipients').find((r) => r.id === q.recipient_id);
            const card = cards.find((c) => c.recipient_id === q.recipient_id);
            const fresh = String(q.qualified_at) >= String(settings.enabled_at);
            const manualNotLead = recipient?.lead_verdict === 'not_lead' && recipient?.lead_verdict_source === 'manual';
            const open = !card || (!(card.merged_reply_ids as string[]).includes(String(q.reply_id))
              && ((card.board_written_at && ['card_sent', 'queued', 'sent'].includes(String(card.status))) || card.status === 'undelivered'));
            return q.status === 'lead' && fresh && campaign?.source_kind === 've2' && campaign.project_id && recipient && !manualNotLead && open
              ? [{ reply_id: q.reply_id, recipient_id: q.recipient_id, campaign_id: q.campaign_id, project_id: campaign.project_id, has_card: Boolean(card), card_status: card?.status ?? null }]
              : [];
          });
          return { data };
        },
        sender_project_lead_card_events: (_params, db) => {
          const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
          const handoffs = (recipientId: unknown) => db.getRows('sender_manual_messages')
            .filter((m) => m.recipient_id === recipientId && m.handoff)
            .sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
          const data = db.getRows('sender_project_lead_cards').flatMap((card) => {
            const h = handoffs(card.recipient_id).at(-1);
            const recipient = db.getRows('sender_recipients').find((r) => r.id === card.recipient_id)!;
            const status = String(card.status);
            const hOpen = !h || h.status === 'failed';
            const kind = h?.status === 'sent' && !['sent', 'pending'].includes(status) ? 'sent'
              : h?.status === 'sent' && status === 'pending' && card.board_written_at && !card.board_published_at ? 'publish'
                : h?.status === 'failed'
                  && ((status === 'queued' && (h.id === card.manual_message_id || String(h.created_at) >= String(card.decided_at ?? card.created_at)))
                    || (status === 'card_sent' && card.handoff_mode === 'auto' && String(h.created_at) >= String(card.created_at))) ? 'failed'
                  : ['card_sent', 'handoff_failed', 'undelivered'].includes(status)
                    && recipient.lead_verdict === 'not_lead' && recipient.lead_verdict_source === 'manual' && hOpen ? 'not_lead'
                    : status === 'card_sent' && card.handoff_mode === 'auto' && card.blocked_reason && !card.manual_message_id
                      && (!h || (h.status === 'failed' && String(h.created_at) < String(card.created_at)))
                      && String(card.next_attempt_at ?? '') <= new Date().toISOString() ? 'auto_retry'
                      : status === 'queued' && !card.manual_message_id && String(card.updated_at) < minutesAgo(10)
                        && !handoffs(card.recipient_id).some((m) => String(m.created_at ?? '') >= String(card.decided_at ?? card.created_at)) ? 'stuck'
                        : status !== 'pending' && card.tg_message_id && card.tg_rendered_status !== status && String(card.updated_at) < minutesAgo(2) ? 'render'
                          : null;
            return kind ? [{
              recipient_id: card.recipient_id, kind, status, handoff_id: h?.id ?? null, handoff_status: h?.status ?? null,
              handoff_error: h?.error ?? null, handoff_cc: h?.cc_emails ?? null,
              lead_verdict: recipient.lead_verdict, lead_verdict_source: recipient.lead_verdict_source,
            }] : [];
          });
          return { data };
        },
        enqueue_sender_auto_leads_crm: () => ({ data: null }),
      },
    });
  }
  // База Instantly: доска лидов и пустые стоп-листы клиента.
  const boardDb = () => createMockSupabase({
    tables: { project_lead_boards: [], project_lead_board_rows: [], project_contact_blocks: [] },
    rpcHandlers: { client_blocklist_snapshot: () => ({ data: { count: 0, emails: [] } }) },
  });
  const log = () => undefined;
  const passDeps = (db: ReturnType<typeof leadDb>, instantlyDb: ReturnType<typeof boardDb>) => {
    const post = jest.fn(async (_card: unknown) => 777);
    const edit = jest.fn(async (_card: unknown) => undefined);
    const draft = jest.fn(async () => 'Иван, передаю вас клиенту.');
    return { deps: { db: db as never, instantlyDb: instantlyDb as never, log, env: ENV, post, edit, draft }, post, edit, draft };
  };
  const press = (data: string, telegramId = 111, messageId = 777) => ({
    callback_query: { id: 'cq1', data, from: { id: telegramId }, message: { message_id: messageId, chat: { id: -100500 } } },
  });
  const previousSecret = process.env.GUEST_TOKEN_SECRET;
  beforeAll(() => { process.env.GUEST_TOKEN_SECRET = 'board-secret'; });
  afterAll(() => { process.env.GUEST_TOKEN_SECRET = previousSecret; });

  it('ответ кампании Движка оценивается по брифу и критерию проекта, письмо клиента проекта — не лид, папки — как были', async () => {
    const db = leadDb({}, {
      sender_lead_queue: [
        { reply_id: 'r-lead', recipient_id: RID, campaign_id: 'c1', created_at: '2026-10-26T10:00:00Z' },
        { reply_id: 'r-client', recipient_id: RID, campaign_id: 'c1', created_at: '2026-10-26T10:05:00Z' },
        { reply_id: 'r-folder', recipient_id: 'rf', campaign_id: 'cf', created_at: '2026-10-26T10:06:00Z' },
      ],
      sender_reply_qualifications: [],
    });
    const thread = (from: string) => ({ context: { replyEmail: { timestamp_email: '2026-10-26T10:00:00Z' } }, replyFrom: from, replySubject: 'Re', replyBody: 'текст' });
    jest.mocked(loadSenderThread).mockImplementation(async (_db, replyId) => (
      replyId === 'r-client' ? thread('Boss@Client.ru') : thread(replyId === 'r-folder' ? 'x@folder.ru' : 'lead@acme.ru')) as never);
    jest.mocked(qualifyReply).mockReset().mockResolvedValue({ isLead: true, reason: 'Просит КП', interestSignals: [] } as never);
    const previous = process.env.SENDER_LEADS_AI_API_KEY;
    process.env.SENDER_LEADS_AI_API_KEY = 'ai-key';
    try {
      await runSenderLeadsPass(db as never, log);
    } finally {
      process.env.SENDER_LEADS_AI_API_KEY = previous;
    }
    const calls = jest.mocked(qualifyReply).mock.calls;
    expect(calls.map((call) => call[0])).toEqual(['c1', 'cf']);
    expect(calls[0][3]).toMatchObject({ briefText: 'Продаём CRM клиникам', leadCriteria: 'Лид — просит КП' });
    expect(calls[1][3]).toMatchObject({ briefText: '', leadCriteria: null });
    // Письмо с домена клиента после передачи — не оценивается и не меняет итог переписки лида.
    expect(db.getRows('sender_reply_qualifications').find((row) => row.reply_id === 'r-client'))
      .toMatchObject({ status: 'skipped', last_error: expect.stringContaining('ответ клиента проекта') });
    expect(isClientPartyReply('someone@gmail.com', { addresses: ['owner@gmail.com'], domains: [] })).toBe(false);

    // Проект не прочитан — ждут только ответы кампаний Движка.
    const broken = createMockSupabase({ tables: { sender_campaigns: db.getRows('sender_campaigns') }, errorTables: { projects: 'нет связи' } });
    const settings = await withProjectLeadSettings(broken as never, await loadCampaignSettings(broken as never, ['c1', 'cf']));
    expect(settings.get('c1')?.settings).toMatchObject({ route: 'project', projectError: expect.stringContaining('нет связи') });
    expect(settings.get('cf')?.settings).not.toHaveProperty('projectError');
  });

  it('лид — одна карточка специалисту с «Передать» и «Не лид», строка доски скрыта до передачи; кнопки — только ответственному', async () => {
    const db = leadDb();
    const instantlyDb = boardDb();
    const { deps, post, edit } = passDeps(db, instantlyDb);
    await runSenderProjectLeadCardsPass(deps);
    await runSenderProjectLeadCardsPass(deps);
    expect(post).toHaveBeenCalledTimes(1);
    const card = post.mock.calls[0][0] as unknown as { html: string; keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>>; threadId: number | null };
    expect(card.html).toContain('Новый лид из «Рассылки»');
    expect(card.html).toContain('<a href="tg://user?id=111">Анна Специалист</a>');
    expect(card.html).toContain('Иван, передаю вас клиенту.');
    expect(card.html).toContain('client@client.ru');
    expect(card.threadId).toBeNull();
    expect(card.keyboard.map((row) => row[0].text)).toEqual(['➡️ Передать клиенту', 'Не лид', 'Открыть переписку']);
    expect(verifySenderLeadAction(card.keyboard[0][0].callback_data, TOKEN)).toEqual({ action: 'p', recipientId: RID });
    expect(card.keyboard[0][0].callback_data!.length).toBeLessThanOrEqual(64);
    expect(db.getRows('sender_project_lead_cards')[0]).toMatchObject({ status: 'card_sent', handoff_mode: 'manual', tg_message_id: 777, tg_rendered_status: 'card_sent' });
    expect(instantlyDb.getRows('project_lead_board_rows')).toEqual([expect.objectContaining({
      qualification_id: RID, project_id: 'pp1', specialist_review_required: true, source: 'sender', lead_email: 'lead@acme.ru',
      phone: expect.stringContaining('999'), request_text: expect.stringContaining('КП'),
    })]);
    expect(db.getRows('notifications')).toEqual([expect.objectContaining({ user_id: 'u-spec', type: 'lead_new', entity_id: REPLY, title: 'Новый квалифицированный лид' })]);

    const answer = jest.fn(async () => undefined);
    const callbackDeps = { main: db as never, instantlyDb: instantlyDb as never, env: ENV, edit, answer, log };
    expect(await handleSenderProjectLeadCallback(press('h.whatever'), TOKEN, callbackDeps)).toBe(false);
    await handleSenderProjectLeadCallback(press(`p.${RID}.${'A'.repeat(24)}`), TOKEN, callbackDeps);
    await handleSenderProjectLeadCallback(press(signSenderLeadAction('p', RID, TOKEN), 222), TOKEN, callbackDeps);
    expect(answer.mock.calls.map((call) => (call as unknown[])[2])).toEqual(['Некорректная кнопка', 'Нажать может ответственный за проект']);
    expect(db.getRows('sender_manual_messages')).toEqual([]);

    // «Передать» — письмо в очереди «Рассылки» с клиентом в копии; второе нажатие — «уже передано».
    await handleSenderProjectLeadCallback(press(signSenderLeadAction('p', RID, TOKEN)), TOKEN, callbackDeps);
    await handleSenderProjectLeadCallback(press(signSenderLeadAction('x', RID, TOKEN)), TOKEN, callbackDeps);
    expect(answer.mock.calls.slice(2).map((call) => (call as unknown[])[2])).toEqual(['Передача в очереди — письмо уйдёт из «Рассылки», клиент в копии', 'Уже передано']);
    const [handoff] = db.getRows('sender_manual_messages');
    expect(handoff).toMatchObject({ recipient_id: RID, to_email: 'lead@acme.ru', cc_emails: ['client@client.ru'], status: 'queued', created_by: 'u-spec' });
    expect(String(handoff.body)).toContain('Иван, передаю вас клиенту.');
    expect(db.getRows('sender_project_lead_cards')[0]).toMatchObject({ status: 'queued', decided_by_telegram_id: 111 });

    // Письмо ушло — строка открывается клиенту, карточка закрывается, эскалации больше нет.
    await db.from('sender_manual_messages').update({ status: 'sent' }).eq('id', handoff.id);
    await runSenderProjectLeadCardsPass(deps);
    expect(instantlyDb.getRows('project_lead_board_rows')[0]).toMatchObject({ specialist_review_required: false });
    expect(db.getRows('sender_project_lead_cards')[0]).toMatchObject({ status: 'sent', tg_rendered_status: 'sent', board_published_at: expect.any(String) });
    expect(db.getRows('notifications')[0]).toMatchObject({ is_read: true });
    expect(String((edit.mock.calls.at(-1) as unknown as [{ html: string }])[0].html)).toContain('✅ <b>Передано клиенту</b>');
  });

  it('без настроенной передачи лид сразу у клиента, «Не лид» скрывает его; автопередача ставит письмо сама; выключатель останавливает новые карточки', async () => {
    const db = leadDb({ handoff_legend: '' });
    const instantlyDb = boardDb();
    const { deps, post, edit } = passDeps(db, instantlyDb);
    await runSenderProjectLeadCardsPass(deps);
    const card = post.mock.calls[0][0] as unknown as { keyboard: Array<Array<{ text: string }>> };
    expect(card.keyboard.map((row) => row[0].text)).toEqual(['Не лид', 'Открыть переписку']);
    expect(instantlyDb.getRows('project_lead_board_rows')[0]).not.toHaveProperty('specialist_review_required');
    const answer = jest.fn(async () => undefined);
    await handleSenderProjectLeadCallback(press(signSenderLeadAction('x', RID, TOKEN)), TOKEN, { main: db as never, instantlyDb: instantlyDb as never, env: ENV, edit, answer, log });
    expect(answer).toHaveBeenLastCalledWith(TOKEN, 'cq1', 'Сохранено: не лид', false);
    expect(instantlyDb.getRows('project_lead_board_rows')[0]).toMatchObject({ specialist_review_required: true });
    expect(db.getRows('sender_recipients')[0]).toMatchObject({ lead_verdict: 'not_lead', lead_verdict_source: 'manual', lead_verdict_by: 'u-spec' });
    expect(db.getRows('sender_project_lead_cards')[0]).toMatchObject({ status: 'rejected', tg_rendered_status: 'rejected' });

    // Итог переписки не записался — карточка снова ждёт решения, строка доски не тронута.
    const failDb = leadDb({ handoff_legend: '' }, {}, { sender_recipients: { message: 'нет связи', patchIncludes: { lead_verdict: 'not_lead' } } });
    const failBoard = boardDb();
    const failed = passDeps(failDb, failBoard);
    await runSenderProjectLeadCardsPass(failed.deps);
    const failAnswer = jest.fn(async () => undefined);
    await handleSenderProjectLeadCallback(press(signSenderLeadAction('x', RID, TOKEN)), TOKEN, { main: failDb as never, instantlyDb: failBoard as never, env: ENV, edit: failed.edit, answer: failAnswer, log });
    expect(failAnswer).toHaveBeenLastCalledWith(TOKEN, 'cq1', 'Не удалось — повторите', true);
    expect(failDb.getRows('sender_project_lead_cards')[0]).toMatchObject({ status: 'card_sent', decided_at: null });
    expect(failBoard.getRows('project_lead_board_rows')[0]).not.toHaveProperty('specialist_review_required');

    // Автопередача: письмо в очереди раньше карточки, на карточке нет кнопок решения.
    const autoDb = leadDb({ handoff_auto_send: true });
    const auto = passDeps(autoDb, boardDb());
    await runSenderProjectLeadCardsPass(auto.deps);
    expect(autoDb.getRows('sender_manual_messages')).toEqual([expect.objectContaining({ recipient_id: RID, status: 'queued', created_by: 'u-spec' })]);
    const autoCard = auto.post.mock.calls[0][0] as unknown as { html: string; keyboard: Array<Array<{ text: string }>> };
    expect(autoCard.html).toContain('Автопередача включена');
    expect(autoCard.keyboard.map((row) => row[0].text)).toEqual(['Открыть переписку']);
    expect(autoDb.getRows('sender_project_lead_cards')[0]).toMatchObject({ status: 'queued' });
    // Письмо не ушло — карточка говорит об этом, передать можно заново.
    await autoDb.from('sender_manual_messages').update({ status: 'failed', error: 'Ящик недоступен' }).eq('recipient_id', RID);
    await runSenderProjectLeadCardsPass(auto.deps);
    expect(autoDb.getRows('sender_project_lead_cards')[0]).toMatchObject({ status: 'handoff_failed' });
    expect(String((auto.edit.mock.calls.at(-1) as unknown as [{ html: string }])[0].html)).toContain('Письмо передачи не ушло');

    // Ящик переписки недоступен — карточка приходит с причиной, автопередача повторяется сама после починки.
    const boxDb = leadDb({ handoff_auto_send: true }, { sender_mailboxes: [{ id: 'm1', email: 'box@x.ru', status: 'verified', enabled: false }] });
    const box = passDeps(boxDb, boardDb());
    await runSenderProjectLeadCardsPass(box.deps);
    expect(boxDb.getRows('sender_manual_messages')).toEqual([]);
    expect(boxDb.getRows('sender_project_lead_cards')[0]).toMatchObject({ status: 'card_sent', blocked_reason: expect.stringContaining('Ящик переписки недоступен') });
    expect(String((box.post.mock.calls[0][0] as unknown as { html: string }).html)).toContain('Автопередача отложена');
    // Ящик всё ещё лежит — ждём дальше; неделю спустя карточка честно говорит, что автопередачи не будет.
    await boxDb.from('sender_project_lead_cards').update({ next_attempt_at: '2000-01-01T00:00:00Z' }).eq('recipient_id', RID);
    await runSenderProjectLeadCardsPass(box.deps);
    expect(String(boxDb.getRows('sender_project_lead_cards')[0].next_attempt_at) > new Date().toISOString()).toBe(true);
    expect(box.edit).not.toHaveBeenCalled();
    await boxDb.from('sender_project_lead_cards').update({ next_attempt_at: '2000-01-01T00:00:00Z', created_at: '2000-01-01T00:00:00Z' }).eq('recipient_id', RID);
    await runSenderProjectLeadCardsPass(box.deps);
    expect(boxDb.getRows('sender_project_lead_cards')[0]).toMatchObject({ status: 'card_sent', next_attempt_at: '9999-01-01T00:00:00.000Z', tg_rendered_status: 'card_sent' });
    expect(String((box.edit.mock.calls.at(-1) as unknown as [{ html: string }])[0].html)).toContain('Автопередача не состоится');
    await boxDb.from('sender_mailboxes').update({ enabled: true }).eq('id', 'm1');
    // Карточки лидов выключены (этап 6) — автопередача ждёт включения, письмо само не встаёт.
    await boxDb.from('sender_project_lead_settings').update({ enabled: false }).eq('id', true);
    await boxDb.from('sender_project_lead_cards').update({ next_attempt_at: '2000-01-01T00:00:00Z', created_at: new Date().toISOString() }).eq('recipient_id', RID);
    await runSenderProjectLeadCardsPass(box.deps);
    expect(boxDb.getRows('sender_manual_messages')).toEqual([]);
    expect(boxDb.getRows('sender_project_lead_cards')[0]).toMatchObject({ status: 'card_sent', blocked_reason: 'Карточки лидов выключены администратором' });
    await boxDb.from('sender_project_lead_settings').update({ enabled: true }).eq('id', true);
    await boxDb.from('sender_project_lead_cards').update({ next_attempt_at: '2000-01-01T00:00:00Z' }).eq('recipient_id', RID);
    await runSenderProjectLeadCardsPass(box.deps);
    expect(boxDb.getRows('sender_manual_messages')).toEqual([expect.objectContaining({ recipient_id: RID, status: 'queued', created_by: 'u-spec' })]);
    expect(boxDb.getRows('sender_project_lead_cards')[0]).toMatchObject({ status: 'queued', blocked_reason: null });

    // Передано из «Писем» ещё до карточки — карточка сразу «передано», строка открыта, эскалации нет.
    const sentDb = leadDb({}, { sender_manual_messages: [{
      id: 'h0', recipient_id: RID, handoff: { by: 'letters' }, status: 'sent', cc_emails: ['client@client.ru'], created_at: '2026-10-26T10:30:00Z',
    }] });
    const sentBoard = boardDb();
    const early = passDeps(sentDb, sentBoard);
    await runSenderProjectLeadCardsPass(early.deps);
    expect(sentDb.getRows('sender_project_lead_cards')[0]).toMatchObject({ status: 'sent', manual_message_id: 'h0', board_published_at: expect.any(String) });
    expect(sentBoard.getRows('project_lead_board_rows')[0]).toMatchObject({ specialist_review_required: false });
    expect([sentDb.getRows('notifications'), sentDb.getRows('deadline_notification_log')]).toEqual([[], []]);
    expect(String((early.post.mock.calls[0][0] as unknown as { html: string }).html)).toContain('✅ <b>Передано клиенту</b>');

    // «Не лид» из Telegram оборвался после захвата карточки — воркер дописывает итог и скрывает строку.
    const halfDb = leadDb({ handoff_legend: '' });
    const halfBoard = boardDb();
    const half = passDeps(halfDb, halfBoard);
    await runSenderProjectLeadCardsPass(half.deps);
    await halfDb.from('sender_project_lead_cards').update({ status: 'rejected', decided_by_user_id: 'u-spec', decided_at: '2026-10-26T12:00:00Z' }).eq('recipient_id', RID);
    await halfDb.from('notifications').update({ is_read: false }).eq('entity_id', REPLY);
    // Пока нажатие могло не закончиться, воркер не вмешивается.
    await runSenderProjectLeadCardsPass(half.deps);
    expect(halfDb.getRows('sender_recipients')[0]).toMatchObject({ lead_verdict: 'lead' });
    await halfDb.from('sender_project_lead_cards').update({ updated_at: '2000-01-01T00:00:00Z' }).eq('recipient_id', RID);
    await runSenderProjectLeadCardsPass(half.deps);
    expect(halfDb.getRows('sender_recipients')[0]).toMatchObject({ lead_verdict: 'not_lead', lead_verdict_source: 'manual', lead_verdict_by: 'u-spec' });
    expect(halfBoard.getRows('project_lead_board_rows')[0]).toMatchObject({ specialist_review_required: true });
    expect(halfDb.getRows('sender_project_lead_cards')[0]).toMatchObject({ tg_rendered_status: 'rejected' });
    expect(halfDb.getRows('notifications')[0]).toMatchObject({ is_read: true });
    // Оборвалось, а передача из «Писем» уже стоит в очереди — карточка возвращается к кнопкам, итог не трогаем.
    const queuedDb = leadDb({}, { sender_manual_messages: [{
      id: 'h1', recipient_id: RID, handoff: { by: 'letters' }, status: 'queued', cc_emails: ['client@client.ru'], created_at: '2026-10-26T13:00:00Z',
    }] });
    const queuedRun = passDeps(queuedDb, boardDb());
    await runSenderProjectLeadCardsPass(queuedRun.deps);
    await queuedDb.from('sender_project_lead_cards').update({
      status: 'rejected', decided_by_user_id: 'u-spec', decided_at: '2026-10-26T14:00:00Z', tg_rendered_status: 'card_sent', updated_at: '2000-01-01T00:00:00Z',
    }).eq('recipient_id', RID);
    await runSenderProjectLeadCardsPass(queuedRun.deps);
    expect(queuedDb.getRows('sender_project_lead_cards')[0]).toMatchObject({ status: 'card_sent', decided_at: null });
    expect(queuedDb.getRows('sender_recipients')[0]).toMatchObject({ lead_verdict: 'lead', lead_verdict_source: 'ai' });

    // Карточку так и не доставили, а в «Рассылке» отметили «Не лид» — открытая строка всё равно скрывается.
    const lostDb = leadDb({ handoff_legend: '' });
    const lostBoard = boardDb();
    await runSenderProjectLeadCardsPass(passDeps(lostDb, lostBoard).deps);
    await lostDb.from('sender_project_lead_cards').update({ status: 'undelivered', tg_message_id: null }).eq('recipient_id', RID);
    await lostDb.from('sender_recipients').update({ lead_verdict: 'not_lead', lead_verdict_source: 'manual' }).eq('id', RID);
    await runSenderProjectLeadCardsPass(passDeps(lostDb, lostBoard).deps);
    expect(lostDb.getRows('sender_project_lead_cards')[0]).toMatchObject({ status: 'rejected' });
    expect(lostBoard.getRows('project_lead_board_rows')[0]).toMatchObject({ specialist_review_required: true });

    // Выключатель: новые карточки не заводятся; лид, оценённый до отсечки, — тоже.
    const offDb = leadDb({}, { sender_project_lead_settings: [{ id: true, enabled: false, enabled_at: '2026-10-26T00:00:00Z' }] });
    const off = passDeps(offDb, boardDb());
    await runSenderProjectLeadCardsPass(off.deps);
    const oldDb = leadDb({}, { sender_project_lead_settings: [{ id: true, enabled: true, enabled_at: '2026-10-27T00:00:00Z' }] });
    const old = passDeps(oldDb, boardDb());
    await runSenderProjectLeadCardsPass(old.deps);
    expect([off.post, old.post].map((fn) => fn.mock.calls.length)).toEqual([0, 0]);
    expect([...offDb.getRows('sender_project_lead_cards'), ...oldDb.getRows('sender_project_lead_cards')]).toEqual([]);
  });

  it('«Не лид» из «Рассылки» закрывает карточку и скрывает строку; второй ответ-лид дописывается в ту же строку без второй карточки', async () => {
    const db = leadDb();
    const instantlyDb = boardDb();
    const { deps, post } = passDeps(db, instantlyDb);
    await runSenderProjectLeadCardsPass(deps);
    // Версия строки доски — значение по умолчанию в Postgres, мок его не ставит.
    await instantlyDb.from('project_lead_board_rows').update({ updated_at: '2026-10-26T10:02:00Z' }).eq('qualification_id', RID);
    // Ещё один ответ-лид той же переписки.
    await db.from('sender_replies').insert({
      id: 'r2', recipient_id: RID, kind: 'human', from_email: 'lead@acme.ru', from_name: 'Иван', subject: 'Re', body: 'И ещё вопрос по цене',
      message_id: '<r2@acme>', received_at: '2026-10-26T11:00:00Z', created_at: '2026-10-26T11:00:00Z',
    });
    await db.from('sender_reply_qualifications').insert({ reply_id: 'r2', recipient_id: RID, campaign_id: 'c1', status: 'lead', ai_reason: 'Цена', qualified_at: '2026-10-26T11:01:00Z' });
    await runSenderProjectLeadCardsPass(deps);
    expect(post).toHaveBeenCalledTimes(1);
    expect(db.getRows('sender_project_lead_cards')[0].merged_reply_ids).toEqual([REPLY, 'r2']);
    expect(instantlyDb.getRows('project_lead_board_rows')[0].request_text).toContain('по цене');

    // Позже ИИ счёл ответ «не лидом» («спасибо, получили») — настоящего лида это не отменяет.
    await db.from('sender_recipients').update({ lead_verdict: 'not_lead', lead_verdict_source: 'ai' }).eq('id', RID);
    await runSenderProjectLeadCardsPass(deps);
    expect(db.getRows('sender_project_lead_cards')[0]).toMatchObject({ status: 'card_sent' });

    await db.from('sender_recipients').update({ lead_verdict: 'not_lead', lead_verdict_source: 'manual' }).eq('id', RID);
    await runSenderProjectLeadCardsPass(deps);
    expect(db.getRows('sender_project_lead_cards')[0]).toMatchObject({ status: 'rejected', tg_rendered_status: 'rejected' });
    expect(instantlyDb.getRows('project_lead_board_rows')[0]).toMatchObject({ specialist_review_required: true });

    // Карточка ушла в Telegram, а итог не записался — следующая попытка правит ту же карточку, второй нет.
    const flaky: Record<string, { message: string; patchIncludes?: Record<string, unknown> }> = {
      sender_project_lead_cards: { message: 'сбой записи', patchIncludes: { tg_rendered_status: 'card_sent' } },
    };
    const dupDb = leadDb({}, {}, flaky);
    const dup = passDeps(dupDb, boardDb());
    await runSenderProjectLeadCardsPass(dup.deps);
    expect(dupDb.getRows('sender_project_lead_cards')[0]).toMatchObject({ status: 'pending', tg_message_id: 777 });
    delete flaky.sender_project_lead_cards;
    await dupDb.from('sender_project_lead_cards').update({ next_attempt_at: '2000-01-01T00:00:00Z' }).eq('recipient_id', RID);
    await runSenderProjectLeadCardsPass(dup.deps);
    expect([dup.post.mock.calls.length, dup.edit.mock.calls.length]).toEqual([1, 1]);
    expect(dupDb.getRows('sender_project_lead_cards')[0]).toMatchObject({ status: 'card_sent', tg_message_id: 777, tg_rendered_status: 'card_sent' });
  });
});

describe('выключатели запусков Движка через «Рассылку» (этап 6)', () => {
  const NOW = new Date('2026-10-26T12:00:00Z');
  const missing = createMockSupabase({ errorTables: { ve_sender_global_settings: 'relation "public.ve_sender_global_settings" does not exist' } });

  it('выключатели пишут кто и когда, повтор их не переписывает; «вернуть» восстанавливает режим; пропущенные лиды можно прислать', async () => {
    // Нет таблицы (почтовый хост раньше миграции) — отправка включена; иная ошибка — не запускаем; выключено — отказ с кодом.
    expect(ve2SendingRefusal(await readVe2SendingSwitch(missing as never))).toBeNull();
    const broken = createMockSupabase({ errorTables: { ve_sender_global_settings: 'timeout' } });
    expect(ve2SendingRefusal(await readVe2SendingSwitch(broken as never))).toMatchObject({ status: 503 });
    const off = createMockSupabase({ tables: { ve_sender_global_settings: [{ id: true, sending_enabled: false, sending_changed_at: '2026-10-26T11:00:00Z' }] } });
    expect(ve2SendingRefusal(await readVe2SendingSwitch(off as never))).toMatchObject({ status: 409, code: 'VE2_SENDING_STOPPED' });

    const db = createMockSupabase({
      tables: {
        ve_launch_transport_settings: [
          { market: 'ru', mode: 'sender', mode_before_stop: null, sender_uploads_enabled: true, updated_at: null, updated_by: null, note: null },
          { market: 'us', mode: 'instantly', mode_before_stop: null, sender_uploads_enabled: true, updated_at: null, updated_by: null, note: null },
        ],
        profiles: [{ id: 'u-admin', full_name: 'Сергей', email: 's@polza.ru' }],
        ve_outreach_runs: [{ project_id: 'vp1', status: 'running' }, { project_id: 'vp2', status: 'active' }],
        ve_projects: [{ id: 'vp1', market: 'ru' }, { id: 'vp2', market: 'ru' }],
        ve_sender_global_settings: [{ id: true, sending_enabled: true, sending_changed_at: null, sending_changed_by: null, sending_note: null }],
        ve_sender_sending_pauses: [],
        sender_project_lead_settings: [{ id: true, enabled: true, enabled_at: '2026-10-20T00:00:00Z', disabled_at: null, updated_by: null, note: null }],
        sender_campaigns: [{ id: 'c1', name: 'Клиники', source_kind: 've2', project_id: 'pp1', status: 'running' }],
        sender_reply_qualifications: [],
        sender_project_lead_cards: [],
      },
    });
    const who = { userId: 'u-admin', note: 'инцидент', now: NOW };
    expect(await stopVeLaunches(db as never, { market: 'ru', ...who })).toMatchObject({ changed: true });
    expect(db.getRows('ve_launch_transport_settings')[0]).toMatchObject({ mode: 'instantly', mode_before_stop: 'sender', updated_by: 'u-admin', updated_at: NOW.toISOString() });
    expect(await stopVeLaunches(db as never, { market: 'ru', userId: 'u-other', note: null, now: new Date('2026-10-26T13:00:00Z') })).toMatchObject({ changed: false });
    expect(db.getRows('ve_launch_transport_settings')[0]).toMatchObject({ updated_by: 'u-admin', updated_at: NOW.toISOString() });
    // США никогда не выключали этой панелью — вернуть нечего (включить «Рассылку» отсюда нельзя).
    expect(await restoreVeLaunches(db as never, { market: 'us', ...who })).toMatchObject({ changed: false });
    expect(await setVeSenderUploads(db as never, { market: 'ru', enabled: false, ...who })).toMatchObject({ changed: true });
    expect(await setVeSenderUploads(db as never, { market: 'ru', enabled: false, ...who })).toMatchObject({ changed: false });

    const state = await readVeSenderSwitchState(db as never, { VE2_SENDER_LAUNCHES_DISABLED: 'yes' }, NOW);
    expect(state.env_kill).toBe(true);
    expect(state.markets?.[0]).toMatchObject({
      market: 'ru', label: 'РФ', mode: 'instantly', mode_before_stop: 'sender', sender_uploads_enabled: false,
      updated_by_name: 'Сергей', note: 'инцидент', inflight_outreach_runs: 1,
    });
    expect(state.sending).toMatchObject({ enabled: true, running_campaigns: 1, open_pauses: [] });
    expect((await readVeSenderSwitchState(db as never, { VE2_SENDER_LAUNCHES_DISABLED: '0' }, NOW)).env_kill).toBe(false);

    expect(await restoreVeLaunches(db as never, { market: 'ru', ...who })).toMatchObject({ changed: true });
    expect(db.getRows('ve_launch_transport_settings')[0]).toMatchObject({ mode: 'sender', mode_before_stop: null });

    // Карточки: выключили в 12:00, лид пришёл в 12:30 — при включении «с пропущенными» возвращается отсечка,
    // что была до выключения (не дальше 7 суток): лид, не успевший получить карточку до выключения, тоже придёт.
    expect(await setProjectLeadCards(db as never, { enabled: false, ...who })).toMatchObject({ changed: true });
    await db.from('sender_reply_qualifications').insert({ reply_id: 'r1', recipient_id: 'rc1', campaign_id: 'c1', status: 'lead', qualified_at: '2026-10-26T12:30:00Z' });
    expect((await readVeSenderSwitchState(db as never, {}, NOW)).lead_cards).toMatchObject({ enabled: false, missed_leads: 1, changed_by_name: 'Сергей' });
    const on = await setProjectLeadCards(db as never, { enabled: true, includeMissed: true, userId: 'u-admin', note: null, now: new Date('2026-10-26T14:00:00Z') });
    expect(on.lines[0]).toContain(': 1');
    expect(db.getRows('sender_project_lead_settings')[0]).toMatchObject({ enabled: true, enabled_at: '2026-10-20T00:00:00.000Z' });
  });

  it('«Остановить отправку»: флаг, потом пауза идущих кампаний Движка; «Продолжить» запускает только нетронутые и не закрывает то, что ещё можно запустить', async () => {
    const nowIso = () => new Date().toISOString();
    let batch = 0;
    const db = createMockSupabase({
      tables: {
        ve_sender_global_settings: [{ id: true, sending_enabled: true, sending_changed_at: null, sending_changed_by: null, sending_note: null }],
        ve_sender_sending_pauses: [],
        sender_campaigns: [
          { id: 'A', name: 'A', source_kind: 've2', status: 'running', updated_at: '2026-10-25T00:00:00Z' },
          { id: 'B', name: 'B', source_kind: 've2', status: 'running', updated_at: '2026-10-25T00:00:00Z' },
          { id: 'C', name: 'C', source_kind: 've2', status: 'running', updated_at: '2026-10-25T00:00:00Z' },
          { id: 'E', name: 'E', source_kind: 've2', status: 'running', updated_at: '2026-10-25T00:00:00Z' },
          { id: 'K', name: 'K', source_kind: 've2', status: 'running', updated_at: '2026-10-25T00:00:00Z' },
          { id: 'D', name: 'D', source_kind: 've2', status: 'draft', updated_at: '2026-10-25T00:00:00Z', scheduled_start_at: '2099-01-01T06:00:00Z', scheduled_start_error: null },
          { id: 'M', name: 'Папка', source_kind: 'manual', status: 'running', updated_at: '2026-10-25T00:00:00Z' },
        ],
        sender_recipients: [
          { id: 'ra', campaign_id: 'A', status: 'active' }, { id: 'rb', campaign_id: 'B', status: 'active' },
          { id: 're', campaign_id: 'E', status: 'active' }, { id: 'rk', campaign_id: 'K', status: 'active' },
        ],
      },
      // Функции миграции 20261026_0020 поверх таблиц мока.
      rpcHandlers: {
        ve_sender_pause_running: async (_params, mock) => {
          batch += 1;
          const at = nowIso();
          let paused = 0;
          let unscheduled = 0;
          for (const campaign of mock.getRows('sender_campaigns')) {
            if (campaign.source_kind !== 've2') continue;
            if (campaign.status === 'running') {
              await mock.from('ve_sender_sending_pauses').insert({ id: `p${batch}-${campaign.id}`, batch_id: `b${batch}`, campaign_id: campaign.id, action: 'paused', paused_at: at, prior_status: 'running', resumed_at: null, resume_claimed_until: null, created_at: at });
              await mock.from('sender_campaigns').update({ status: 'paused', updated_at: at }).eq('id', campaign.id);
              paused += 1;
            } else if (['draft', 'paused'].includes(String(campaign.status)) && campaign.scheduled_start_at) {
              await mock.from('ve_sender_sending_pauses').insert({ id: `u${batch}-${campaign.id}`, batch_id: `b${batch}`, campaign_id: campaign.id, action: 'unscheduled', paused_at: at, prior_status: campaign.status, prior_scheduled_start_at: campaign.scheduled_start_at, resumed_at: null, resume_claimed_until: null, created_at: at });
              await mock.from('sender_campaigns').update({ scheduled_start_at: null, updated_at: at }).eq('id', campaign.id);
              unscheduled += 1;
            }
          }
          return { data: { paused, unscheduled, canceled_messages: 0, still_running: 0 } };
        },
        ve_sender_resume_claim: async (params, mock) => {
          const row = mock.getRows('ve_sender_sending_pauses').find((pause) => pause.id === params.p_pause_id);
          if (!row || row.resumed_at || row.resume_claimed_until) return { data: { claimed: false } };
          await mock.from('ve_sender_sending_pauses').update({ resume_claimed_until: '9999-01-01T00:00:00Z' }).eq('id', row.id);
          const campaign = mock.getRows('sender_campaigns').find((c) => c.id === row.campaign_id)!;
          return { data: {
            claimed: true, action: row.action, campaign_id: campaign.id, campaign_status: campaign.status,
            untouched: campaign.updated_at === row.paused_at,
            active_recipients: mock.getRows('sender_recipients').filter((r) => r.campaign_id === campaign.id && r.status === 'active').length,
          } };
        },
        ve_sender_resume_finish: async (params, mock) => {
          const row = mock.getRows('ve_sender_sending_pauses').find((pause) => pause.id === params.p_pause_id);
          if (!row || row.resumed_at) return { data: 'skip' };
          const campaign = mock.getRows('sender_campaigns').find((c) => c.id === row.campaign_id)!;
          const untouched = campaign.updated_at === row.paused_at;
          if (params.p_mode === 'raw_running') {
            const active = mock.getRows('sender_recipients').some((r) => r.campaign_id === campaign.id && r.status === 'active');
            if (!untouched || campaign.status !== 'paused' || active) return { data: 'skip' };
            await mock.from('sender_campaigns').update({ status: 'running', updated_at: nowIso() }).eq('id', campaign.id);
          }
          if (params.p_mode === 'restore_schedule') {
            if (!untouched || campaign.scheduled_start_at) return { data: 'skip' };
            await mock.from('sender_campaigns').update({ scheduled_start_at: row.prior_scheduled_start_at, updated_at: nowIso() }).eq('id', campaign.id);
          }
          await mock.from('ve_sender_sending_pauses').update({ resumed_at: nowIso(), resumed_by: params.p_user, resume_result: params.p_result, resume_claimed_until: null }).eq('id', row.id);
          return { data: 'done' };
        },
      },
    });

    const stop = await stopVeSenderSending(db as never, { userId: 'u-admin', note: 'плохое письмо', now: NOW });
    expect(stop.lines[0]).toBe('Отправка кампаний Движка остановлена.');
    expect(stop.lines[1]).toContain('На паузу: 5, снято назначенных запусков: 1');
    expect(db.getRows('ve_sender_global_settings')[0]).toMatchObject({ sending_enabled: false, sending_changed_by: 'u-admin', sending_changed_at: NOW.toISOString() });
    expect(db.getRows('sender_campaigns').find((c) => c.id === 'M')).toMatchObject({ status: 'running' });
    // Повтор — «остановили ещё раз», кто и когда — первые.
    const again = await stopVeSenderSending(db as never, { userId: 'u-other', note: null, now: new Date('2026-10-26T13:00:00Z') });
    expect(again.lines[0]).toContain('уже была остановлена');
    expect(db.getRows('ve_sender_global_settings')[0]).toMatchObject({ sending_changed_by: 'u-admin' });

    // Специалист после остановки поменял B, администратор оставил K на паузе.
    await db.from('sender_campaigns').update({ updated_at: '2026-10-26T12:30:00Z' }).eq('id', 'B');
    expect(await keepVeCampaignPaused(db as never, { pauseId: 'p1-K', userId: 'u-admin' })).toMatchObject({ changed: true });
    // Строку, которую сейчас запускает «Продолжить отправку», «Оставить на паузе» не закрывает.
    await db.from('ve_sender_sending_pauses').update({ resume_claimed_until: '9999-01-01T00:00:00Z' }).eq('id', 'p1-E');
    expect((await keepVeCampaignPaused(db as never, { pauseId: 'p1-E', userId: 'u-admin' })).lines[0]).toContain('сейчас продолжает');
    await db.from('ve_sender_sending_pauses').update({ resume_claimed_until: null }).eq('id', 'p1-E');
    await db.from('sender_recipients').update({ status: 'replied' }).eq('campaign_id', 'C');
    jest.mocked(startCampaign).mockReset().mockImplementation(async (id: string) => {
      if (id === 'C') throw new SenderOpError('В кампании нет получателей', 422);
      if (id === 'E') throw new SenderOpError('Стоп-листы клиента и проекта не сверены — запуск отложен: timeout', 503);
      await db.from('sender_campaigns').update({ status: 'running' }).eq('id', id);
    });
    const resume = await resumeVeSenderSending(db as never, null, { userId: 'u-admin', note: null });
    expect(jest.mocked(startCampaign).mock.calls.map((call) => call[0])).toEqual(['A', 'C', 'E']);
    const status = Object.fromEntries(db.getRows('sender_campaigns').map((c) => [c.id, c.status]));
    expect(status).toEqual({ A: 'running', B: 'paused', C: 'running', E: 'paused', K: 'paused', D: 'draft', M: 'running' });
    expect(db.getRows('sender_campaigns').find((c) => c.id === 'D')).toMatchObject({ scheduled_start_at: '2099-01-01T06:00:00Z' });
    expect(resume).toMatchObject({ resumed: 2, rescheduled: 1, left_open: 1, stopped_again: false });
    expect(resume.lines.join(' ')).toContain('«B»: изменена после остановки — не трогаем');
    expect(resume.lines.join(' ')).toContain('«E»: стоп-листы клиента и проекта не сверены — повторите позже');
    expect(resume.lines.join(' ')).not.toContain('timeout');
    // Открытой осталась только E — её запустит повторное «Продолжить».
    expect(db.getRows('ve_sender_sending_pauses').filter((pause) => !pause.resumed_at).map((pause) => pause.campaign_id)).toEqual(['E']);

    // Пока шло продолжение, отправку снова остановили — оставшиеся не закрываются «пропущенными».
    await db.from('ve_sender_global_settings').update({ sending_enabled: false }).eq('id', true);
    await db.from('sender_campaigns').update({ status: 'running' }).eq('id', 'A');
    await stopVeSenderSending(db as never, { userId: 'u-admin', note: null });
    jest.mocked(startCampaign).mockReset().mockImplementation(async () => {
      await db.from('ve_sender_global_settings').update({ sending_enabled: false }).eq('id', true);
      throw new SenderOpError('Отправка кампаний Движка остановлена администратором — запуск недоступен', 409, 'VE2_SENDING_STOPPED');
    });
    const interrupted = await resumeVeSenderSending(db as never, null, { userId: 'u-admin', note: null });
    expect(interrupted.stopped_again).toBe(true);
    // Вторая остановка снова взяла A и C (идут) и снятый запуск D; ни одна строка не закрыта «пропущенной».
    expect(db.getRows('ve_sender_sending_pauses').filter((pause) => !pause.resumed_at).map((pause) => pause.campaign_id).sort()).toEqual(['A', 'C', 'D', 'E']);
    expect(db.getRows('sender_campaigns').filter((c) => c.source_kind === 've2' && c.status === 'running')).toEqual([]);
  });
});
