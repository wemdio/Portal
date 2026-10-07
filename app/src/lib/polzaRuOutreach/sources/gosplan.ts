/**
 * ГосПлан API (gosplan.info) — контракты ЕИС: 44-ФЗ (госконтракты) и 223-ФЗ
 * (закупки госкомпаний). Источник для «контрактов» и «тендеров» автоаутрича
 * вместо ручных выгрузок ЕИС.
 *
 * Проверено 07.10.2026 (swagger.gosplan.info, gosplan.info/docs/getting-started/api-key):
 *   тест — https://v2test.gosplan.info, без ключа, 10 запросов в минуту на IP;
 *   прод — https://v2.gosplan.info, ключ в заголовке `apikey`, 10 в секунду / 12 000 в час.
 *   GET /fz44/contracts, /fz223/contracts — индекс: reg_num, price, subject,
 *     customer (ИНН заказчика), suppliers (ИНН поставщиков), published_at (UTC без зоны).
 *     Фильтры published_after/published_before (ISO с зоной), price_ge, currency_code,
 *     sort=published_at_asc; limit ≤ 100, skip ≤ 1000 — дальше курсор по published_at.
 *   GET /fz44/contracts/{reg_num}, /fz223/contracts/{reg_num} — полный документ:
 *     только в нём названия поставщика и заказчика (в индексе одни ИНН).
 * Один день 44-ФЗ от 3 млн ₽ — порядка 2–2,5 тыс. контрактов (~1100 к полудню 05.10.2026).
 * 223-ФЗ: suppliers в индексе почти всегда пуст (05.10.2026 — 0 из 933 от 3 млн ₽),
 * и в полном документе поставщика нет — тендеры отсюда дают единицы строк.
 */

export type GosplanLaw = 'fz44' | 'fz223';

export const GOSPLAN_TEST_URL = 'https://v2test.gosplan.info';
export const GOSPLAN_PROD_URL = 'https://v2.gosplan.info';
/** Порог цены контракта по умолчанию, ₽. */
export const GOSPLAN_DEFAULT_MIN_PRICE = 3_000_000;

const PAGE = 100;
const MAX_SKIP = 1000;
const RETRIES = 5;

export interface GosplanConfig {
  baseUrl: string;
  apiKey: string | null;
  minPrice: number;
  /** Пауза между запросами: тест — 10 в минуту на IP. */
  intervalMs: number;
  timeoutMs: number;
  /** Сколько полных документов за день и закон берём ради названий. */
  detailLimit: number;
}

