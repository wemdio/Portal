/**
 * Демо-данные для read-only витрины клиентского портала.
 *
 * Когда под порталом залогинен демо-аккаунт (profiles.is_demo = true),
 * клиентские GET-роуты отдают ЭТИ фикстуры вместо реальных данных, а
 * Instantly API / БД не дёргаются вообще. Всё ниже — вымышленная, но
 * правдоподобная начинка: демо-клиент — компания «Орбита» (облачная
 * WMS-платформа для управления складом и логистикой).
 *
 * Ничего здесь не существует в Instantly или в БД — это статические
 * объекты. Менять/дополнять контент можно свободно: на боевые данные
 * это не влияет.
 */

import {
  EMPTY_BRIEF_FIELDS,
  normalizeBriefFields,
  compileBriefText,
  type ClientBriefFields,
} from '@/lib/clientBrief';

// ─── Кампании ────────────────────────────────────────────────────────────────
// status: 1 = активна, 2 = пауза, 3 = завершена (Instantly-коды).

export const DEMO_CAMPAIGN_IDS = [
  'demo-cmp-retail',
  'demo-cmp-3pl',
  'demo-cmp-manufacturing',
  'demo-cmp-marketplace',
] as const;

interface DemoCampaign {
  id: string;
  name: string;
  status: number;
  emails_sent_count: number;
  open_count: number;
  reply_count: number;
  new_leads_contacted_count: number;
  bounced_count: number;
  unsubscribed_count: number;
  leads_count: number;
  analytics_synced_at: string;
}

const SYNCED_AT = '2026-05-17T08:40:00.000Z';

export const DEMO_CAMPAIGNS: DemoCampaign[] = [
  {
    id: 'demo-cmp-retail',
    name: 'Орбита — розничные сети',
    status: 1,
    emails_sent_count: 1840,
    open_count: 612,
    reply_count: 74,
    new_leads_contacted_count: 920,
    bounced_count: 21,
    unsubscribed_count: 8,
    leads_count: 23,
    analytics_synced_at: SYNCED_AT,
  },
  {
    id: 'demo-cmp-3pl',
    name: 'Орбита — 3PL и фулфилмент',
    status: 1,
    emails_sent_count: 1120,
    open_count: 388,
    reply_count: 41,
    new_leads_contacted_count: 560,
    bounced_count: 12,
    unsubscribed_count: 5,
    leads_count: 12,
    analytics_synced_at: SYNCED_AT,
  },
  {
    id: 'demo-cmp-manufacturing',
    name: 'Орбита — производственные компании',
    status: 2,
    emails_sent_count: 760,
    open_count: 240,
    reply_count: 19,
    new_leads_contacted_count: 380,
    bounced_count: 9,
    unsubscribed_count: 3,
    leads_count: 6,
    analytics_synced_at: SYNCED_AT,
  },
  {
    id: 'demo-cmp-marketplace',
    name: 'Орбита — продавцы на маркетплейсах',
    status: 3,
    emails_sent_count: 2300,
    open_count: 901,
    reply_count: 112,
    new_leads_contacted_count: 1150,
    bounced_count: 28,
    unsubscribed_count: 14,
    leads_count: 38,
    analytics_synced_at: SYNCED_AT,
  },
];

export const DEMO_CAMPAIGNS_RESPONSE = {
  total: DEMO_CAMPAIGNS.length,
  campaigns: DEMO_CAMPAIGNS,
  lastSyncedAt: SYNCED_AT,
};

// ─── Деталь кампании ─────────────────────────────────────────────────────────

function demoCampaignDetail(id: string) {
  const c = DEMO_CAMPAIGNS.find((x) => x.id === id) ?? DEMO_CAMPAIGNS[0];
  return {
    campaign: {
      id: c.id,
      name: c.name,
      status: c.status,
      timestamp_created: '2026-03-12T10:00:00.000Z',
      timestamp_updated: SYNCED_AT,
    },
    analytics: {
      campaign_id: c.id,
      campaign_name: c.name,
      emails_sent_count: c.emails_sent_count,
      open_count: c.open_count,
      reply_count: c.reply_count,
      new_leads_contacted_count: c.new_leads_contacted_count,
      bounced_count: c.bounced_count,
      unsubscribed_count: c.unsubscribed_count,
      leads_count: c.leads_count,
    },
    steps: [
      {
        step: 1,
        variant: 1,
        sent: Math.round(c.emails_sent_count * 0.55),
        opened: Math.round(c.open_count * 0.6),
        replies: Math.round(c.reply_count * 0.62),
      },
      {
        step: 2,
        variant: 1,
        sent: Math.round(c.emails_sent_count * 0.45),
        opened: Math.round(c.open_count * 0.4),
        replies: Math.round(c.reply_count * 0.38),
      },
    ],
  };
}

