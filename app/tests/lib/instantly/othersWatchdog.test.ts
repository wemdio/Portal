/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { Email } from '@/lib/instantly/types';

let mockInstantlyDb: MockSupabaseClient | null;

const listEmails = jest.fn();
const listAccounts = jest.fn();
const getAccountCampaignMappings = jest.fn();
const qualifyOneReply = jest.fn();
const getCampaignsByAccountCached = jest.fn();

jest.mock('@/lib/supabaseInstantly', () => ({
  get supabaseInstantly() {
    return mockInstantlyDb;
  },
}));

jest.mock('@/lib/instantly/client', () => ({
  __esModule: true,
  listEmails: (...args: unknown[]) => listEmails(...args),
  listAccounts: (...args: unknown[]) => listAccounts(...args),
  getAccountCampaignMappings: (...args: unknown[]) => getAccountCampaignMappings(...args),
}));

jest.mock('@/lib/instantly/leadQualificationWorker', () => {
  // isTransientQualifyError берём НАСТОЯЩИЙ: тест транзиентной политики должен
  // пинить реальную TRANSIENT_QUALIFY_ERROR_RE, а не её копию — иначе изменение
  // регэкспа в воркере молча разъехалось бы с вотчдогом (находка ревью 16.07).
  const actual = jest.requireActual('@/lib/instantly/leadQualificationWorker');
  return {
    __esModule: true,
    qualifyOneReply: (...args: unknown[]) => qualifyOneReply(...args),
    getCampaignsByAccountCached: (...args: unknown[]) => getCampaignsByAccountCached(...args),
    isTransientQualifyError: actual.isTransientQualifyError,
    // Гейт колонок сирот для error-insert'а: в тестах вотчдога «миграция
    // применена» — true (проверку самого окна «код без миграции» см. в
    // leadQualificationWorker.test.ts).
    strayColumnsSupported: async () => true,
  };
});

jest.mock('@/lib/instantly/leadQualifier', () => ({
  __esModule: true,
  getBodyText: (body: unknown): string => {
    if (!body) return '';
    if (typeof body === 'string') return body;
    const b = body as { text?: string; html?: string };
    return b.text ?? (b.html ?? '').replace(/<[^>]+>/g, ' ');
  },
}));

const OUR_DOMAINS = ['velar-vr.ru', 'mailganer.pro', 'law-russia.tech'];

// Тема кампании velar-vr (по ней сверяется тема ответа). Реальный лид отвечает
// «Re: По вопросу вентиляции «X»» — тот же шаблон.
const CAMPAIGN_SUBJECT = 'По вопросу вентиляции «Техинсервис»';
const SENT_MATCH: Email = {
  id: 'out-1',
  ue_type: 1,
  eaccount: 'elena@velar-vr.ru',
  subject: CAMPAIGN_SUBJECT,
  timestamp_email: '2026-07-15T09:00:00.000Z',
} as Email;

function makeOthersEmail(overrides: Partial<Email> = {}): Email {
  return {
    id: 'others-email-1',
    ue_type: 2,
    from_address_email: 'ruslan@windguard.ru',
    to_address_email_list: 'elena@velar-vr.ru',
    eaccount: 'elena@velar-vr.ru',
    subject: 'Re: По вопросу вентиляции «Виндгард»',
    body: { text: 'Опросник во вложении. От кого: elena@velar-vr.ru' },
    thread_id: 'thread-1',
    timestamp_email: '2026-07-16T10:00:00.000Z',
    ...overrides,
  } as Email;
}

async function importWatchdog() {
  return import('@/lib/instantly/othersWatchdog');
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();

  process.env.OPENROUTER_INSTANTLY_LEAD_API_KEY = 'test-key';
  process.env.INSTANTLY_OTHERS_PAGES = '1';
  process.env.INSTANTLY_LEADS_INTER_REPLY_DELAY_MS = '1000';
  process.env.INSTANTLY_OTHERS_PROBE_DELAY_MS = '200';
  delete process.env.INSTANTLY_OTHERS_MAX_PER_TICK;
  delete process.env.INSTANTLY_OTHERS_SENT_TTL_MS;
  delete process.env.INSTANTLY_OTHERS_SENT_CACHE_MAX;
  delete process.env.INSTANTLY_OTHERS_PROBE_BUDGET;

  mockInstantlyDb = createMockSupabase({ tables: { instantly_lead_qualifications: [] } });

  listAccounts.mockResolvedValue({
    items: [
      { email: 'elena@velar-vr.ru' },
      { email: 'irina@velar-vr.ru' },
      { email: 'olga@mailganer.pro' },
      { email: 'aleksandr@law-russia.tech' },
    ],
    next_starting_after: null,
  });
  getAccountCampaignMappings.mockResolvedValue([
    { campaign_id: 'camp-velar', status: 1, timestamp_created: '2026-07-01T00:00:00.000Z' },
  ]);
  getCampaignsByAccountCached.mockResolvedValue(
    new Map([['main', new Set(['camp-velar'])]]),
  );
  qualifyOneReply.mockResolvedValue(undefined);

  // Дефолт: страница Others → один кандидат; sent любой кампании → письмо с темой,
  // совпадающей с ответом (та же шаблон-тема «По вопросу вентиляции»).
  listEmails.mockImplementation(async (params: { mode?: string; email_type?: string }) => {
    if (params.mode === 'emode_others') {
      return { items: [makeOthersEmail()], next_starting_after: null };
    }
    if (params.email_type === 'sent') {
      return { items: [SENT_MATCH], next_starting_after: null };
    }
    return { items: [], next_starting_after: null };
  });
});