function envNum(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Настройки из env. Нет ни GOSPLAN_API_KEY, ни GOSPLAN_BASE_URL → null (синк выключен).
 * Без адреса: с ключом — прод, без ключа — тестовый сервер.
 */
export function gosplanConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GosplanConfig | null {
  const apiKey = env.GOSPLAN_API_KEY?.trim() || null;
  const baseRaw = env.GOSPLAN_BASE_URL?.trim() || '';
  if (!apiKey && !baseRaw) return null;
  const baseUrl = (baseRaw || (apiKey ? GOSPLAN_PROD_URL : GOSPLAN_TEST_URL)).replace(/\/+$/, '');
  const isTest = baseUrl.includes('v2test.');
  return {
    baseUrl,
    apiKey,
    minPrice: envNum(env.GOSPLAN_MIN_PRICE, GOSPLAN_DEFAULT_MIN_PRICE),
    intervalMs: envNum(env.GOSPLAN_REQUEST_INTERVAL_MS, isTest ? 7_000 : 150),
    timeoutMs: envNum(env.GOSPLAN_TIMEOUT_MS, 30_000),
    detailLimit: envNum(env.GOSPLAN_DETAIL_LIMIT, isTest ? 30 : 1_000),
  };
}

/** Строка индекса контрактов — только нужные поля. */
export interface GosplanContractIndex {
  reg_num: string;
  price: number | null;
  currency_code?: string | null;
  subject?: string | null;
  customer?: string | null;
  suppliers?: string[] | null;
  published_at: string;
  purchase_number?: string | null;
  stage?: string | null;
}

/** Победитель контракта: юрлицо, один (самый крупный) контракт на ИНН за день. */
export interface GosplanWin {
  law: GosplanLaw;
  regNum: string;
  supplierInn: string;
  amount: number;
  subject: string | null;
  customerInn: string | null;
  purchaseNumber: string | null;
  publishedAt: string;
}

export interface GosplanParties {
  supplierName: string | null;
  customerName: string | null;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Границы дня по Москве в формате, который ждёт API: 2026-10-06T00:00:00+03:00. */
export function mskDayBounds(day: string): { after: string; before: string } {
  const next = new Date(`${day}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return { after: `${day}T00:00:00+03:00`, before: `${next.toISOString().slice(0, 10)}T00:00:00+03:00` };
}

/** published_at приходит в UTC без зоны — дописываем Z. */
export function gosplanTime(value: string): string {
  return /[zZ]|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`;
}

/** Карточка контракта на zakupki.gov.ru. */
export function contractUrl(law: GosplanLaw, regNum: string): string {
  return law === 'fz44'
    ? `https://zakupki.gov.ru/epz/contract/contractCard/common-info.html?reestrNumber=${regNum}`
    : `https://zakupki.gov.ru/epz/contractfz223/search/results.html?searchString=${regNum}`;
}

/**
 * Контракты → победители-юрлица (ИНН из 10 цифр: ИП и физлица отсекаются),
 * один на ИНН — самый крупный контракт. Аннулированные (stage IN) пропускаем.
 */
export function pickWins(law: GosplanLaw, contracts: GosplanContractIndex[], minPrice: number): GosplanWin[] {
  const byInn = new Map<string, GosplanWin>();
  for (const c of contracts) {
    const amount = Number(c.price);
    if (!Number.isFinite(amount) || amount < minPrice) continue;
    if (c.stage === 'IN') continue;
    if (c.currency_code && c.currency_code !== 'RUB') continue;
    for (const raw of c.suppliers ?? []) {
      const inn = String(raw ?? '').trim();
      if (!/^\d{10}$/.test(inn)) continue;
      const prev = byInn.get(inn);
      if (prev && prev.amount >= amount) continue;
      byInn.set(inn, {
        law,
        regNum: String(c.reg_num),
        supplierInn: inn,
        amount,
        subject: c.subject?.trim() || null,
        customerInn: c.customer?.trim() || null,
        purchaseNumber: c.purchase_number?.trim() || null,
        publishedAt: gosplanTime(String(c.published_at)),
      });
    }
  }
  return Array.from(byInn.values()).sort((a, b) => b.amount - a.amount);
}

/**
 * Название стороны в полном документе: схемы 44-ФЗ и 223-ФЗ разные, поэтому
 * ищем любой объект с этим ИНН (inn/INN) и названием (shortName → fullName → name).
 */
export function findPartyName(doc: unknown, inn: string): string | null {
  const stack: unknown[] = [doc];
  let fallback: string | null = null;
  let seen = 0;
  while (stack.length && seen < 50_000) {
    const node = stack.pop();
    seen += 1;
    if (!node || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const item of node) stack.push(item);
      continue;
    }
    const o = node as Record<string, unknown>;
    if (String(o.inn ?? o.INN ?? '').trim() === inn) {
      const short = typeof o.shortName === 'string' ? o.shortName.trim() : '';
      if (short) return short;
      const full = typeof o.fullName === 'string' ? o.fullName.trim() : typeof o.name === 'string' ? o.name.trim() : '';
      if (full && !fallback) fallback = full;
    }
    for (const v of Object.values(o)) if (v && typeof v === 'object') stack.push(v);
  }
  return fallback;
}

export class GosplanError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
  }
}

/** Воркер останавливается — синк бросает день, курсор не двигается. */
export class GosplanStopped extends Error {
  constructor() {
    super('остановка воркера');
  }
}