export function getDemoCampaignDetail(id: string) {
  return demoCampaignDetail(id);
}

// ─── Ответы получателей по кампании ──────────────────────────────────────────

interface DemoReply {
  id: string;
  campaign_id: string;
  from_name: string;
  from_email: string;
  subject: string;
  preview: string;
  body: string;
  timestamp: string;
  is_lead: boolean;
  /** Whether this reply still demands attention (amber dot in the list). */
  is_unread?: boolean;
}

/**
 * Demo inbox — mixed на 9 ответов:
 *   3 lead (зелёные)  — горячие, готовы говорить
 *   2 unread (амбер)  — новые, ещё не открытые
 *   4 read non-lead   — холодные вежливости / отказы / out-of-office
 *
 * Состав подобран так, чтобы фильтры на /client/replies выглядели
 * содержательно для демо-аккаунта (без реальных кампаний у клиентов
 * это единственный способ проверить UX inbox-фильтров).
 */
const DEMO_REPLIES: DemoReply[] = [
  // ── 3 lead (status=leads → 3) ─────────────────────────────────────────────
  {
    id: 'demo-reply-1',
    campaign_id: 'demo-cmp-retail',
    from_name: 'Игорь Соколов',
    from_email: 'i.sokolov@retail-group.example',
    subject: 'Re: Сократили пересорт на складе на 30%',
    preview: 'Добрый день! Интересно, у нас как раз болит инвентаризация. Когда удобно созвон?',
    body: 'Добрый день!\n\nИнтересно — у нас как раз болит инвентаризация по 6 складам. Когда удобно короткий созвон на этой неделе?\n\nИгорь Соколов, директор по логистике',
    timestamp: '2026-05-15T11:22:00.000Z',
    is_lead: true,
  },
  {
    id: 'demo-reply-2',
    campaign_id: 'demo-cmp-retail',
    from_name: 'Марина Лебедева',
    from_email: 'm.lebedeva@torgdom.example',
    subject: 'Re: Сократили пересорт на складе на 30%',
    preview: 'Пришлите, пожалуйста, презентацию и примерную стоимость на 4 склада.',
    body: 'Здравствуйте!\n\nПришлите, пожалуйста, презентацию и примерную стоимость внедрения на 4 склада. Передам руководству.\n\nС уважением, Марина',
    timestamp: '2026-05-14T09:05:00.000Z',
    is_lead: true,
  },
  {
    id: 'demo-reply-3',
    campaign_id: 'demo-cmp-3pl',
    from_name: 'Алексей Громов',
    from_email: 'a.gromov@fulfillment-pro.example',
    subject: 'Re: WMS под фулфилмент за 3 недели',
    preview: 'Мы сейчас на самописной системе, готовы обсудить миграцию. Скиньте кейсы по 3PL.',
    body: 'Привет!\n\nМы сейчас на самописной системе и упёрлись в потолок. Готовы обсудить миграцию — скиньте кейсы по 3PL-операторам нашего размера.\n\nАлексей',
    timestamp: '2026-05-13T16:40:00.000Z',
    is_lead: true,
  },

  // ── 2 unread non-lead (status=unread → 2) ─────────────────────────────────
  {
    id: 'demo-reply-4',
    campaign_id: 'demo-cmp-3pl',
    from_name: 'Дмитрий Орлов',
    from_email: 'd.orlov@logistics-hub.example',
    subject: 'Re: WMS для распределительного центра',
    preview: 'Спасибо за письмо, изучаем рынок. Можете прислать сравнение с Mantis WMS?',
    body: 'Спасибо за письмо! Сейчас активно изучаем рынок WMS для нашего распределительного центра в Подмосковье (около 8 тыс кв.м). Можете прислать сравнение вашей платформы с Mantis WMS — она у нас в шорт-листе?\n\nДмитрий Орлов, IT-директор',
    timestamp: '2026-05-21T14:30:00.000Z',
    is_lead: false,
    is_unread: true,
  },
  {
    id: 'demo-reply-5',
    campaign_id: 'demo-cmp-retail',
    from_name: 'Анна Соловьёва',
    from_email: 'a.solovieva@cross-dock.example',
    subject: 'Re: Кросс-докинг под маркетплейсы',
    preview: 'Готовы обсудить, но сначала демо. Когда есть слот?',
    body: 'Здравствуйте! Готовы обсудить кросс-докинг для нашего ОМП. Когда у вас есть слот на демо? Желательно на следующей неделе во второй половине дня — утро у нас занято операционкой.\n\nС уважением, Анна Соловьёва',
    timestamp: '2026-05-20T10:15:00.000Z',
    is_lead: false,
    is_unread: true,
  },

  // ── 4 read non-lead (нейтральные / отказы / OOO) ──────────────────────────
  {
    id: 'demo-reply-6',
    campaign_id: 'demo-cmp-retail',
    from_name: 'Сергей Кузьмин',
    from_email: 's.kuzmin@warehouse-king.example',
    subject: 'Re: WMS для склада 12 тыс кв.м',
    preview: 'Спасибо, сейчас не актуально — внедряем 1С:WMS до конца года.',
    body: 'Спасибо за предложение! Сейчас не актуально — у нас уже идёт внедрение 1С:WMS, заканчиваем до конца года. Возможно, через 12 месяцев вернёмся к разговору, если будут вопросы по второму складу.\n\nСергей Кузьмин',
    timestamp: '2026-05-18T16:20:00.000Z',
    is_lead: false,
  },
  {
    id: 'demo-reply-7',
    campaign_id: 'demo-cmp-retail',
    from_name: 'Елена Морозова',
    from_email: 'e.morozova@retail-ops.example',
    subject: 'Re: Сократили пересорт на складе на 30%',
    preview: 'Передам коллегам, у нас этим направлением занимается другой отдел.',
    body: 'Здравствуйте! Передам ваше письмо коллегам — у нас этим направлением занимается другой отдел (склад и логистика отдельно от закупок). Если будут вопросы — свяжемся.',
    timestamp: '2026-05-17T11:00:00.000Z',
    is_lead: false,
  },
  {
    id: 'demo-reply-8',
    campaign_id: 'demo-cmp-3pl',
    from_name: 'Анна Тарасова',
    from_email: 'a.tarasova@auto-parts.example',
    subject: 'Re: WMS под фулфилмент за 3 недели',
    preview: 'Сейчас в отпуске до 28 мая, отвечу по возвращении.',
    body: 'Автоматический ответ\n\nСпасибо за письмо! Сейчас в отпуске до 28 мая, отвечу по возвращении. По срочным вопросам — anna.kim@auto-parts.example',
    timestamp: '2026-05-16T08:45:00.000Z',
    is_lead: false,
  },
  {
    id: 'demo-reply-9',
    campaign_id: 'demo-cmp-3pl',
    from_name: 'Виктор Шевченко',
    from_email: 'v.shevchenko@logistics-llc.example',
    subject: 'Re: WMS под фулфилмент за 3 недели',
    preview: 'Просьба удалить наш email из рассылки.',
    body: 'Здравствуйте. Просьба удалить наш email из рассылки. Спасибо.',
    timestamp: '2026-05-15T15:30:00.000Z',
    is_lead: false,
  },
];