describe('screenOthersEmail', () => {
  async function screen(email: Email) {
    const { screenOthersEmail } = await importWatchdog();
    return screenOthersEmail(email, new Set(OUR_DOMAINS));
  }

  it('отсекает внутренний прогрев (отправитель с нашего домена)', async () => {
    const res = await screen(makeOthersEmail({ from_address_email: 'irina@velar-vr.ru' }));
    expect(res.verdict).toBe('internal');
  });

  it('отсекает DMARC-репорты, хотя они цитируют наш домен в теме', async () => {
    const res = await screen(
      makeOthersEmail({
        from_address_email: 'noreply-dmarc@x5.ru',
        subject: 'Report Domain: velar-vr.ru Submitter: x5.ru',
        body: { text: 'This is an aggregate DMARC report from x5.ru' },
      }),
    );
    expect(['dmarc', 'role']).toContain(res.verdict);
  });

  it('отсекает машинные role-адреса (postmaster@ и т.п.)', async () => {
    const res = await screen(
      makeOthersEmail({
        from_address_email: 'postmaster@ludinovocable.ru',
        subject: 'Undeliverable: письмо про velar-vr.ru',
      }),
    );
    expect(res.verdict).toBe('role');
  });

  it('отсекает спам/прогрев без цитаты нашего домена', async () => {
    const res = await screen(
      makeOthersEmail({
        from_address_email: 'support@bearbitr.ru',
        subject: 'ГорДом складской вопрос',
        body: { text: 'Коллеги, подскажите по складу — жду ответа.' },
      }),
    );
    expect(res.verdict).toBe('no-citation');
  });

  it('пропускает живой ответ с ЛИЧНОЙ почты, цитирующий наш домен в теле', async () => {
    const res = await screen(
      makeOthersEmail({
        from_address_email: 'kristall.li@mail.ru',
        subject: 'Re: Вопрос по ликвидации',
        body: { text: 'Слушаю Вас. От кого: aleksandr@law-russia.tech' },
      }),
    );
    expect(res).toEqual({ verdict: 'candidate', citedDomain: 'law-russia.tech' });
  });

  it('матчит цитату по сабдомену (inst.mailganer.pro → mailganer.pro)', async () => {
    const res = await screen(
      makeOthersEmail({
        from_address_email: 'dpo@fknz.ru',
        body: { text: 'Подробнее: https://inst.mailganer.pro/about' },
      }),
    );
    expect(res).toEqual({ verdict: 'candidate', citedDomain: 'mailganer.pro' });
  });

  it('матчит цитату, живущую только в href html-письма (текст срезал бы теги)', async () => {
    const res = await screen(
      makeOthersEmail({
        from_address_email: 'director@hotel.ru',
        body: { html: '<p>посмотрел <a href="https://velar-vr.ru/cases">ваши кейсы</a>, интересно</p>' },
      }),
    );
    expect(res).toEqual({ verdict: 'candidate', citedDomain: 'velar-vr.ru' });
  });

  it('НЕ матчит похожий чужой домен (avelar-vr.ru ≠ velar-vr.ru)', async () => {
    const res = await screen(
      makeOthersEmail({
        from_address_email: 'someone@example.com',
        body: { text: 'Посмотрите на avelar-vr.ru — интересный сайт' },
      }),
    );
    expect(res.verdict).toBe('no-citation');
  });
});