export class GosplanClient {
  private lastRequestAt = 0;
  requests = 0;

  constructor(
    private readonly cfg: GosplanConfig,
    private readonly opts: { shouldStop?: () => boolean } = {},
  ) {}

  /** GET с паузой между запросами и повторами на 429 / 5xx / обрыв. 404 → null. */
  private async get(path: string, params: Record<string, string | number | undefined> = {}): Promise<unknown> {
    const url = new URL(`${this.cfg.baseUrl}${path}`);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.cfg.apiKey) headers.apikey = this.cfg.apiKey;

    let lastErr: unknown = null;
    for (let attempt = 0; attempt < RETRIES; attempt += 1) {
      if (this.opts.shouldStop?.()) throw new GosplanStopped();
      const wait = this.lastRequestAt + this.cfg.intervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastRequestAt = Date.now();
      this.requests += 1;
      let res: Response;
      try {
        res = await fetch(url, { headers, signal: AbortSignal.timeout(this.cfg.timeoutMs) });
      } catch (err) {
        lastErr = err;
        await sleep(Math.min(60_000, 5_000 * 2 ** attempt));
        continue;
      }
      if (res.ok) return res.json();
      if (res.status === 404) return null;
      const body = (await res.text().catch(() => '')).slice(0, 300);
      lastErr = new GosplanError(`ГосПлан ${path}: HTTP ${res.status} ${body}`, res.status);
      if (res.status !== 429 && res.status < 500) throw lastErr;
      // Лимит: ждём до сброса окна (RateLimit-Reset, секунды), иначе — растущая пауза.
      const reset = Number(res.headers.get('ratelimit-reset'));
      const backoff = Number.isFinite(reset) && reset > 0 ? reset * 1000 + 1_000 : 5_000 * 2 ** attempt;
      await sleep(Math.min(120_000, backoff));
    }
    throw lastErr instanceof Error ? lastErr : new GosplanError(`ГосПлан ${path}: нет ответа`, null);
  }

  /**
   * Все контракты, опубликованные за день по Москве, с ценой от minPrice.
   * Страницы по 100; после skip=1000 сдвигаем published_after на последнюю запись.
   */
  async contractsForDay(law: GosplanLaw, day: string): Promise<GosplanContractIndex[]> {
    const { after, before } = mskDayBounds(day);
    const byReg = new Map<string, GosplanContractIndex>();
    let cursor = after;
    for (;;) {
      let lastPublished: string | null = null;
      let full = false;
      for (let skip = 0; skip <= MAX_SKIP; skip += PAGE) {
        const page = await this.get(`/${law}/contracts`, {
          published_after: cursor,
          published_before: before,
          price_ge: this.cfg.minPrice,
          currency_code: 'RUB',
          sort: 'published_at_asc',
          limit: PAGE,
          skip,
        });
        if (!Array.isArray(page)) throw new GosplanError(`ГосПлан /${law}/contracts: ответ не массив`, null);
        for (const c of page as GosplanContractIndex[]) {
          if (c?.reg_num) byReg.set(String(c.reg_num), c);
          if (c?.published_at) lastPublished = gosplanTime(String(c.published_at));
        }
        full = page.length === PAGE;
        if (!full) break;
      }
      // Дошли до конца выдачи — или упёрлись в skip и двигаем курсор вперёд.
      if (!full || !lastPublished || lastPublished === cursor) break;
      cursor = lastPublished;
    }
    return Array.from(byReg.values());
  }

  /** Названия поставщика и заказчика из полного документа контракта. */
  async parties(law: GosplanLaw, regNum: string, supplierInn: string, customerInn: string | null): Promise<GosplanParties> {
    const doc = await this.get(`/${law}/contracts/${encodeURIComponent(regNum)}`);
    if (!doc) return { supplierName: null, customerName: null };
    return {
      supplierName: findPartyName(doc, supplierInn),
      customerName: customerInn ? findPartyName(doc, customerInn) : null,
    };
  }
}
