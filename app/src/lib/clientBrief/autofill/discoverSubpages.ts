/**
 * Discovery подстраниц сайта для targeted enrichment'а отдельных полей брифа.
 *
 * Основной autofill (prompt.ts) работает только с главной — этого достаточно
 * чтобы заполнить структурные поля (название, описание, цены, ЦА). Но для
 * полей вида social_proof.cases.comment, impressive_results, common_questions
 * главная даёт максимум «у нас есть раздел кейсов». Чтобы получить РЕАЛЬНЫЕ
 * тексты, надо открыть /cases, /отзывы, /faq и т.п.
 *
 * Этот модуль — **чистая функция**: на вход HTML главной (опционально sitemap),
 * на выход — ранжированный список URL-кандидатов сгруппированных по типу
 * enricher'а. Сетевой ввод-вывод приходит снаружи.
 *
 * Дизайн:
 * - Pattern-based scoring: и URL-путь, и текст ссылки попадают под регулярки
 *   с заранее заданными весами.
 * - На каждый тип (kind) даём максимум 3 URL, по всему сайту — максимум 6.
 *   Это согласовано с DeepSeek Flash 128K окном: 6 страниц × ~15K симв ≈ 90K
 *   симв ≈ 22K токенов — комфортно.
 * - Дубли по нормализованному URL отсекаем (главная же часто линкуется
 *   несколько раз).
 */

export type SubpageKind = 'cases' | 'reviews' | 'press' | 'awards' | 'faq';

export interface SubpageCandidate {
  kind: SubpageKind;
  url: string;
  score: number;
  source: 'nav' | 'sitemap';
  anchorText?: string;
}

export interface DiscoverSubpagesInput {
  /** Абсолютный URL главной страницы (для резолва относительных ссылок). */
  baseUrl: string;
  /** HTML главной страницы. */
  homepageHtml: string;
  /** Текст sitemap.xml, если уже загружен. Опционально. */
  sitemapXml?: string;
}

export interface DiscoverSubpagesOptions {
  /** Кап на общее количество URL во всех типах. По умолчанию 6. */
  maxTotalUrls?: number;
  /** Кап на количество URL для одного типа. По умолчанию 3. */
  maxUrlsPerKind?: number;
}

interface KindPatterns {
  /** Regex для пути URL (case-insensitive). Каждое попадание = +score. */
  urlPatterns: Array<{ re: RegExp; score: number }>;
  /** Regex для текста <a>. */
  anchorPatterns: Array<{ re: RegExp; score: number }>;
}

const PATTERNS: Record<SubpageKind, KindPatterns> = {
  cases: {
    urlPatterns: [
      { re: /\/cases?(\/|$|\?)/i, score: 10 },
      { re: /\/case-stud/i, score: 10 },
      { re: /\/portfolio/i, score: 9 },
      { re: /\/projects?(\/|$|\?)/i, score: 7 },
      { re: /\/works?(\/|$|\?)/i, score: 7 },
      { re: /\/кейс/i, score: 10 },
      { re: /\/портфолио/i, score: 9 },
      { re: /\/работы/i, score: 7 },
      { re: /\/проекты/i, score: 6 },
    ],
    anchorPatterns: [
      { re: /^\s*кейс/i, score: 8 },
      { re: /^\s*наши\s*кейс/i, score: 10 },
      { re: /^\s*успешные\s*кейс/i, score: 10 },
      { re: /^\s*портфолио\s*$/i, score: 9 },
      { re: /^\s*case\s*stud/i, score: 8 },
      { re: /^\s*portfolio\s*$/i, score: 9 },
      { re: /^\s*наши\s*проект/i, score: 7 },
      { re: /^\s*наши\s*работы/i, score: 7 },
    ],
  },
  reviews: {
    urlPatterns: [
      { re: /\/reviews?(\/|$|\?)/i, score: 10 },
      { re: /\/testimonials?/i, score: 10 },
      { re: /\/отзыв/i, score: 10 },
      { re: /\/feedback/i, score: 6 },
    ],
    anchorPatterns: [
      { re: /^\s*отзыв/i, score: 9 },
      { re: /^\s*клиенты\s*о\s*нас/i, score: 9 },
      { re: /^\s*testimonial/i, score: 8 },
      { re: /^\s*review/i, score: 8 },
    ],
  },
  press: {
    urlPatterns: [
      { re: /\/press(\/|$|\?)/i, score: 10 },
      { re: /\/media(\/|$|\?)/i, score: 7 },
      { re: /\/news(\/|$|\?)/i, score: 6 },
      { re: /\/смм?и/i, score: 9 },
      { re: /\/публикац/i, score: 8 },
    ],
    anchorPatterns: [
      { re: /^\s*сми\s*о\s*нас/i, score: 10 },
      { re: /^\s*пресса\s*о\s*нас/i, score: 10 },
      { re: /^\s*press/i, score: 8 },
      { re: /^\s*публикац/i, score: 7 },
      { re: /^\s*медиа/i, score: 6 },
    ],
  },
  awards: {
    urlPatterns: [
      { re: /\/awards?(\/|$|\?)/i, score: 10 },
      { re: /\/achievements?/i, score: 8 },
      { re: /\/награды/i, score: 10 },
      { re: /\/сертификат/i, score: 9 },
      { re: /\/достижен/i, score: 8 },
    ],
    anchorPatterns: [
      { re: /^\s*награды/i, score: 9 },
      { re: /^\s*сертификат/i, score: 8 },
      { re: /^\s*award/i, score: 8 },
      { re: /^\s*достижен/i, score: 7 },
    ],
  },
  faq: {
    urlPatterns: [
      { re: /\/faq(\/|$|\?)/i, score: 10 },
      { re: /\/вопрос/i, score: 9 },
      { re: /\/help(\/|$|\?)/i, score: 6 },
    ],
    anchorPatterns: [
      { re: /^\s*faq\s*$/i, score: 9 },
      { re: /^\s*вопрос/i, score: 8 },
      { re: /^\s*частые\s*вопрос/i, score: 10 },
    ],
  },
};