describe('pollOthersOnce', () => {
  it('квалифицирует ответ, чья тема совпала с темой кампании, с правильным контекстом', async () => {
    const { pollOthersOnce } = await importWatchdog();
    const processed = await pollOthersOnce();

    expect(processed).toBe(1);
    expect(qualifyOneReply).toHaveBeenCalledTimes(1);
    const [, reply, apiKey, accountId, ctx, opts] = qualifyOneReply.mock.calls[0];
    expect((reply as Email).campaign_id).toBe('camp-velar');
    expect((reply as Email).id).toBe('others-email-1');
    expect(apiKey).toBe('test-key');
    expect(accountId).toBe('main');
    const context = ctx as {
      replyEmail: Email;
      lastOutbound: Email | null;
      campaignOutboundMailboxes?: string[];
    };
    expect(context.replyEmail.id).toBe('others-email-1');
    // lastOutbound = ИМЕННО совпавшее по теме исходящее (точный контекст пича).
    expect(context.lastOutbound?.id).toBe('out-1');
    expect(context.campaignOutboundMailboxes).toContain('elena@velar-vr.ru');
    expect(opts).toMatchObject({
      clientDmOnlyOnLead: true,
      prefetchedParentMatched: true,
    });
  });

  it('не доверяет первому совпадению, если одна тема подходит двум кампаниям', async () => {
    getAccountCampaignMappings.mockResolvedValue([
      { campaign_id: 'camp-owner-a', status: 1 },
      { campaign_id: 'camp-owner-b', status: 1 },
    ]);
    getCampaignsByAccountCached.mockResolvedValue(
      new Map([['main', new Set(['camp-owner-a', 'camp-owner-b'])]]),
    );
    listEmails.mockImplementation(async (params: {
      mode?: string;
      email_type?: string;
      campaign_id?: string;
    }) => {
      if (params.mode === 'emode_others') {
        return { items: [makeOthersEmail()], next_starting_after: null };
      }
      if (params.email_type === 'sent') {
        return {
          items: [{ ...SENT_MATCH, id: `out-${params.campaign_id}` }],
          next_starting_after: null,
        };
      }
      return { items: [], next_starting_after: null };
    });

    const { pollOthersOnce } = await importWatchdog();
    expect(await pollOthersOnce()).toBe(1);
    expect(qualifyOneReply).toHaveBeenCalledTimes(1);
    const [, reply, , , , opts] = qualifyOneReply.mock.calls[0];
    expect((reply as Email).campaign_id).toBe('camp-owner-a');
    expect(opts).toMatchObject({ prefetchedParentMatched: false });
    expect(listEmails.mock.calls.filter(
      ([params]) => (params as { email_type?: string }).email_type === 'sent',
    )).toHaveLength(1);
  });

  it('помечает сироту: у Others-письма нет campaign_id → opts.outOfCampaign=true (инцидент 11.08)', async () => {
    // Детектор из брифа: исходное письмо НЕ привязано Instantly (campaign_id
    // пуст — проверено живьём 500/500), атрибуция сделана нами по домену →
    // честный DM «Ответ вне треда кампании» + колонка reply_out_of_campaign.
    const { pollOthersOnce } = await importWatchdog();
    await pollOthersOnce();

    expect(qualifyOneReply).toHaveBeenCalledTimes(1);
    const [, reply, , , , opts] = qualifyOneReply.mock.calls[0];
    // Воркеру передаём атрибутированную кампанию (для guard'ов/upsert'ов)…
    expect((reply as Email).campaign_id).toBe('camp-velar');
    // …но сироту помечаем отдельным флагом, НЕ подменяя факт привязки.
    expect(opts).toMatchObject({
      clientDmOnlyOnLead: true,
      outOfCampaign: true,
      prefetchedParentMatched: true,
    });
  });

  it('НЕ сирота, если у Others-письма campaign_id совпал с атрибутированным → outOfCampaign=false', async () => {
    // Гипотетический случай (вживую Instantly Others без campaign_id): письмо
    // уже привязано к той же кампании — детектор молчит.
    listEmails.mockImplementation(async (params: { mode?: string; email_type?: string }) => {
      if (params.mode === 'emode_others') {
        return {
          items: [makeOthersEmail({ campaign_id: 'camp-velar' } as Partial<Email>)],
          next_starting_after: null,
        };
      }
      if (params.email_type === 'sent') {
        return { items: [SENT_MATCH], next_starting_after: null };
      }
      return { items: [], next_starting_after: null };
    });
    const { pollOthersOnce } = await importWatchdog();
    await pollOthersOnce();

    expect(qualifyOneReply).toHaveBeenCalledTimes(1);
    const [, , , , , opts] = qualifyOneReply.mock.calls[0];
    expect(opts).toMatchObject({
      outOfCampaign: false,
      prefetchedParentMatched: true,
    });
  });

  it('ЛИД С ЛИЧНОЙ ПОЧТЫ (слали на корпоративный): тема совпала → берём, адрес не важен', async () => {
    // Ровно кейс, ради которого фича: человек отвечает с личного mail.ru, мы на
    // этот адрес не слали — но тема ответа = тема кампании.
    listEmails.mockImplementation(async (params: { mode?: string; email_type?: string }) => {
      if (params.mode === 'emode_others') {
        return {
          items: [
            makeOthersEmail({
              from_address_email: 'ivan.personal@mail.ru',
              subject: 'Re: По вопросу вентиляции «Виндгард»',
              body: { text: 'Интересно, давайте обсудим. От кого: elena@velar-vr.ru' },
            }),
          ],
          next_starting_after: null,
        };
      }
      if (params.email_type === 'sent') {
        return { items: [SENT_MATCH], next_starting_after: null };
      }
      return { items: [], next_starting_after: null };
    });
    const { pollOthersOnce } = await importWatchdog();
    const processed = await pollOthersOnce();

    expect(processed).toBe(1);
    expect((qualifyOneReply.mock.calls[0][1] as Email).campaign_id).toBe('camp-velar');
  });

  it('WARMUP: цитирует наш домен, но тема ФЕЙКОВАЯ (кампания её не слала) → дроп', async () => {
    // Инцидент 17.07: v.vasileva@momlife.work, тема «Стратегия НеоСтиль Опт сессия»
    // — кампания velar-vr такого не слала → дроп, никакой строки.
    listEmails.mockImplementation(async (params: { mode?: string; email_type?: string }) => {
      if (params.mode === 'emode_others') {
        return {
          items: [
            makeOthersEmail({
              from_address_email: 'v.vasileva@momlife.work',
              subject: 'Re: Стратегия НеоСтиль Опт сессия',
              body: { text: 'Да, подключусь, подготовлю KPI. С теплом, Валерия. От: elena@velar-vr.ru' },
            }),
          ],
          next_starting_after: null,
        };
      }
      if (params.email_type === 'sent') {
        return { items: [SENT_MATCH], next_starting_after: null };
      }
      return { items: [], next_starting_after: null };
    });
    const { pollOthersOnce } = await importWatchdog();
    const processed = await pollOthersOnce();

    expect(processed).toBe(0);
    expect(qualifyOneReply).not.toHaveBeenCalled();
    expect(mockInstantlyDb?.inserts).toHaveLength(0);
  });

  it('пропускает письмо, уже обработанное ранее (дедуп по instantly_email_id)', async () => {
    mockInstantlyDb = createMockSupabase({
      tables: {
        instantly_lead_qualifications: [{ instantly_email_id: 'others-email-1' }],
      },
    });
    const { pollOthersOnce } = await importWatchdog();
    const processed = await pollOthersOnce();

    expect(processed).toBe(0);
    expect(qualifyOneReply).not.toHaveBeenCalled();
  });

  it('пропускает домен без квалифицируемой кампании (Coldy/Trigga-прогрев) без записи', async () => {
    getAccountCampaignMappings.mockResolvedValue([]);
    const { pollOthersOnce } = await importWatchdog();
    const processed = await pollOthersOnce();

    expect(processed).toBe(0);
    expect(qualifyOneReply).not.toHaveBeenCalled();
    expect(mockInstantlyDb?.inserts).toHaveLength(0);
  });

  it('перебирает ящики домена: первый без маппингов не ослепляет весь домен', async () => {
    getAccountCampaignMappings.mockImplementation(async (mailbox: string) =>
      mailbox === 'irina@velar-vr.ru'
        ? [{ campaign_id: 'camp-velar', status: 1, timestamp_created: '2026-07-01T00:00:00.000Z' }]
        : [],
    );
    const { pollOthersOnce } = await importWatchdog();
    const processed = await pollOthersOnce();

    expect(processed).toBe(1);
    expect(getAccountCampaignMappings).toHaveBeenCalledWith('elena@velar-vr.ru');
    expect(getAccountCampaignMappings).toHaveBeenCalledWith('irina@velar-vr.ru');
  });

  it('НЕ атрибуцирует при пустой квалифицируемой поверхности (возможный блип БД)', async () => {
    getCampaignsByAccountCached.mockResolvedValue(new Map([['main', new Set()]]));
    const { pollOthersOnce } = await importWatchdog();
    const processed = await pollOthersOnce();

    expect(processed).toBe(0);
    expect(qualifyOneReply).not.toHaveBeenCalled();
    expect(getAccountCampaignMappings).not.toHaveBeenCalled();
  });

  it('пропускает кампанию, не входящую в квалифицируемый набор', async () => {
    getCampaignsByAccountCached.mockResolvedValue(new Map([['main', new Set(['other-camp'])]]));
    const { pollOthersOnce } = await importWatchdog();
    const processed = await pollOthersOnce();

    expect(processed).toBe(0);
    expect(qualifyOneReply).not.toHaveBeenCalled();
  });

  it('выбирает кампанию, чьи ТЕМЫ совпали с ответом (а не первую попавшуюся)', async () => {
    getAccountCampaignMappings.mockResolvedValue([
      { campaign_id: 'camp-new', status: 1, timestamp_created: '2026-07-10T00:00:00.000Z' },
      { campaign_id: 'camp-velar', status: 1, timestamp_created: '2026-06-01T00:00:00.000Z' },
    ]);
    getCampaignsByAccountCached.mockResolvedValue(
      new Map([['main', new Set(['camp-new', 'camp-velar'])]]),
    );
    // Тема ответа «По вопросу вентиляции» есть только у camp-velar; camp-new
    // (новее, пробуется первой) слал про другое.
    listEmails.mockImplementation(
      async (params: { mode?: string; email_type?: string; campaign_id?: string }) => {
        if (params.mode === 'emode_others') {
          return { items: [makeOthersEmail()], next_starting_after: null };
        }
        if (params.email_type === 'sent') {
          if (params.campaign_id === 'camp-velar') {
            return { items: [SENT_MATCH], next_starting_after: null };
          }
          return {
            items: [{ id: 'out-x', ue_type: 1, eaccount: 'a@velar-vr.ru', subject: 'Учёт рыбы и морепродуктов' }],
            next_starting_after: null,
          };
        }
        return { items: [], next_starting_after: null };
      },
    );
    const { pollOthersOnce } = await importWatchdog();
    const processed = await pollOthersOnce();

    expect(processed).toBe(1);
    expect((qualifyOneReply.mock.calls[0][1] as Email).campaign_id).toBe('camp-velar');
  });

  it('транзиентный сбой квалификации НЕ пишет строку (письмо перепробуется)', async () => {
    qualifyOneReply.mockRejectedValue(new Error('Instantly API 503: overloaded'));
    const { pollOthersOnce } = await importWatchdog();
    const processed = await pollOthersOnce();

    expect(processed).toBe(0);
    expect(mockInstantlyDb?.inserts).toHaveLength(0);
  });

  it('постоянный сбой квалификации пишет error-строку для видимости', async () => {
    qualifyOneReply.mockRejectedValue(new Error('malformed payload'));
    const { pollOthersOnce } = await importWatchdog();
    const processed = await pollOthersOnce();

    expect(processed).toBe(0);
    expect(mockInstantlyDb?.inserts).toHaveLength(1);
    expect(mockInstantlyDb?.inserts[0].rows[0]).toMatchObject({
      instantly_email_id: 'others-email-1',
      status: 'error',
    });
  });

  it('падение fetch тем кампании откладывает письмо, НЕ дропает как warmup', async () => {
    // sent-запрос падает → тему проверить нельзя → не квалифицируем, но и не
    // помечаем warmup (строки нет, попробуем на следующем тике).
    listEmails.mockImplementation(async (params: { mode?: string; email_type?: string }) => {
      if (params.mode === 'emode_others') {
        return { items: [makeOthersEmail()], next_starting_after: null };
      }
      if (params.email_type === 'sent') {
        throw new Error('Instantly API 503');
      }
      return { items: [], next_starting_after: null };
    });
    const { pollOthersOnce } = await importWatchdog();
    const processed = await pollOthersOnce();

    expect(processed).toBe(0);
    expect(qualifyOneReply).not.toHaveBeenCalled();
    expect(mockInstantlyDb?.inserts).toHaveLength(0);
  });

  it('падение дедуп-запроса откладывает тик (не рискует повторным алертом)', async () => {
    mockInstantlyDb = createMockSupabase({
      tables: { instantly_lead_qualifications: [] },
      errorTables: { instantly_lead_qualifications: 'connection reset' },
    });
    const { pollOthersOnce } = await importWatchdog();
    const processed = await pollOthersOnce();

    expect(processed).toBe(0);
    expect(qualifyOneReply).not.toHaveBeenCalled();
  });

  it('из нескольких писем одного отправителя берёт новейшее (даже если оно позже в списке)', async () => {
    listEmails.mockImplementation(async (params: { mode?: string; email_type?: string }) => {
      if (params.mode === 'emode_others') {
        return {
          items: [
            makeOthersEmail({ id: 'older', timestamp_email: '2026-07-16T08:00:00.000Z' }),
            makeOthersEmail({ id: 'newer', timestamp_email: '2026-07-16T12:00:00.000Z' }),
          ],
          next_starting_after: null,
        };
      }
      if (params.email_type === 'sent') {
        return { items: [SENT_MATCH], next_starting_after: null };
      }
      return { items: [], next_starting_after: null };
    });
    const { pollOthersOnce } = await importWatchdog();
    const processed = await pollOthersOnce();

    expect(processed).toBe(1);
    expect(qualifyOneReply).toHaveBeenCalledTimes(1);
    expect((qualifyOneReply.mock.calls[0][1] as Email).id).toBe('newer');
  });

  it('уже обработанное новейшее письмо НЕ затеняет раннее необработанное того же отправителя', async () => {
    mockInstantlyDb = createMockSupabase({
      tables: { instantly_lead_qualifications: [{ instantly_email_id: 'newer' }] },
    });
    listEmails.mockImplementation(async (params: { mode?: string; email_type?: string }) => {
      if (params.mode === 'emode_others') {
        return {
          items: [
            makeOthersEmail({ id: 'newer', timestamp_email: '2026-07-16T12:00:00.000Z' }),
            makeOthersEmail({ id: 'older', timestamp_email: '2026-07-16T08:00:00.000Z' }),
          ],
          next_starting_after: null,
        };
      }
      if (params.email_type === 'sent') {
        return { items: [SENT_MATCH], next_starting_after: null };
      }
      return { items: [], next_starting_after: null };
    });
    const { pollOthersOnce } = await importWatchdog();
    const processed = await pollOthersOnce();

    expect(processed).toBe(1);
    expect((qualifyOneReply.mock.calls[0][1] as Email).id).toBe('older');
  });

  it('один человек, ответивший на аутрич ДВУХ клиентов, даёт две квалификации', async () => {
    getAccountCampaignMappings.mockImplementation(async (mailbox: string) => {
      if (mailbox.endsWith('velar-vr.ru')) {
        return [{ campaign_id: 'camp-velar', status: 1, timestamp_created: '2026-07-01T00:00:00.000Z' }];
      }
      return [{ campaign_id: 'camp-law', status: 1, timestamp_created: '2026-07-01T00:00:00.000Z' }];
    });
    getCampaignsByAccountCached.mockResolvedValue(
      new Map([['main', new Set(['camp-velar', 'camp-law'])]]),
    );
    listEmails.mockImplementation(async (params: { mode?: string; email_type?: string }) => {
      if (params.mode === 'emode_others') {
        return {
          items: [
            makeOthersEmail({ id: 'reply-velar', body: { text: 'Ответ. От: elena@velar-vr.ru' } }),
            makeOthersEmail({
              id: 'reply-law',
              body: { text: 'Ответ. От: aleksandr@law-russia.tech' },
              timestamp_email: '2026-07-16T09:00:00.000Z',
            }),
          ],
          next_starting_after: null,
        };
      }
      // Обе кампании слали тему, совпадающую с ответом.
      if (params.email_type === 'sent') {
        return { items: [SENT_MATCH], next_starting_after: null };
      }
      return { items: [], next_starting_after: null };
    });
    const { pollOthersOnce } = await importWatchdog();
    const processed = await pollOthersOnce();

    expect(processed).toBe(2);
    const qualifiedIds = qualifyOneReply.mock.calls.map((c) => (c[1] as Email).id).sort();
    expect(qualifiedIds).toEqual(['reply-law', 'reply-velar']);
  });

  it('неатрибуцируемые кандидаты НЕ съедают потолок попыток на тик', async () => {
    process.env.INSTANTLY_OTHERS_MAX_PER_TICK = '1';
    getAccountCampaignMappings.mockImplementation(async (mailbox: string) =>
      mailbox.endsWith('velar-vr.ru')
        ? [{ campaign_id: 'camp-velar', status: 1, timestamp_created: '2026-07-01T00:00:00.000Z' }]
        : [],
    );
    listEmails.mockImplementation(async (params: { mode?: string; email_type?: string }) => {
      if (params.mode === 'emode_others') {
        return {
          items: [
            makeOthersEmail({
              id: 'warmup-cited',
              from_address_email: 'lead1@corp.ru',
              body: { text: 'Ответ. От: aleksandr@law-russia.tech' },
              timestamp_email: '2026-07-16T12:00:00.000Z',
            }),
            makeOthersEmail({
              id: 'real-reply',
              from_address_email: 'lead2@corp2.ru',
              body: { text: 'Ответ. От: elena@velar-vr.ru' },
              timestamp_email: '2026-07-16T08:00:00.000Z',
            }),
          ],
          next_starting_after: null,
        };
      }
      if (params.email_type === 'sent') {
        return { items: [SENT_MATCH], next_starting_after: null };
      }
      return { items: [], next_starting_after: null };
    });
    // law-russia.tech не атрибуцируется (маппинги пусты) → скип БЕЗ попытки;
    // единственный слот достаётся реальному ответу.
    const { pollOthersOnce } = await importWatchdog();
    const processed = await pollOthersOnce();

    expect(processed).toBe(1);
    expect((qualifyOneReply.mock.calls[0][1] as Email).id).toBe('real-reply');
  });

  // ── Ужесточение сабж-матча (swarm-ревью 25.07): коллизии generic-тем ──────

  it('WARMUP-КОЛЛИЗИЯ клише: префикс 25 «Коммерческое предложение…» < 70% темы → дроп', async () => {
    // Две несвязанные темы с общим generic-началом: 25 общих символов проходили
    // старый порог ≥15, но это чистое клише — покрытие меньшей темы лишь 62%.
    listEmails.mockImplementation(async (params: { mode?: string; email_type?: string }) => {
      if (params.mode === 'emode_others') {
        return {
          items: [
            makeOthersEmail({
              from_address_email: 'warmup-persona@bm-technology.ru',
              subject: 'Re: Коммерческое предложение для ООО Ромашка',
            }),
          ],
          next_starting_after: null,
        };
      }
      if (params.email_type === 'sent') {
        return {
          items: [
            { id: 'out-kp', ue_type: 1, eaccount: 'elena@velar-vr.ru', subject: 'Коммерческое предложение — оптовым клиентам' },
          ],
          next_starting_after: null,
        };
      }
      return { items: [], next_starting_after: null };
    });
    const { pollOthersOnce } = await importWatchdog();
    const processed = await pollOthersOnce();

    expect(processed).toBe(0);
    expect(qualifyOneReply).not.toHaveBeenCalled();
    expect(mockInstantlyDb?.inserts).toHaveLength(0);
  });

  it('WARMUP-КОЛЛИЗИЯ короткого шаблона: «Re: Добрый день!» ≠ «Добрый день» → дроп', async () => {
    // Вложенность шаблонов теперь требует меньший ≥15 симв.: короткие generic-
    // приветствия больше не матчатся (старый порог 8 пропускал).
    listEmails.mockImplementation(async (params: { mode?: string; email_type?: string }) => {
      if (params.mode === 'emode_others') {
        return {
          items: [makeOthersEmail({ subject: 'Re: Добрый день!' })],
          next_starting_after: null,
        };
      }
      if (params.email_type === 'sent') {
        return {
          items: [{ id: 'out-dd', ue_type: 1, eaccount: 'elena@velar-vr.ru', subject: 'Добрый день' }],
          next_starting_after: null,
        };
      }
      return { items: [], next_starting_after: null };
    });
    const { pollOthersOnce } = await importWatchdog();
    const processed = await pollOthersOnce();

    expect(processed).toBe(0);
    expect(qualifyOneReply).not.toHaveBeenCalled();
  });

  it('префикс-матч с покрытием ≥70% и границей слова — легитимный ответ берётся', async () => {
    // Лид слегка переформулировал хвост темы; общая часть ≥70% и обрыв на
    // не-букве → матч должен сохраниться (ужесточение не убило recall здесь).
    listEmails.mockImplementation(async (params: { mode?: string; email_type?: string }) => {
      if (params.mode === 'emode_others') {
        return {
          items: [
            makeOthersEmail({ subject: 'Re: Поставка металлопроката: цены, сроки, наличие' }),
          ],
          next_starting_after: null,
        };
      }
      if (params.email_type === 'sent') {
        return {
          items: [
            { id: 'out-pm', ue_type: 1, eaccount: 'elena@velar-vr.ru', subject: 'Поставка металлопроката: цены и сроки' },
          ],
          next_starting_after: null,
        };
      }
      return { items: [], next_starting_after: null };
    });
    const { pollOthersOnce } = await importWatchdog();
    const processed = await pollOthersOnce();

    expect(processed).toBe(1);
    expect((qualifyOneReply.mock.calls[0][1] as Email).campaign_id).toBe('camp-velar');
  });

  it('WARMUP-КОЛЛИЗИЯ: префикс ≥70%, но обрыв ПОСРЕДИ СЛОВА → дроп', async () => {
    // «Автоматизация отдела продаж» vs «автоматизация отдела промо-рассылок»:
    // 24 общих символа (≥70% от 27), но расходятся буква-в-букву — типичная
    // warmup-коллизия на деловом клише.
    listEmails.mockImplementation(async (params: { mode?: string; email_type?: string }) => {
      if (params.mode === 'emode_others') {
        return {
          items: [
            makeOthersEmail({
              from_address_email: 'persona@future-group.ru',
              subject: 'Re: Автоматизация отдела промо-рассылок',
            }),
          ],
          next_starting_after: null,
        };
      }
      if (params.email_type === 'sent') {
        return {
          items: [
            { id: 'out-au', ue_type: 1, eaccount: 'elena@velar-vr.ru', subject: 'Автоматизация отдела продаж' },
          ],
          next_starting_after: null,
        };
      }
      return { items: [], next_starting_after: null };
    });
    const { pollOthersOnce } = await importWatchdog();
    const processed = await pollOthersOnce();

    expect(processed).toBe(0);
    expect(qualifyOneReply).not.toHaveBeenCalled();
  });

  // ── fetchCampaignSent: флап пустых ответов Instantly ──────────────────────

  it('флап Instantly (пусто sent) → один ретрай, реальный лид НЕ теряется', async () => {
    let sentCalls = 0;
    listEmails.mockImplementation(async (params: { mode?: string; email_type?: string }) => {
      if (params.mode === 'emode_others') {
        return { items: [makeOthersEmail()], next_starting_after: null };
      }
      if (params.email_type === 'sent') {
        sentCalls++;
        return sentCalls === 1
          ? { items: [], next_starting_after: null } // флап
          : { items: [SENT_MATCH], next_starting_after: null };
      }
      return { items: [], next_starting_after: null };
    });
    const { pollOthersOnce } = await importWatchdog();
    const processed = await pollOthersOnce();

    expect(processed).toBe(1);
    expect(sentCalls).toBe(2);
  });

  it('пустой sent дважды НЕ кэшируется: следующий тик перепроверяет (нет 10-мин слепоты)', async () => {
    let sentCalls = 0;
    listEmails.mockImplementation(async (params: { mode?: string; email_type?: string }) => {
      if (params.mode === 'emode_others') {
        return { items: [makeOthersEmail()], next_starting_after: null };
      }
      if (params.email_type === 'sent') {
        sentCalls++;
        return { items: [], next_starting_after: null };
      }
      return { items: [], next_starting_after: null };
    });
    const { pollOthersOnce } = await importWatchdog();
    expect(await pollOthersOnce()).toBe(0); // два пустых → warmup-дроп, строки нет
    expect(qualifyOneReply).not.toHaveBeenCalled();
    expect(await pollOthersOnce()).toBe(0); // второй тик — sent перезапрошен заново
    expect(sentCalls).toBe(4); // 2 тика × (попытка + ретрай)
  });

  it('кэш sent-тем с капом вытесняет самую старую запись (защита от OOM-разрастания)', async () => {
    process.env.INSTANTLY_OTHERS_SENT_CACHE_MAX = '1';
    getAccountCampaignMappings.mockImplementation(async (mailbox: string) =>
      mailbox.endsWith('velar-vr.ru')
        ? [{ campaign_id: 'camp-velar', status: 1, timestamp_created: '2026-07-01T00:00:00.000Z' }]
        : [{ campaign_id: 'camp-law', status: 1, timestamp_created: '2026-07-01T00:00:00.000Z' }],
    );
    getCampaignsByAccountCached.mockResolvedValue(
      new Map([['main', new Set(['camp-velar', 'camp-law'])]]),
    );
    let othersCalls = 0;
    const sentCalls: string[] = [];
    listEmails.mockImplementation(
      async (params: { mode?: string; email_type?: string; campaign_id?: string }) => {
        if (params.mode === 'emode_others') {
          othersCalls++;
          // Тики 1 и 3 — письмо на velar, тик 2 — на law.
          return othersCalls % 2 === 1
            ? { items: [makeOthersEmail()], next_starting_after: null }
            : {
                items: [
                  makeOthersEmail({
                    id: 'reply-law',
                    body: { text: 'Ответ. От: aleksandr@law-russia.tech' },
                  }),
                ],
                next_starting_after: null,
              };
        }
        if (params.email_type === 'sent') {
          sentCalls.push(params.campaign_id ?? '');
          return { items: [SENT_MATCH], next_starting_after: null };
        }
        return { items: [], next_starting_after: null };
      },
    );
    const { pollOthersOnce } = await importWatchdog();
    expect(await pollOthersOnce()).toBe(1); // кэш {camp-velar}
    expect(await pollOthersOnce()).toBe(1); // camp-law вытесняет camp-velar (кап=1)
    expect(await pollOthersOnce()).toBe(1); // camp-velar вытеснен → перезапрос
    expect(sentCalls.filter((id) => id === 'camp-velar')).toHaveLength(2);
    expect(sentCalls.filter((id) => id === 'camp-law')).toHaveLength(1);
  });

  it('пустая env INSTANTLY_OTHERS_SENT_TTL_MS = дефолтный TTL, а не «кэш выключен»', async () => {
    process.env.INSTANTLY_OTHERS_SENT_TTL_MS = '';
    let sentCalls = 0;
    listEmails.mockImplementation(async (params: { mode?: string; email_type?: string }) => {
      if (params.mode === 'emode_others') {
        return { items: [makeOthersEmail()], next_starting_after: null };
      }
      if (params.email_type === 'sent') {
        sentCalls++;
        return { items: [SENT_MATCH], next_starting_after: null };
      }
      return { items: [], next_starting_after: null };
    });
    const { pollOthersOnce } = await importWatchdog();
    expect(await pollOthersOnce()).toBe(1);
    expect(await pollOthersOnce()).toBe(1);
    // TTL не обнулился: второй тик отработал по кэшу, без перезапроса sent.
    expect(sentCalls).toBe(1);
  });

  // ── Бюджет проб на тик (нагрузка на Instantly API) ────────────────────────

  it('бюджет проб на тик: исчерпание откладывает кандидатов на следующий тик (не дроп)', async () => {
    // Два кандидата, бюджет 2: mappings(velar) + sent(camp-velar) съедают тик,
    // law откладывается. Следующий тик: velar обслуживается из кэшей (0 проб),
    // law доезжает. Никто не дропнут, строк неписаных нет.
    process.env.INSTANTLY_OTHERS_PROBE_BUDGET = '2';
    getAccountCampaignMappings.mockImplementation(async (mailbox: string) =>
      mailbox.endsWith('velar-vr.ru')
        ? [{ campaign_id: 'camp-velar', status: 1, timestamp_created: '2026-07-01T00:00:00.000Z' }]
        : [{ campaign_id: 'camp-law', status: 1, timestamp_created: '2026-07-01T00:00:00.000Z' }],
    );
    getCampaignsByAccountCached.mockResolvedValue(
      new Map([['main', new Set(['camp-velar', 'camp-law'])]]),
    );
    const sentCalls: string[] = [];
    listEmails.mockImplementation(
      async (params: { mode?: string; email_type?: string; campaign_id?: string }) => {
        if (params.mode === 'emode_others') {
          return {
            items: [
              makeOthersEmail({ id: 'reply-velar', body: { text: 'Ответ. От: elena@velar-vr.ru' } }),
              makeOthersEmail({
                id: 'reply-law',
                body: { text: 'Ответ. От: aleksandr@law-russia.tech' },
                timestamp_email: '2026-07-16T09:00:00.000Z',
              }),
            ],
            next_starting_after: null,
          };
        }
        if (params.email_type === 'sent') {
          sentCalls.push(params.campaign_id ?? '');
          return { items: [SENT_MATCH], next_starting_after: null };
        }
        return { items: [], next_starting_after: null };
      },
    );
    const { pollOthersOnce } = await importWatchdog();

    expect(await pollOthersOnce()).toBe(1); // бюджет 2 исчерпан на velar, law отложен
    expect(sentCalls).toEqual(['camp-velar']);
    expect(getAccountCampaignMappings).toHaveBeenCalledTimes(1);
    expect(mockInstantlyDb?.inserts).toHaveLength(0);

    expect(await pollOthersOnce()).toBe(2); // velar — из кэшей (0 проб), law доехал
    expect(sentCalls).toEqual(['camp-velar', 'camp-law']);
  });

  // ── v2/v3: eaccount-приоритет, сигналы тела, 5 проб ───────────────────────

  it('eaccount-ПРИОРИТЕТ: кампания на 5-м ящике домена — ответ пришёл на него, он и пробуется первым', async () => {
    // Диагноз валидации v1: атрибуция шла по первым 4 ящикам пагинации →
    // кампания на 5+ ящике была перманентной слепой зоной.
    listAccounts.mockResolvedValue({
      items: [
        { email: 'm1@velar-vr.ru' },
        { email: 'm2@velar-vr.ru' },
        { email: 'm3@velar-vr.ru' },
        { email: 'm4@velar-vr.ru' },
        { email: 'elena@velar-vr.ru' }, // 5-й, на него пришёл ответ (eaccount)
      ],
      next_starting_after: null,
    });
    getAccountCampaignMappings.mockImplementation(async (mailbox: string) =>
      mailbox === 'elena@velar-vr.ru'
        ? [{ campaign_id: 'camp-velar', status: 1, timestamp_created: '2026-07-01T00:00:00.000Z' }]
        : [],
    );
    const { pollOthersOnce } = await importWatchdog();
    const processed = await pollOthersOnce();

    expect(processed).toBe(1);
    // eaccount пробуется ПЕРВЫМ, несмотря на 5-е место в пагинации
    expect(getAccountCampaignMappings).toHaveBeenCalledTimes(1);
    expect(getAccountCampaignMappings.mock.calls[0][0]).toBe('elena@velar-vr.ru');
  });

  it('кэш атрибуции изолирован по eaccount: две кампании на разных ящиках одного домена не затеняют друг друга', async () => {
    getAccountCampaignMappings.mockImplementation(async (mailbox: string) => {
      if (mailbox === 'elena@velar-vr.ru') {
        return [{ campaign_id: 'camp-elena', status: 1, timestamp_created: '2026-07-01T00:00:00.000Z' }];
      }
      if (mailbox === 'irina@velar-vr.ru') {
        return [{ campaign_id: 'camp-irina', status: 1, timestamp_created: '2026-07-01T00:00:00.000Z' }];
      }
      return [];
    });
    getCampaignsByAccountCached.mockResolvedValue(
      new Map([['main', new Set(['camp-elena', 'camp-irina'])]]),
    );
    listEmails.mockImplementation(
      async (params: { mode?: string; email_type?: string; campaign_id?: string }) => {
        if (params.mode === 'emode_others') {
          return {
            items: [
              makeOthersEmail({
                id: 'reply-elena',
                eaccount: 'elena@velar-vr.ru',
                subject: 'Re: Тема для Елены',
                timestamp_email: '2026-07-16T12:00:00.000Z',
              }),
              makeOthersEmail({
                id: 'reply-irina',
                from_address_email: 'marina@corp2.ru',
                eaccount: 'irina@velar-vr.ru',
                subject: 'Re: Тема для Ирины',
                timestamp_email: '2026-07-16T09:00:00.000Z',
              }),
            ],
            next_starting_after: null,
          };
        }
        if (params.email_type === 'sent') {
          const subject = params.campaign_id === 'camp-elena' ? 'Тема для Елены' : 'Тема для Ирины';
          return {
            items: [{ id: `out-${params.campaign_id}`, ue_type: 1, eaccount: 'x@velar-vr.ru', subject }],
            next_starting_after: null,
          };
        }
        return { items: [], next_starting_after: null };
      },
    );
    const { pollOthersOnce } = await importWatchdog();
    const processed = await pollOthersOnce();

    expect(processed).toBe(2);
    const byReply = new Map(
      qualifyOneReply.mock.calls.map((c) => [
        (c[1] as Email).id,
        (c[1] as Email).campaign_id,
      ]),
    );
    expect(byReply.get('reply-elena')).toBe('camp-elena');
    expect(byReply.get('reply-irina')).toBe('camp-irina');
  });

  it('сигнал (г): ПУСТАЯ тема, но тема кампании дословно в теле → берём', async () => {
    // Диагноз v1: лид с пустой темой (личная почта) терялся.
    listEmails.mockImplementation(async (params: { mode?: string; email_type?: string }) => {
      if (params.mode === 'emode_others') {
        return {
          items: [
            makeOthersEmail({
              from_address_email: 'ivan.personal@yandex.ru',
              subject: '',
              body: { text: 'Здравствуйте! Давайте обсудим. Речь шла о: По вопросу вентиляции склад Казань. От кого: elena@velar-vr.ru' },
            }),
          ],
          next_starting_after: null,
        };
      }
      if (params.email_type === 'sent') {
        return {
          items: [{ id: 'out-k', ue_type: 1, eaccount: 'elena@velar-vr.ru', subject: 'По вопросу вентиляции склад Казань' }],
          next_starting_after: null,
        };
      }
      return { items: [], next_starting_after: null };
    });
    const { pollOthersOnce } = await importWatchdog();
    const processed = await pollOthersOnce();

    expect(processed).toBe(1);
    expect((qualifyOneReply.mock.calls[0][1] as Email).campaign_id).toBe('camp-velar');
  });

  it('сигнал (д): ручной тред с НОВОЙ темой — берём по цитате тела ≥40 с `>`-префиксами', async () => {
    // Диагноз v1: ручные треды ломают цепочку тем. Почтовик кавычит оригинал
    // построчно — нормализация срезает `>`.
    listEmails.mockImplementation(async (params: { mode?: string; email_type?: string }) => {
      if (params.mode === 'emode_others') {
        return {
          items: [
            makeOthersEmail({
              subject: 'Отчёт по логистике за июль',
              body: {
                text: 'Спасибо, актуально, дайте цену.\n> Добрый день! Пишу вам по вопросу вентиляции производственных помещений.\nОт кого: elena@velar-vr.ru',
              },
            }),
          ],
          next_starting_after: null,
        };
      }
      if (params.email_type === 'sent') {
        return {
          items: [
            {
              id: 'out-b',
              ue_type: 1,
              eaccount: 'elena@velar-vr.ru',
              subject: 'По вопросу вентиляции «Техинсервис»',
              body: { text: 'Добрый день! Пишу вам по вопросу вентиляции производственных помещений.' },
            },
          ],
          next_starting_after: null,
        };
      }
      return { items: [], next_starting_after: null };
    });
    const { pollOthersOnce } = await importWatchdog();
    const processed = await pollOthersOnce();

    expect(processed).toBe(1);
    // lastOutbound — именно то исходящее, чья цитата в теле
    const ctx = qualifyOneReply.mock.calls[0][4] as { lastOutbound: Email | null };
    expect(ctx.lastOutbound?.id).toBe('out-b');
  });

  it('сигнал (д)-негатив: цитата тела короче 40 символов → дроп', async () => {
    listEmails.mockImplementation(async (params: { mode?: string; email_type?: string }) => {
      if (params.mode === 'emode_others') {
        return {
          items: [
            makeOthersEmail({
              subject: 'Совсем другая тема',
              body: { text: '> Привет! Как дела?\nМимо. От: elena@velar-vr.ru' },
            }),
          ],
          next_starting_after: null,
        };
      }
      if (params.email_type === 'sent') {
        return {
          items: [
            {
              id: 'out-s',
              ue_type: 1,
              eaccount: 'elena@velar-vr.ru',
              subject: 'По вопросу вентиляции «Техинсервис»',
              body: { text: 'Привет! Как дела?' },
            },
          ],
          next_starting_after: null,
        };
      }
      return { items: [], next_starting_after: null };
    });
    const { pollOthersOnce } = await importWatchdog();
    const processed = await pollOthersOnce();

    expect(processed).toBe(0);
    expect(qualifyOneReply).not.toHaveBeenCalled();
  });

  it('проба до 5 кампаний: совпадение только у пятой → берётся она', async () => {
    getAccountCampaignMappings.mockResolvedValue([
      { campaign_id: 'camp-1', status: 1, timestamp_created: '2026-07-05T00:00:00.000Z' },
      { campaign_id: 'camp-2', status: 1, timestamp_created: '2026-07-04T00:00:00.000Z' },
      { campaign_id: 'camp-3', status: 1, timestamp_created: '2026-07-03T00:00:00.000Z' },
      { campaign_id: 'camp-4', status: 1, timestamp_created: '2026-07-02T00:00:00.000Z' },
      { campaign_id: 'camp-5', status: 1, timestamp_created: '2026-07-01T00:00:00.000Z' },
    ]);
    getCampaignsByAccountCached.mockResolvedValue(
      new Map([['main', new Set(['camp-1', 'camp-2', 'camp-3', 'camp-4', 'camp-5'])]]),
    );
    const sentCalls: string[] = [];
    listEmails.mockImplementation(
      async (params: { mode?: string; email_type?: string; campaign_id?: string }) => {
        if (params.mode === 'emode_others') {
          return { items: [makeOthersEmail()], next_starting_after: null };
        }
        if (params.email_type === 'sent') {
          sentCalls.push(params.campaign_id ?? '');
          if (params.campaign_id === 'camp-5') {
            return { items: [SENT_MATCH], next_starting_after: null };
          }
          return {
            items: [{ id: `out-${params.campaign_id}`, ue_type: 1, eaccount: 'a@velar-vr.ru', subject: 'Учёт рыбы и морепродуктов' }],
            next_starting_after: null,
          };
        }
        return { items: [], next_starting_after: null };
      },
    );
    const { pollOthersOnce } = await importWatchdog();
    const processed = await pollOthersOnce();

    expect(processed).toBe(1);
    expect((qualifyOneReply.mock.calls[0][1] as Email).campaign_id).toBe('camp-5');
    expect(sentCalls).toEqual(['camp-1', 'camp-2', 'camp-3', 'camp-4', 'camp-5']);
  });
});
