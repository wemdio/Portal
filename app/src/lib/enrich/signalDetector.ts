export type SignalCategory =
  | 'ad_pixel'
  | 'analytics'
  | 'call_tracking'
  | 'lead_capture'
  | 'crm'
  | 'chat'
  | 'payment'
  | 'marketplace'
  | 'erp'
  | 'email_marketing'
  | 'hiring'
  | 'cms'
  | 'multilingual'
  | 'tech_framework';

export type SignalLevel = 1 | 2 | 3 | 4;

export interface SignalPattern {
  id: string;
  name: string;
  category: SignalCategory;
  level: SignalLevel;
  regex: RegExp;
}

export interface DetectedSignal {
  id: string;
  name: string;
  category: SignalCategory;
  level: SignalLevel;
}

const SIGNAL_PATTERNS: SignalPattern[] = [
  // --- Level 1: Client acquisition ---
  { id: 'yandex_metrika', name: 'Яндекс.Метрика', category: 'analytics', level: 1, regex: /mc\.yandex\.ru\/metrika|mc\.yandex\.ru\/watch/i },
  { id: 'google_analytics', name: 'Google Analytics', category: 'analytics', level: 1, regex: /google-analytics\.com\/analytics|googletagmanager\.com\/gtag\/js\?id=(?:G-|UA-)/i },
  { id: 'yandex_direct', name: 'Яндекс.Директ', category: 'ad_pixel', level: 1, regex: /yandex\.ru\/ads\/|an\.yandex\.ru\/system\/context|yastatic\.net\/.*direct/i },
  { id: 'vk_pixel', name: 'VK Pixel', category: 'ad_pixel', level: 1, regex: /vk\.com\/rtrg|VK\.Retargeting|top-fwz1\.mail\.ru.*vk/i },
  { id: 'google_ads', name: 'Google Ads', category: 'ad_pixel', level: 1, regex: /googletagmanager\.com\/gtag\/.*AW-|googlesyndication\.com|googleadservices\.com/i },
  { id: 'facebook_pixel', name: 'Facebook Pixel', category: 'ad_pixel', level: 1, regex: /fbq\s*\(\s*['"]init|connect\.facebook\.net\/.*fbevents/i },
  { id: 'mytarget', name: 'myTarget', category: 'ad_pixel', level: 1, regex: /top-fwz1\.mail\.ru\/js\/code/i },

  { id: 'calltouch', name: 'Calltouch', category: 'call_tracking', level: 1, regex: /calltouch\.ru/i },
  { id: 'comagic', name: 'CoMagic', category: 'call_tracking', level: 1, regex: /comagic\.ru/i },
  { id: 'mango_office', name: 'Mango Office', category: 'call_tracking', level: 1, regex: /mango-office\.ru/i },
  { id: 'ringostat', name: 'Ringostat', category: 'call_tracking', level: 1, regex: /ringostat\.com|ringostat\.net/i },
  { id: 'callibri', name: 'Callibri', category: 'call_tracking', level: 1, regex: /callibri\.ru/i },

  // --- Level 2: Sales stack ---
  { id: 'amocrm', name: 'amoCRM', category: 'crm', level: 2, regex: /amocrm\.ru|amocrm\.com/i },
  { id: 'bitrix24', name: 'Битрикс24', category: 'crm', level: 2, regex: /bitrix24\.ru|bitrix24\.com|cdn\.bitrix24\./i },
  { id: 'hubspot', name: 'HubSpot', category: 'crm', level: 2, regex: /hs-scripts\.com|hubspot\.com\/|hs-analytics/i },
  { id: 'retailcrm', name: 'RetailCRM', category: 'crm', level: 2, regex: /retailcrm\./i },
  { id: 'megaplan', name: 'Мегаплан', category: 'crm', level: 2, regex: /megaplan\.ru/i },

  { id: 'jivosite', name: 'JivoSite', category: 'chat', level: 2, regex: /jivosite\.com|jivo\.chat/i },
  { id: 'carrotquest', name: 'Carrot Quest', category: 'chat', level: 2, regex: /carrotquest\.(app|io|ru)/i },
  { id: 'chatra', name: 'Chatra', category: 'chat', level: 2, regex: /ChatraID|chatra\.com|chatra\.io/i },
  { id: 'talkme', name: 'Talk-Me', category: 'chat', level: 2, regex: /talk-me\.ru/i },
  { id: 'verbox', name: 'Verbox', category: 'chat', level: 2, regex: /verbox\.ru/i },
  { id: 'livetex', name: 'LiveTex', category: 'chat', level: 2, regex: /livetex\.ru/i },
  { id: 'whatsapp_widget', name: 'WhatsApp', category: 'chat', level: 2, regex: /wa\.me\/|api\.whatsapp\.com|whatsapp.*widget/i },

  // --- Level 3: Payments & business model ---
  { id: 'yukassa', name: 'ЮKassa', category: 'payment', level: 3, regex: /yookassa\.ru|yoomoney\.ru|kassa\.yandex/i },
  { id: 'cloudpayments', name: 'CloudPayments', category: 'payment', level: 3, regex: /cloudpayments\.ru/i },
  { id: 'tinkoff_pay', name: 'Tinkoff Pay', category: 'payment', level: 3, regex: /securepay\.tinkoff\.ru|tinkoff\.ru\/kassa/i },
  { id: 'sberpay', name: 'SberPay', category: 'payment', level: 3, regex: /securepayments\.sberbank\.ru|sber-pay|sberpay/i },
  { id: 'robokassa', name: 'Робокасса', category: 'payment', level: 3, regex: /robokassa\.ru/i },
  { id: 'stripe', name: 'Stripe', category: 'payment', level: 3, regex: /js\.stripe\.com/i },

  { id: 'wildberries', name: 'Wildberries', category: 'marketplace', level: 3, regex: /wildberries\.ru/i },
  { id: 'ozon', name: 'Ozon', category: 'marketplace', level: 3, regex: /ozon\.ru/i },
  { id: 'yandex_market', name: 'Яндекс.Маркет', category: 'marketplace', level: 3, regex: /market\.yandex\.ru/i },

  // --- Level 4: Operations ---
  { id: '1c_erp', name: '1С', category: 'erp', level: 4, regex: /интеграц\S*\s+с\s+1[CСс]|1[CСс]-?(предприят|битрикс|enterprise)|1[CСс]\s*:\s*(предприят|бухгалтер|управлен)/i },
  { id: 'unisender', name: 'Unisender', category: 'email_marketing', level: 4, regex: /unisender\.com/i },
  { id: 'sendpulse', name: 'SendPulse', category: 'email_marketing', level: 4, regex: /sendpulse\.com/i },
  { id: 'dashamail', name: 'DashaMail', category: 'email_marketing', level: 4, regex: /dashamail\.ru/i },
  { id: 'mindbox', name: 'Mindbox', category: 'email_marketing', level: 4, regex: /mindbox\.ru|mindbox\.cloud/i },
  { id: 'sendsay', name: 'Sendsay', category: 'email_marketing', level: 4, regex: /sendsay\.ru/i },

  { id: 'hiring_hh', name: 'HeadHunter', category: 'hiring', level: 4, regex: /hh\.ru\/employer|hh\.ru\/vacancy/i },
  { id: 'hiring_careers', name: 'Карьера', category: 'hiring', level: 4, regex: /href=["'][^"']*\/(careers|vacancies|вакансии|карьера)\b/i },

  { id: 'tilda', name: 'Tilda', category: 'cms', level: 4, regex: /tilda\.ws|Tilda Publishing|tildacdn\.com/i },
  { id: 'bitrix_cms', name: '1C-Битрикс CMS', category: 'cms', level: 4, regex: /content=["']1C-Bitrix|bitrix\/js\/|bitrix\/cache/i },
  { id: 'wordpress', name: 'WordPress', category: 'cms', level: 4, regex: /content=["']WordPress|wp-content\/|wp-includes\//i },
  { id: 'nextjs', name: 'Next.js', category: 'tech_framework', level: 4, regex: /\/_next\/static\/|content=["']Next\.js/i },
  { id: 'react', name: 'React', category: 'tech_framework', level: 4, regex: /__NEXT_DATA__|_react|react-root|data-reactroot/i },

  { id: 'multilingual', name: 'Мультиязычность', category: 'multilingual', level: 4, regex: /hreflang=["'][a-z]{2}/i },
];

export function detectSignals(html: string): DetectedSignal[] {
  if (!html) return [];

  const seen = new Set<string>();
  const results: DetectedSignal[] = [];

  for (const pattern of SIGNAL_PATTERNS) {
    if (seen.has(pattern.id)) continue;
    if (pattern.regex.test(html)) {
      seen.add(pattern.id);
      results.push({
        id: pattern.id,
        name: pattern.name,
        category: pattern.category,
        level: pattern.level,
      });
    }
  }

  return results;
}

type ProfileRule = {
  name: string;
  priority: number;
  match: (ctx: ProfileContext) => boolean;
};

type ProfileContext = {
  ids: Set<string>;
  categories: Set<SignalCategory>;
  hasAny: (...ids: string[]) => boolean;
  hasCategory: (cat: SignalCategory) => boolean;
  countCategory: (cat: SignalCategory) => number;
  total: number;
};

function buildProfileContext(signals: DetectedSignal[]): ProfileContext {
  const ids = new Set(signals.map((s) => s.id));
  const categories = new Set(signals.map((s) => s.category));
  const catCounts = new Map<SignalCategory, number>();
  for (const s of signals) {
    catCounts.set(s.category, (catCounts.get(s.category) ?? 0) + 1);
  }
  return {
    ids,
    categories,
    hasAny: (...checkIds) => checkIds.some((id) => ids.has(id)),
    hasCategory: (cat) => categories.has(cat),
    countCategory: (cat) => catCounts.get(cat) ?? 0,
    total: signals.length,
  };
}

const PROFILE_RULES: ProfileRule[] = [
  {
    name: 'Маркетплейс-зависимый',
    priority: 30,
    match: (ctx) => {
      const hasMarketplace = ctx.hasCategory('marketplace');
      const noPayments = !ctx.hasCategory('payment');
      return hasMarketplace && noPayments;
    },
  },
  {
    name: 'Вырос из инструментов',
    priority: 25,
    match: (ctx) => {
      const budgetTools = ['jivosite', 'amocrm', 'unisender', 'sendpulse', 'tilda', 'bitrix24', 'bitrix_cms'];
      const matchCount = budgetTools.filter((id) => ctx.ids.has(id)).length;
      return matchCount >= 3;
    },
  },
  {
    name: 'Технически зрелый, но без маркетинга',
    priority: 22,
    match: (ctx) => {
      const hasTech = ctx.hasAny('nextjs', 'react');
      const noAds = !ctx.hasCategory('ad_pixel');
      const noEmail = !ctx.hasCategory('email_marketing');
      const noChat = !ctx.hasCategory('chat');
      return hasTech && noAds && noEmail && noChat;
    },
  },
  {
    name: 'Тратит, но не считает',
    priority: 20,
    match: (ctx) => {
      const adCount = ctx.countCategory('ad_pixel');
      const hasCallTracking = ctx.hasCategory('call_tracking');
      const hasCrm = ctx.hasCategory('crm');
      return adCount >= 2 && !hasCallTracking && !hasCrm;
    },
  },
  {
    name: 'Зрелый цифровой бизнес',
    priority: 18,
    match: (ctx) => {
      const hasAds = ctx.hasCategory('ad_pixel');
      const hasCrm = ctx.hasCategory('crm');
      const hasCallTrackingOrChat = ctx.hasCategory('call_tracking') || ctx.hasCategory('chat');
      return hasAds && hasCrm && hasCallTrackingOrChat;
    },
  },
  {
    name: 'Битрикс-экосистема',
    priority: 17,
    match: (ctx) => {
      const bitrixSignals = ['bitrix_cms', 'bitrix24', '1c_erp'];
      const matches = bitrixSignals.filter((id) => ctx.ids.has(id)).length;
      return matches >= 2;
    },
  },
  {
    name: 'Продаёт через звонки',
    priority: 16,
    match: (ctx) => {
      const hasCallTracking = ctx.hasCategory('call_tracking');
      const noPayments = !ctx.hasCategory('payment');
      const noMarketplace = !ctx.hasCategory('marketplace');
      return hasCallTracking && noPayments && noMarketplace;
    },
  },
  {
    name: 'Зависимость от одного канала',
    priority: 15,
    match: (ctx) => {
      const adCount = ctx.countCategory('ad_pixel');
      const hasEmail = ctx.hasCategory('email_marketing');
      const hasCrm = ctx.hasCategory('crm');
      const hasCallTracking = ctx.hasCategory('call_tracking');
      return adCount === 1 && !hasEmail && !hasCrm && !hasCallTracking;
    },
  },
  {
    name: 'WhatsApp-first бизнес',
    priority: 13,
    match: (ctx) => {
      const hasWhatsapp = ctx.ids.has('whatsapp_widget');
      const noAds = !ctx.hasCategory('ad_pixel');
      const noCallTracking = !ctx.hasCategory('call_tracking');
      const noCrm = !ctx.hasCategory('crm');
      const noPayments = !ctx.hasCategory('payment');
      return hasWhatsapp && noAds && noCallTracking && noCrm && noPayments;
    },
  },
  {
    name: 'E-commerce без маркетинга',
    priority: 10,
    match: (ctx) => {
      const hasPayments = ctx.hasCategory('payment');
      const noAds = !ctx.hasCategory('ad_pixel');
      const noEmail = !ctx.hasCategory('email_marketing');
      return hasPayments && noAds && noEmail;
    },
  },
  {
    name: 'Базовое онлайн-присутствие',
    priority: 5,
    match: (ctx) => {
      const hasOnlyAnalytics = ctx.hasCategory('analytics') &&
        !ctx.hasCategory('ad_pixel') &&
        !ctx.hasCategory('crm') &&
        !ctx.hasCategory('payment') &&
        !ctx.hasCategory('chat') &&
        !ctx.hasCategory('marketplace');
      return hasOnlyAnalytics;
    },
  },
  {
    name: 'Офлайн пытается стать онлайн',
    priority: 3,
    match: (ctx) => {
      const hasSimpleCms = ctx.hasAny('tilda', 'wordpress', 'bitrix_cms');
      const noPayments = !ctx.hasCategory('payment');
      const noCrm = !ctx.hasCategory('crm');
      const noAds = !ctx.hasCategory('ad_pixel');
      const noChat = !ctx.hasCategory('chat');
      const noAnalytics = !ctx.hasCategory('analytics');
      return hasSimpleCms && noPayments && noCrm && noAds && noChat && noAnalytics;
    },
  },
];

export function determineProfile(signals: DetectedSignal[]): string {
  if (signals.length === 0) return '';

  const ctx = buildProfileContext(signals);
  let best: ProfileRule | null = null;

  for (const rule of PROFILE_RULES) {
    if (rule.match(ctx)) {
      if (!best || rule.priority > best.priority) {
        best = rule;
      }
    }
  }

  return best?.name ?? '';
}

export function formatStack(signals: DetectedSignal[]): string {
  return signals.map((s) => s.name).join(', ');
}