export function getDemoReplies(campaignId: string) {
  return {
    items: DEMO_REPLIES.filter((r) => r.campaign_id === campaignId),
    next_starting_after: null,
  };
}

/**
 * Synthetic outreach copy per кампания — used as the outbound side of every
 * demo thread. Real backend has Instantly-generated bodies; here we just
 * need enough realism so ExpandedThread has something to render.
 */
function getDemoOutboundBody(campaignId: string): string {
  switch (campaignId) {
    case 'demo-cmp-retail':
      return 'Команда OutreachOS помогает розничным сетям сократить пересорт на складе. Кейс: 30% за 3 месяца у клиента с 12 складами в Подмосковье — без миграции учётной системы и с возвратом инвестиций за полугодие.';
    case 'demo-cmp-3pl':
      return 'OutreachOS внедряет WMS-системы под фулфилмент-операторов за 3 недели — без даунтайма складских операций, с интеграцией под Wildberries / Ozon / Я.Маркет и нативной поддержкой кросс-докинга.';
    default:
      return 'Мы помогаем компаниям вашего масштаба автоматизировать складские операции. Есть кейсы у клиентов с похожим профилем — поделимся, если интересно.';
  }
}

/**
 * Demo thread fixture: synthesizes a 2-message conversation для каждого
 * DEMO_REPLIES item — наш исходный outreach (направленный за 3 дня до
 * ответа) + сам ответ лида. Без этого ExpandedThread висит на
 * "Загружаем тред..." потому что общий /campaigns/X/replies handler
 * возвращает плоский список replies вместо thread shape.
 */
