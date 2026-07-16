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

function makeOthersEmail(overrides: Partial<Email> = {}): Email {
  return {
    id: 'others-email-1',
    ue_type: 2,
    from_address_email: 'ruslan@windguard.ru',
    to_address_email_list: 'elena@velar-vr.ru',
    eaccount: 'elena@velar-vr.ru',
    subject: 'Re: По вопросу вентиляции',
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
  delete process.env.INSTANTLY_OTHERS_MAX_PER_TICK;

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

  // Дефолтный маршрут listEmails: страница Others → один кандидат; outbound —
  // одно наше отправленное письмо.
  listEmails.mockImplementation(async (params: { mode?: string; email_type?: string }) => {
    if (params.mode === 'emode_others') {
      return { items: [makeOthersEmail()], next_starting_after: null };
    }
    if (params.email_type === 'sent') {
      return {
        items: [
          {
            id: 'out-1',
            ue_type: 1,
            eaccount: 'elena@velar-vr.ru',
            timestamp_email: '2026-07-15T09:00:00.000Z',
            body: { text: 'Наше письмо' },
          },
        ],
        next_starting_after: null,
      };
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
  it('квалифицирует нового кандидата через qualifyOneReply с атрибуцией кампании', async () => {
    const { pollOthersOnce } = await importWatchdog();
    const processed = await pollOthersOnce();

    expect(processed).toBe(1);
    expect(qualifyOneReply).toHaveBeenCalledTimes(1);
    const [, reply, apiKey, accountId, ctx, opts] = qualifyOneReply.mock.calls[0];
    expect((reply as Email).campaign_id).toBe('camp-velar');
    expect((reply as Email).id).toBe('others-email-1');
    expect(apiKey).toBe('test-key');
    expect(accountId).toBe('main');
    // Контекст синтезирован: replyEmail = само Others-письмо, исходящие — из
    // отдельного запроса по кампании.
    const context = ctx as {
      replyEmail: Email;
      lastOutbound: Email | null;
      campaignOutboundMailboxes?: string[];
    };
    expect(context.replyEmail.id).toBe('others-email-1');
    expect(context.lastOutbound?.id).toBe('out-1');
    expect(context.campaignOutboundMailboxes).toContain('elena@velar-vr.ru');
    // Others-поток шумный: DM клиенту — только при вердикте «лид».
    expect(opts).toMatchObject({ clientDmOnlyOnLead: true });
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
    // elena@ (первый ящик velar-vr.ru) не привязан, irina@ несёт кампанию.
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
    // Ключевое: маппинги даже не дёргаются и null не кэшируется — следующий
    // тик перепроверит с живой БД.
    expect(getAccountCampaignMappings).not.toHaveBeenCalled();
  });

  it('пропускает кампанию, не входящую в квалифицируемый набор', async () => {
    getCampaignsByAccountCached.mockResolvedValue(new Map([['main', new Set(['other-camp'])]]));
    const { pollOthersOnce } = await importWatchdog();
    const processed = await pollOthersOnce();

    expect(processed).toBe(0);
    expect(qualifyOneReply).not.toHaveBeenCalled();
  });

  it('выбирает кампанию по факту исходящих лиду, а не первую попавшуюся', async () => {
    getAccountCampaignMappings.mockResolvedValue([
      { campaign_id: 'camp-new', status: 1, timestamp_created: '2026-07-10T00:00:00.000Z' },
      { campaign_id: 'camp-velar', status: 1, timestamp_created: '2026-06-01T00:00:00.000Z' },
    ]);
    getCampaignsByAccountCached.mockResolvedValue(
      new Map([['main', new Set(['camp-new', 'camp-velar'])]]),
    );
    // Исходящие этому лиду есть только в СТАРОЙ кампании.
    listEmails.mockImplementation(
      async (params: { mode?: string; email_type?: string; campaign_id?: string }) => {
        if (params.mode === 'emode_others') {
          return { items: [makeOthersEmail()], next_starting_after: null };
        }
        if (params.email_type === 'sent' && params.campaign_id === 'camp-velar') {
          return {
            items: [{ id: 'out-1', ue_type: 1, eaccount: 'elena@velar-vr.ru' }],
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
            // Порядок НЕ по новизне: реализация «взять первое» провалила бы тест.
            makeOthersEmail({ id: 'older', timestamp_email: '2026-07-16T08:00:00.000Z' }),
            makeOthersEmail({ id: 'newer', timestamp_email: '2026-07-16T12:00:00.000Z' }),
          ],
          next_starting_after: null,
        };
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
    // Порядок в поллере: сначала БД-дедуп, потом схлопывание «новейшее на
    // отправителя». Обратный порядок терял бы раннее письмо навсегда
    // (критическая находка ревью 16.07).
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
        return { items: [{ id: 'out-1', ue_type: 1, eaccount: 'elena@velar-vr.ru' }], next_starting_after: null };
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
    // Новее по списку — кандидат Coldy/Trigga-домена (без кампаний), старше —
    // реальный атрибуцируемый ответ. Кап по префиксу списка потерял бы его.
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
      return { items: [], next_starting_after: null };
    });
    // law-russia.tech не атрибуцируется (маппинги пусты) → скип БЕЗ попытки;
    // единственный слот достаётся реальному ответу.
    const { pollOthersOnce } = await importWatchdog();
    const processed = await pollOthersOnce();

    expect(processed).toBe(1);
    expect((qualifyOneReply.mock.calls[0][1] as Email).id).toBe('real-reply');
  });
});
