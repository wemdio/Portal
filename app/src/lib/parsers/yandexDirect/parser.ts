/**
 * Yandex Direct Parser — низкоуровневая работа с XMLStock Yandex Live API.
 *
 * XMLStock (https://xmlstock.com) — реселлер Yandex Search API. Эндпоинт
 * `yandexlive` отдаёт «живую» выдачу с рекламными блоками topads/bottomads,
 * чего нет в обычном Yandex XML.
 *
 * Чистые функции без БД — оркестрация в runner.ts.
 *
 * Ключи XMLSTOCK_USER / XMLSTOCK_KEY берутся ТОЛЬКО из env (никаких
 * захардкоженных fallback'ов — в оригинальном Python-инструменте они были
 * зашиты в код, что небезопасно).
 */
import * as cheerio from 'cheerio';

export const XMLSTOCK_BASE_URL = 'https://xmlstock.com/yandexlive/xml/';

/** Рекламодатель / сайт из выдачи. */
export interface YDAdvertiser {
  source: 'direct' | 'organic';
  block: 'topads' | 'bottomads' | 'organic';
  domain: string;
  title: string;
  text: string;
  url: string;
}

/**
 * Домены, которые не интересны как лиды для аутрича: поисковики, фриланс-
 * биржи, агрегаторы, медиа, job-борды, маркетплейсы, госуслуги.
 * Порт SKIP_DOMAINS из parser.py.
 */
export const SKIP_DOMAINS = new Set<string>([
  // Поисковики
  'yandex.ru', 'direct.yandex.ru', 'ya.ru', 'yandex.com', 'google.com', 'google.ru',
  // Фриланс-биржи и агрегаторы услуг
  'profi.ru', 'kwork.ru', 'freelance.ru', 'fl.ru', 'upwork.com', 'fiverr.com',
  'freelancehunt.com', 'youdo.com', 'mastergrad.com', 'telderi.ru',
  'workspace.ru', 'clutch.co',
  // Каталоги компаний
  'yellowpages.ru', '2gis.ru', 'zoon.ru', 'yell.ru', 'firmika.ru', 'orgpage.ru', 'topfirm.ru',
  // Медиа / пресса
  'vc.ru', 'habr.com', 'rb.ru', 'rusbase.com', 'spark.ru', 'executive.ru',
  'sostav.ru', 'rbc.ru', 'kommersant.ru', 'vedomosti.ru',
  // Job-борды
  'hh.ru', 'superjob.ru', 'zarplata.ru', 'rabota.ru', 'trudvsem.ru', 'careerist.ru',
  // Маркетплейсы
  'avito.ru', 'ozon.ru', 'wildberries.ru', 'lamoda.ru',
  // Прочее
  'youtube.com', 'wikipedia.org', 'wiki.ru', 'tinkoff.ru', 'sberbank.ru', 'gosuslugi.ru',
]);

export interface XMLStockCreds {
  user: string;
  key: string;
}

/** Читает XMLStock-креды из env. Кидает Error если не настроены. */
export function getXMLStockCreds(): XMLStockCreds {
  const user = (process.env.XMLSTOCK_USER ?? '').trim();
  const key = (process.env.XMLSTOCK_KEY ?? '').trim();
  if (!user || !key) {
    throw new Error('XMLSTOCK_USER / XMLSTOCK_KEY не настроены в env');
  }
  return { user, key };
}

/** Запрос к XMLStock Yandex Live. Возвращает сырой XML-текст. */
export async function searchYandex(
  creds: XMLStockCreds,
  query: string,
  regionCode: number,
  page = 0,
  signal?: AbortSignal,
): Promise<string> {
  const params = new URLSearchParams({
    user: creds.user,
    key: creds.key,
    query,
    lr: String(regionCode),
    groupby: '10',
    page: String(page),
  });
  const res = await fetch(`${XMLSTOCK_BASE_URL}?${params.toString()}`, {
    signal,
    headers: { 'User-Agent': 'Portal/1.0 (Yandex Direct parser)' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`XMLStock ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.text();
}

function domainFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host.startsWith('www.') ? host.slice(4) : host;
  } catch {
    return '';
  }
}

/** true → домен надо пропустить (поисковик / агрегатор / пустой). */
export function shouldSkipDomain(domain: string): boolean {
  if (!domain) return true;
  for (const bad of SKIP_DOMAINS) {
    if (domain === bad || domain.endsWith('.' + bad)) return true;
  }
  return false;
}

/**
 * Парсит XML-ответ XMLStock Yandex Live.
 *
 * includeOrganic=true → добавляет топ органической выдачи (сайты, которые
 * обычно тоже крутят рекламу — расширяет список лидов).
 *
 * Бросает Error если XMLStock вернул <error> (невалидный ключ, лимит и т.п.)
 */
export function parseXmlResponse(xmlText: string, includeOrganic = false): YDAdvertiser[] {
  const $ = cheerio.load(xmlText, { xmlMode: true });

  const errorEl = $('error').first();
  if (errorEl.length > 0) {
    throw new Error(`XMLStock error: ${errorEl.text().trim()}`);
  }

  const results: YDAdvertiser[] = [];

  // ── Реклама Директа: topads + bottomads ──────────────────────────────────
  for (const blockTag of ['topads', 'bottomads'] as const) {
    $(`${blockTag} > query`).each((_, el) => {
      const q = $(el);
      const url = q.find('url').first().text().trim();
      const domain = domainFromUrl(url);
      if (shouldSkipDomain(domain)) return;
      results.push({
        source: 'direct',
        block: blockTag,
        domain,
        title: q.find('title').first().text().trim(),
        text: q.find('snippet').first().text().trim(),
        url,
      });
    });
  }

  // ── Органика: топ сайтов ──────────────────────────────────────────────────
  if (includeOrganic) {
    $('group > doc').each((_, el) => {
      const doc = $(el);
      const url = doc.find('url').first().text().trim();
      const domain = domainFromUrl(url);
      if (shouldSkipDomain(domain)) return;
      // Лучший (самый длинный) сниппет
      let snippet = '';
      doc.find('passages > passage').each((__, p) => {
        const t = $(p).text().trim();
        if (t.length > snippet.length) snippet = t;
      });
      results.push({
        source: 'organic',
        block: 'organic',
        domain,
        title: doc.find('title').first().text().trim(),
        text: snippet,
        url,
      });
    });
  }

  return results;
}

/**
 * sleep-утилита для пауз между запросами.
 *
 * Пауза обрывается отменой и при этом РЕЗОЛВИТСЯ, а не бросает: что делать с
 * остановкой, решает вызывающий код (та же форма, что в yandexMapsWorker.ts).
 * Без сигнала — обычный setTimeout, как было.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    // AbortSignal не переигрывает уже случившуюся отмену для поздних
    // слушателей — поэтому проверка выше идёт до подписки.
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}