const ALL_KINDS: readonly SubpageKind[] = ['cases', 'reviews', 'press', 'awards', 'faq'];

/** Резолвит относительную/абсолютную ссылку в абсолютную; возвращает null если невалидно/чужой домен. */
export function resolveSameOriginUrl(href: string, baseUrl: string): string | null {
  if (typeof href !== 'string') return null;
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('mailto:') || trimmed.startsWith('tel:')) {
    return null;
  }
  if (trimmed.startsWith('javascript:')) return null;

  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return null;
  }

  let resolved: URL;
  try {
    resolved = new URL(trimmed, base);
  } catch {
    return null;
  }

  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
  // Только same-origin: не уходим на vk.com, dzen.ru и т.п.
  if (resolved.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) {
    return null;
  }

  // Нормализуем — без фрагмента, без trailing slash для корня других директорий.
  resolved.hash = '';
  return resolved.toString();
}

/** Извлекает <a href="..."> + текст из HTML. Лёгкий regex-парсер, без cheerio в этом hot path. */
function extractAnchors(html: string): Array<{ href: string; text: string }> {
  if (typeof html !== 'string' || !html) return [];
  const anchors: Array<{ href: string; text: string }> = [];
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  let safety = 0;
  while ((match = re.exec(html)) !== null) {
    if (++safety > 5000) break; // safety net for pathological inputs
    const href = match[1];
    const innerHtml = match[2] ?? '';
    // Стрипим теги, нормализуем whitespace. alt у <img> тоже важен (иконки-ссылки),
    // но в 90% кейсов хватает текста.
    const text = innerHtml
      .replace(/<img\b[^>]*\balt\s*=\s*["']([^"']*)["'][^>]*>/gi, ' $1 ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    anchors.push({ href, text });
  }
  return anchors;
}

/** Извлекает <loc>URL</loc> из sitemap.xml. */
function extractSitemapUrls(xml: string): string[] {
  if (typeof xml !== 'string' || !xml) return [];
  const urls: string[] = [];
  const re = /<loc\b[^>]*>([\s\S]*?)<\/loc>/gi;
  let match: RegExpExecArray | null;
  let safety = 0;
  while ((match = re.exec(xml)) !== null) {
    if (++safety > 10000) break;
    const url = (match[1] ?? '').trim();
    if (url) urls.push(url);
  }
  return urls;
}

/** Скорит один URL+анкор против шаблонов одного типа. Возвращает 0 если не релевантен. */
function scoreForKind(url: string, anchorText: string, kind: SubpageKind): number {
  const patterns = PATTERNS[kind];
  let score = 0;
  let urlPath: string;
  try {
    urlPath = new URL(url).pathname + new URL(url).search;
  } catch {
    return 0;
  }
  for (const { re, score: w } of patterns.urlPatterns) {
    if (re.test(urlPath)) score += w;
  }
  if (anchorText) {
    for (const { re, score: w } of patterns.anchorPatterns) {
      if (re.test(anchorText)) score += w;
    }
  }
  return score;
}

/**
 * Главная функция: вернуть лучших кандидатов на каждую категорию.
 *
 * Алгоритм:
 *   1. Из HTML главной собираем <a href> → пары (url, anchorText).
 *   2. Из sitemap.xml (если дан) добавляем (url, "") — анкоров нет.
 *   3. Резолвим, дедупим по нормализованному URL (берём максимальный score).
 *   4. Для каждого kind скорим, берём топ-N с порогом score > 0.
 *   5. Глобальный лимит maxTotalUrls — если разных URL получилось больше,
 *      обрезаем по убыванию score (но стараемся сохранить хотя бы один URL
 *      на kind — это даёт enricher'у шанс сработать на каждом направлении).
 */
export function discoverSubpages(
  input: DiscoverSubpagesInput,
  options: DiscoverSubpagesOptions = {},
): SubpageCandidate[] {
  const maxTotalUrls = Math.max(1, options.maxTotalUrls ?? 6);
  const maxUrlsPerKind = Math.max(1, options.maxUrlsPerKind ?? 3);

  // 1. Собрать все (url, anchorText, source) с дедупом по url.
  type RawCandidate = { url: string; anchorText: string; source: 'nav' | 'sitemap' };
  const byUrl = new Map<string, RawCandidate>();

  for (const { href, text } of extractAnchors(input.homepageHtml)) {
    const resolved = resolveSameOriginUrl(href, input.baseUrl);
    if (!resolved) continue;
    const existing = byUrl.get(resolved);
    if (existing) {
      // Если уже есть с пустым anchor — обогащаем.
      if (!existing.anchorText && text) existing.anchorText = text;
    } else {
      byUrl.set(resolved, { url: resolved, anchorText: text, source: 'nav' });
    }
  }

  if (input.sitemapXml) {
    for (const rawUrl of extractSitemapUrls(input.sitemapXml)) {
      const resolved = resolveSameOriginUrl(rawUrl, input.baseUrl);
      if (!resolved) continue;
      if (!byUrl.has(resolved)) {
        byUrl.set(resolved, { url: resolved, anchorText: '', source: 'sitemap' });
      }
    }
  }

  // 2. Скорим каждый URL под каждый kind. URL может попасть в несколько типов
  //    (например, /reviews-and-cases), но мы выбираем kind с максимальным
  //    score — иначе одна страница забьёт 2 слота.
  const perKind: Record<SubpageKind, SubpageCandidate[]> = {
    cases: [],
    reviews: [],
    press: [],
    awards: [],
    faq: [],
  };

  for (const { url, anchorText, source } of byUrl.values()) {
    let bestKind: SubpageKind | null = null;
    let bestScore = 0;
    for (const kind of ALL_KINDS) {
      const s = scoreForKind(url, anchorText, kind);
      if (s > bestScore) {
        bestScore = s;
        bestKind = kind;
      }
    }
    if (bestKind && bestScore > 0) {
      perKind[bestKind].push({
        kind: bestKind,
        url,
        score: bestScore,
        source,
        anchorText: anchorText || undefined,
      });
    }
  }

  // 3. Сортируем внутри kind по score (desc), обрезаем до maxUrlsPerKind.
  for (const kind of ALL_KINDS) {
    perKind[kind].sort((a, b) => b.score - a.score);
    perKind[kind] = perKind[kind].slice(0, maxUrlsPerKind);
  }

  // 4. Глобальный лимит: если суммарно больше maxTotalUrls — оставляем по
  //    одному топовому на каждый kind гарантированно, остальное добираем по
  //    глобальному score.
  const flat: SubpageCandidate[] = [];
  for (const kind of ALL_KINDS) {
    if (perKind[kind][0]) {
      flat.push(perKind[kind][0]);
    }
  }
  const overflow: SubpageCandidate[] = [];
  for (const kind of ALL_KINDS) {
    for (const c of perKind[kind].slice(1)) {
      overflow.push(c);
    }
  }
  overflow.sort((a, b) => b.score - a.score);

  const result = flat.concat(overflow).slice(0, maxTotalUrls);
  // Финальная сортировка для предсказуемого порядка: kind→score.
  result.sort((a, b) => {
    const ai = ALL_KINDS.indexOf(a.kind);
    const bi = ALL_KINDS.indexOf(b.kind);
    if (ai !== bi) return ai - bi;
    return b.score - a.score;
  });
  return result;
}

/** Удобный фильтр для consumer'а: «дай мне URL только для cases». */
export function pickKind(
  candidates: readonly SubpageCandidate[],
  kind: SubpageKind,
): SubpageCandidate[] {
  return candidates.filter((c) => c.kind === kind);
}