export function getDemoThread(campaignId: string, emailId: string) {
  const reply = DEMO_REPLIES.find(
    (r) => r.id === emailId && r.campaign_id === campaignId,
  );
  if (!reply) {
    // Unknown id — graceful empty thread; UI shows "Ответить / Переслать"
    // buttons but no message bubbles.
    return { thread_id: null, messages: [] };
  }

  const replyMs = Date.parse(reply.timestamp);
  const outboundTimestamp = Number.isFinite(replyMs)
    ? new Date(replyMs - 3 * 24 * 3600 * 1000).toISOString()
    : reply.timestamp;
  const outboundSubject = reply.subject.replace(/^Re:\s*/i, '');

  return {
    thread_id: `thread-${reply.id}`,
    // Свежие сверху — как реальный /thread (сортировка по убыванию, commit
    // 81cfadec): последний ответ лида первым, наше исходное письмо ниже. Порядок
    // должен совпадать с продом, иначе демо/сейлз-показ противоречит продукту.
    messages: [
      {
        id: reply.id,
        direction: 'inbound' as const,
        timestamp: reply.timestamp,
        subject: reply.subject,
        from_email: reply.from_email,
        from_name: reply.from_name,
        body_text: reply.body,
      },
      {
        id: `${reply.id}-outbound`,
        direction: 'outbound' as const,
        timestamp: outboundTimestamp,
        subject: outboundSubject,
        from_email: 'team@demo-agency.example',
        from_name: 'OutreachOS · Команда',
        body_text: `Здравствуйте!\n\n${getDemoOutboundBody(campaignId)}\n\nЕсли тема актуальна — отвечайте на это письмо, обсудим детали.\n\nС уважением,\nКоманда OutreachOS`,
      },
    ],
  };
}

export function getDemoRepliesResponse(
  limit: number,
  offset: number,
  status: 'all' | 'unread' | 'leads' = 'all',
  search?: string,
) {
  // Sort by recency (matches real backend behaviour).
  let items = DEMO_REPLIES
    .slice()
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

  if (status === 'unread') {
    items = items.filter((r) => r.is_unread === true);
  } else if (status === 'leads') {
    items = items.filter((r) => r.is_lead === true);
  }

  // Local case-insensitive search across subject / from / preview — mirrors
  // what the real Instantly search returns from listEmails().
  if (search) {
    const q = search.toLowerCase();
    items = items.filter((r) =>
      r.subject.toLowerCase().includes(q)
      || r.from_name.toLowerCase().includes(q)
      || r.from_email.toLowerCase().includes(q)
      || r.preview.toLowerCase().includes(q),
    );
  }

  const mapped = items.map((reply) => ({
    id: `reply:${reply.campaign_id}:${reply.id}`,
    source: 'reply',
    qualification_id: null,
    campaign_id: reply.campaign_id,
    campaign_name: null,
    lead_email: reply.from_email,
    lead_name: reply.from_name,
    company_name: null,
    phone: null,
    website: null,
    linkedin_url: null,
    reply_subject: reply.subject,
    reply_body: reply.body,
    last_outbound_preview: null,
    reply_timestamp: reply.timestamp,
    status: reply.is_lead ? 'lead' : (reply.is_unread ? 'unread' : 'reply'),
    ai_reason: null,
    created_at: reply.timestamp,
    client_lead_comments: [],
    email_id: reply.id,
    lead_id: null,
    thread_id: null,
    is_unread: reply.is_unread === true,
    ai_interest_value: null,
    is_lead: reply.is_lead,
    lead_entry_id: reply.is_lead ? `demo-lead-${reply.id.split('-').pop()}` : null,
  }));

  return {
    items: mapped.slice(offset, offset + limit),
    total: mapped.length,
    limit,
    offset,
  };
}

// ─── Лиды (переданные клиенту) ───────────────────────────────────────────────

interface DemoLead {
  id: string;
  lead_email: string;
  lead_name: string;
  company_name: string;
  website: string | null;
  linkedin_url: string | null;
  campaign_name: string;
  reply_subject: string;
  reply_preview: string;
  ai_reason: string;
  created_at: string;
  client_lead_comments: { count: number }[];
}

