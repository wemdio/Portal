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
import { importRecipients, SenderOpError } from '@/lib/sender/campaignOps';
import { syncProjectContactsFromInstantly } from '@/lib/projectContactsSync';
import { activateDeliveredContactCampaigns } from '@/lib/verticalEngineV2/contactDeliveryActivation';
import { loadVeContactDeliveryCampaignInventory } from '@/lib/verticalEngineV2/contactDeliveryInventory';
import { reconcileContactDeliveries } from '@/lib/verticalEngineV2/contactDeliveryReconciliation';
import { parseLaunchInfo } from '@/lib/verticalEngineV2/launchHandoff';
import { appendLeadsToVeSenderCampaign } from '@/lib/verticalEngineV2/senderTransport/senderAppend';
import {
  decideVeLaunchTransport,
  resolveVeLaunchTransport,
  senderRemoteStatus,
  transportOf,
} from '@/lib/verticalEngineV2/senderTransport/transport';

jest.mock('@/lib/instantly/client', () => ({
  getCampaign: jest.fn(), getCampaignAnalyticsOverview: jest.fn(), listLeads: jest.fn(),
}));
jest.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: {} }));
jest.mock('@/lib/clientReports/ledgerStore', () => ({
  startAppendLedgerBatch: jest.fn(async () => ({ batchId: 'batch-1' })),
  completeAppendLedgerBatch: jest.fn(async () => undefined),
  failAppendLedgerBatch: jest.fn(async () => undefined),
}));
jest.mock('@/lib/sender/campaignOps', () => {
  class SenderOpError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
  }
  return { importRecipients: jest.fn(), SenderOpError };
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