export const DEMO_LEADS: DemoLead[] = [
  {
    id: 'demo-lead-1',
    lead_email: 'i.sokolov@retail-group.example',
    lead_name: 'Игорь Соколов',
    company_name: 'Розничная группа «ТоргДом»',
    website: 'torgdom.example',
    linkedin_url: null,
    campaign_name: 'Орбита — розничные сети',
    reply_subject: 'Re: Сократили пересорт на складе на 30%',
    reply_preview: 'Интересно, у нас как раз болит инвентаризация. Когда удобно созвон?',
    ai_reason: 'Явный интерес: спрашивает про созвон, описал боль (инвентаризация по 6 складам).',
    created_at: '2026-05-15T11:25:00.000Z',
    client_lead_comments: [{ count: 2 }],
  },
  {
    id: 'demo-lead-2',
    lead_email: 'a.gromov@fulfillment-pro.example',
    lead_name: 'Алексей Громов',
    company_name: 'Fulfillment Pro',
    website: 'fulfillment-pro.example',
    linkedin_url: 'linkedin.com/in/demo-gromov',
    campaign_name: 'Орбита — 3PL и фулфилмент',
    reply_subject: 'Re: WMS под фулфилмент за 3 недели',
    reply_preview: 'Готовы обсудить миграцию с самописной системы. Скиньте кейсы по 3PL.',
    ai_reason: 'Тёплый лид: готовность к миграции, запросил кейсы под свой сегмент.',
    created_at: '2026-05-13T16:42:00.000Z',
    client_lead_comments: [{ count: 1 }],
  },
  {
    id: 'demo-lead-3',
    lead_email: 'e.morozova@mp-seller.example',
    lead_name: 'Екатерина Морозова',
    company_name: 'МаркетСейл',
    website: 'mp-seller.example',
    linkedin_url: null,
    campaign_name: 'Орбита — продавцы на маркетплейсах',
    reply_subject: 'Re: Отгрузки на WB и Ozon из одного окна',
    reply_preview: 'Сколько стоит и как быстро можно подключить? У нас 3 склада.',
    ai_reason: 'Запрос цены и сроков — высокая готовность к сделке.',
    created_at: '2026-05-12T13:10:00.000Z',
    client_lead_comments: [{ count: 0 }],
  },
  {
    id: 'demo-lead-4',
    lead_email: 'd.kuznetsov@prom-zavod.example',
    lead_name: 'Дмитрий Кузнецов',
    company_name: 'ПромЗавод',
    website: 'prom-zavod.example',
    linkedin_url: null,
    campaign_name: 'Орбита — производственные компании',
    reply_subject: 'Re: Учёт сырья и готовой продукции без Excel',
    reply_preview: 'Отправил коллегам, вернёмся после согласования бюджета на Q3.',
    ai_reason: 'Средняя готовность: интерес есть, но решение отложено до Q3.',
    created_at: '2026-05-10T08:30:00.000Z',
    client_lead_comments: [{ count: 1 }],
  },
];

export function getDemoLeadsResponse(limit: number, offset: number) {
  return {
    items: DEMO_LEADS.slice(offset, offset + limit),
    total: DEMO_LEADS.length,
    limit,
    offset,
  };
}

export const DEMO_LEAD_COMMENTS: Record<string, { items: unknown[] }> = {
  'demo-lead-1': {
    items: [
      {
        id: 'demo-cmt-1',
        forwarded_lead_id: 'demo-lead-1',
        user_name: 'Менеджер Орбиты',
        comment: 'Назначили созвон на четверг 15:00.',
        created_at: '2026-05-15T12:00:00.000Z',
      },
      {
        id: 'demo-cmt-2',
        forwarded_lead_id: 'demo-lead-1',
        user_name: 'Менеджер Орбиты',
        comment: 'Отправили презентацию и расчёт по 6 складам.',
        created_at: '2026-05-16T10:20:00.000Z',
      },
    ],
  },
};

// ─── Бриф ────────────────────────────────────────────────────────────────────

const demoBriefFields = normalizeBriefFields({
  ...EMPTY_BRIEF_FIELDS,

  // 1. Компания
  company_website: 'orbita-wms.example',
  company_description:
    'Орбита — облачная WMS-платформа для управления складом и логистикой. ' +
    'Помогаем розничным сетям, 3PL-операторам и производству навести порядок ' +
    'в складских процессах без долгого и дорогого внедрения. На рынке с 2020 года.',
  company_contacts:
    'sales@orbita-wms.example\n+7 (495) 120-45-67\n' +
    'Москва, ул. Складская, 12, офис 304\nTelegram: @orbita_sales',
  deal_cycle:
    'В среднем 3–5 недель: демо → бесплатный пилот на одном складе (2 недели) → договор.',
  avg_check: 'от 90 000 ₽/мес, средний договор — 140 000 ₽/мес',

  // 2. Продукт / услуга
  product_description:
    'Облачная система управления складом: приёмка, размещение, отбор, ' +
    'инвентаризация, маркировка, интеграции с 1С, Wildberries и Ozon. ' +
    'Внедрение за 2–3 недели, без покупки серверов — всё в облаке. ' +
    'Мобильные ТСД, роли и права, онлайн-остатки для маркетплейсов.',
  price_tier: 'business',
  advantages:
    'Внедрение за 2–3 недели, а не за полгода\n' +
    'Без своих серверов — полностью облако\n' +
    'Готовые интеграции 1С / Wildberries / Ozon\n' +
    'Поддержка 24/7 и личный менеджер внедрения\n' +
    'Оплата помесячно, без крупных вложений на старте',
  usp: 'WMS, которую запускают за 3 недели, а не за полгода — с гарантией результата на пилоте.',
  competitors_problems:
    'Коробочные WMS внедряются 4–6 месяцев и требуют своих серверов. ' +
    'Самописные системы некому поддерживать. Excel не масштабируется на ' +
    'несколько складов и не даёт онлайн-остатков.',
  impressive_numbers:
    '6 лет на рынке\n140+ складов на платформе\n' +
    'Средний срок внедрения — 18 дней\n99,9% аптайм за 2025 год',
  special_offer:
    'Бесплатный пилот на одном складе 14 дней + перенос данных из 1С ' +
    'в подарок при заключении годового договора.',

  // 3. Целевая аудитория
  target_audience:
    'Розничные сети с 3+ складами, 3PL и фулфилмент-операторы, ' +
    'производственные компании, крупные продавцы на маркетплейсах. ' +
    'ЛПР — операционный/логистический директор, руководитель склада.',
  client_problems:
    'Пересортица и потери товара при ручном учёте\n' +
    'Долгая инвентаризация — склад встаёт на 1–2 дня\n' +
    'Нет онлайн-остатков для маркетплейсов\n' +
    'Новые сотрудники склада долго обучаются',
  common_questions:
    'Сколько длится внедрение? Нужны ли свои серверы? ' +
    'Есть ли интеграция с 1С и WB/Ozon? Что с поддержкой? ' +
    'Можно ли сначала пилот? Как переносятся данные?',

  // 4. Коммуникация
  persona_name: 'Андрей Векшин',
  persona_position: 'Руководитель направления внедрения, Орбита',
  lead_recipient_name: 'Сергей Орлов',
  lead_recipient_email: 'lead@orbita-wms.example',
  lead_recipient_position: 'Менеджер по продажам',
  lead_magnets:
    'Бесплатный аудит складских процессов\n' +
    'Чек-лист «12 точек потерь на складе»\n' +
    'Демо-доступ к платформе на 14 дней',
  guarantees:
    'Вернём деньги, если за 30 дней пилота не сократили время инвентаризации. ' +
    'Данные хранятся в РФ, не передаём третьим лицам.',

  // 5. Доказательства
  existing_clients:
    'Розничная сеть «ТоргДом», Fulfillment Pro, МаркетСейл, ПромЗавод, ' +
    'сеть «СтройБаза» и ещё 130+ компаний.',
  impressive_results:
    'ТоргДом: инвентаризация 6 складов сокращена с 2 дней до 4 часов\n' +
    'Fulfillment Pro: −32% к ошибкам сборки за квартал\n' +
    'ПромЗавод: онлайн-остатки сырья вместо Excel, −15% к простоям',

  // 6. Social proof
  social_proof: {
    ...EMPTY_BRIEF_FIELDS.social_proof,
    ratings: { has: true, comment: 'Рейтинг 4.8 на отраслевых площадках' },
    recommendations: { has: true, comment: 'Видео-отзывы клиентов на сайте' },
    cases: { has: true, comment: 'Кейсы по рознице, 3PL и производству' },
    press: { has: true, comment: 'Публикации в Retail.ru и vc.ru' },
    presentations: { has: true, comment: 'Презентация платформы и расчёт ROI' },
  },

  // 7. Дополнительный контекст
  additional_notes:
    'Сезонный пик спроса — август–ноябрь (подготовка розницы к высокому сезону). ' +
    'Лучший вход в диалог — через боль инвентаризации и потерь товара.',
} satisfies Partial<ClientBriefFields>);

export const DEMO_BRIEF_RESPONSE = {
  brief: {
    id: 'demo-brief',
    fields: demoBriefFields,
    pdf_file_name: null,
    pdf_uploaded_at: null,
    updated_at: '2026-04-28T12:00:00.000Z',
  },
  compiled_brief_text: compileBriefText(demoBriefFields),
};

// ─── Онбординг ───────────────────────────────────────────────────────────────
// Демо-аккаунт показывает полностью пройденный онбординг.

export const DEMO_ONBOARDING_RESPONSE = {
  items: [
    { id: 'brief', label: 'Заполнить бриф', done: true, href: '/client/brief' },
    { id: 'preset', label: 'Менеджер настроил пресет', done: true, href: null },
    { id: 'first_base', label: 'Собрать первую базу', done: true, href: '/client/build' },
    { id: 'first_clean', label: 'Очистить первую базу', done: true, href: '/client/base-constructor' },
    {
      id: 'first_sequence',
      label: 'Написать первую цепочку писем',
      done: true,
      href: '/client/parsers?tab=email-sequence',
    },
    { id: 'first_launch', label: 'Запустить первую кампанию', done: true, href: '/client/launch' },
  ],
  complete: true,
  next_id: null,
};

// ─── Базы кампаний ───────────────────────────────────────────────────────────

export const DEMO_BASES_RESPONSE = {
  campaigns: DEMO_CAMPAIGNS.map((c) => ({
    id: c.id,
    name: c.name,
    leads_count: c.new_leads_contacted_count,
    leads_synced_at: SYNCED_AT,
    leads: DEMO_LEADS.slice(0, 3).map((l) => ({
      email: l.lead_email,
      first_name: l.lead_name.split(' ')[0] ?? '',
      last_name: l.lead_name.split(' ')[1] ?? '',
      company_name: l.company_name,
      website: l.website,
      linkedin_url: l.linkedin_url,
    })),
  })),
};

// ─── Проекты ─────────────────────────────────────────────────────────────────

const DEMO_PROJECTS = [
  {
    id: 'demo-prj-1',
    name: 'Орбита — лидген Q2 2026',
    status: 'active',
    specialist: 'Анна Ковалёва',
    manager: 'Сергей Орлов',
    contacts_done: '2 480',
    contacts_obligation: '3 000',
    deadline: '2026-06-30',
    launch_date: '2026-04-01',
    tasks_total: 8,
    tasks_active: 3,
    tasks_done: 5,
    leads_count: 4,
  },
  {
    id: 'demo-prj-2',
    name: 'Орбита — прогрев маркетплейс-сегмента',
    status: 'active',
    specialist: 'Анна Ковалёва',
    manager: 'Сергей Орлов',
    contacts_done: '1 150',
    contacts_obligation: '1 500',
    deadline: '2026-07-15',
    launch_date: '2026-04-20',
    tasks_total: 5,
    tasks_active: 2,
    tasks_done: 3,
    leads_count: 1,
  },
];

export const DEMO_PROJECTS_RESPONSE = {
  items: DEMO_PROJECTS,
  total: DEMO_PROJECTS.length,
};

export function getDemoProjectDetail(id: string) {
  const p = DEMO_PROJECTS.find((x) => x.id === id) ?? DEMO_PROJECTS[0];
  return {
    project: {
      id: p.id,
      name: p.name,
      description:
        'Лидген-проект агентства для компании «Орбита»: холодный email-аутрич ' +
        'по сегментам розницы, 3PL и производства.',
      status: p.status,
      specialist: p.specialist,
      manager: p.manager,
      contacts_done: p.contacts_done,
      contacts_obligation: p.contacts_obligation,
      launch_date: p.launch_date,
      deadline: p.deadline,
      leads_count: p.leads_count,
    },
    tasks: {
      active: [
        { id: 'demo-task-1', title: 'Прогрев новых доменов', status: 'in_progress', deadline: '2026-05-25' },
        { id: 'demo-task-2', title: 'A/B-тест темы письма по рознице', status: 'pending', deadline: '2026-05-28' },
        { id: 'demo-task-3', title: 'Сбор базы по 3PL Москвы и МО', status: 'in_progress', deadline: '2026-06-02' },
      ],
      done: [
        { id: 'demo-task-4', title: 'Настройка пресета и расписания', status: 'done', deadline: '2026-04-05' },
        { id: 'demo-task-5', title: 'Первая цепочка писем', status: 'done', deadline: '2026-04-10' },
      ],
    },
  };
}

// ─── Пресет ──────────────────────────────────────────────────────────────────

export const DEMO_PRESET_RESPONSE = {
  preset: {
    id: 'demo-preset',
    instantly_account_id: 'main',
    email_account_ids: ['demo-sender-1', 'demo-sender-2'],
    daily_limit: 120,
    daily_max_leads: 60,
    email_gap_minutes: 12,
    open_tracking: true,
    link_tracking: true,
    stop_on_reply: true,
    text_only: true,
    schedule_from: '09:00',
    schedule_to: '18:00',
    schedule_days: [1, 2, 3, 4, 5],
    schedule_timezone: 'Europe/Moscow',
    updated_at: '2026-04-05T10:00:00.000Z',
  },
};

// ─── Тариф ───────────────────────────────────────────────────────────────────

function bucket(limit: number, used: number) {
  return { limit, used, remaining: Math.max(0, limit - used) };
}

export const DEMO_TARIFF_RESPONSE = {
  status: 'active',
  tariff_type: 'business',
  limits: {
    max_contacts: 10000,
    max_rows: 50000,
    max_chains_per_month: 20,
    max_domains: 6,
    max_emails: 12,
  },
  paid_at: '2026-05-01T00:00:00.000Z',
  paid_until: '2026-08-01T00:00:00.000Z',
  setup_until: null,
  billing_mode: null,
  payment_locked: false,
  auto_renew: false,
  payment_method_saved: false,
  last_renewal_error: null,
  last_payment_error: null,
  period_start: '2026-05-01',
  usage: {
    max_contacts: bucket(10000, 3630),
    max_rows: bucket(50000, 9120),
    max_chains_per_month: bucket(20, 4),
    max_domains: bucket(6, 4),
    max_emails: bucket(12, 8),
  },
};

// ─── История запусков ────────────────────────────────────────────────────────

export const DEMO_LAUNCHES_RESPONSE = {
  launches: DEMO_CAMPAIGNS.map((c, i) => ({
    id: `demo-launch-${i + 1}`,
    campaign_name: c.name,
    instantly_campaign_id: c.id,
    status: c.status === 3 ? 'completed' : 'active',
    uploaded_rows: c.new_leads_contacted_count,
    accepted_rows: c.new_leads_contacted_count,
    skipped_rows: 0,
    error_message: null,
    created_at: '2026-04-01T10:00:00.000Z',
  })),
};

// ─── Поддержка ───────────────────────────────────────────────────────────────

export const DEMO_SUPPORT_RESPONSE = {
  thread: { id: 'demo-thread', client_user_id: 'demo', created_at: '2026-04-01T10:00:00.000Z' },
  messages: [
    {
      id: 'demo-msg-1',
      thread_id: 'demo-thread',
      sender_role: 'client',
      sender_name: 'Орбита',
      body: 'Добрый день! Когда планируется запуск кампании по производству?',
      created_at: '2026-05-12T09:30:00.000Z',
    },
    {
      id: 'demo-msg-2',
      thread_id: 'demo-thread',
      sender_role: 'manager',
      sender_name: 'Сергей Орлов',
      body: 'Здравствуйте! Запускаем в четверг — домены уже на финальном прогреве.',
      created_at: '2026-05-12T10:05:00.000Z',
    },
  ],
};

// ─── Отчёт по кампаниям ──────────────────────────────────────────────────────

function buildDemoReportResponse(campaigns: DemoCampaign[]) {
  const totals = campaigns.reduce(
    (acc, c) => {
      acc.contacts += c.new_leads_contacted_count;
      acc.sent += c.emails_sent_count;
      acc.opened += c.open_count;
      acc.replies += c.reply_count;
      acc.leads += c.leads_count;
      acc.bounced += c.bounced_count;
      return acc;
    },
    { contacts: 0, sent: 0, opened: 0, replies: 0, leads: 0, bounced: 0 },
  );
  const openPct = totals.sent > 0 ? ((totals.opened / totals.sent) * 100).toFixed(1) : '0.0';
  const replyPct = totals.contacts > 0 ? ((totals.replies / totals.contacts) * 100).toFixed(1) : '0.0';
  const rows: (string | number)[][] = [
    ['Дата', 'Кампания', 'Контактов', 'Отправлено писем', 'Открытий', '% открытий', 'Ответов', '% ответов', 'Браков'],
    ...campaigns.map((c) => [
      '17.05.2026',
      c.name,
      c.new_leads_contacted_count,
      c.emails_sent_count,
      c.open_count,
      `${((c.open_count / c.emails_sent_count) * 100).toFixed(1)}%`,
      c.reply_count,
      `${((c.reply_count / c.new_leads_contacted_count) * 100).toFixed(1)}%`,
      c.bounced_count,
    ]),
  ];
  return {
    tableText: 'Демо-отчёт по email-кампаниям компании «Орбита».',
    csvText: rows.map((r) => r.join(';')).join('\n'),
    rows,
    summary: {
      totalCampaigns: campaigns.length,
      totalContacts: totals.contacts,
      totalEmailsSent: totals.sent,
      totalOpened: totals.opened,
      totalReplies: totals.replies,
      totalLeads: totals.leads,
      totalBounced: totals.bounced,
      conversion: { openPctAllEmails: openPct, replyPctByLeads: replyPct },
    },
    campaignData: {},
  };
}

export function getDemoReportResponse(campaignIds?: string[]) {
  const selected = Array.isArray(campaignIds)
    ? campaignIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    : [];
  const requested = new Set(selected);
  const campaigns = requested.size > 0
    ? DEMO_CAMPAIGNS.filter((c) => requested.has(c.id))
    : DEMO_CAMPAIGNS;

  return buildDemoReportResponse(campaigns);
}

export const DEMO_REPORT_RESPONSE = getDemoReportResponse();

// ─── B2B-поиск компаний ──────────────────────────────────────────────────────

export const DEMO_COMPANIES_SEARCH_RESPONSE = {
  count: 1284,
  companies: [
    { name: 'ООО «Складские решения»', inn: '7700000001', address: 'Москва', activity: 'Складское хозяйство' },
    { name: 'ООО «РитейлЛогистик»', inn: '7800000002', address: 'Санкт-Петербург', activity: 'Розничная торговля' },
    { name: 'ООО «ФулфилментЦентр»', inn: '5000000003', address: 'Московская обл.', activity: 'Логистика' },
  ],
};

export const DEMO_ACTIVITY_TYPES_RESPONSE = {
  activityTypes: [
    { code: '52.10', name: 'Складское хозяйство' },
    { code: '47.11', name: 'Розничная торговля' },
    { code: '52.29', name: 'Транспортная обработка грузов' },
    { code: '10.00', name: 'Производство пищевых продуктов' },
  ],
};
