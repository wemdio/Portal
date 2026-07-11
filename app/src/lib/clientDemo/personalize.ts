import 'server-only';
import { lookup } from 'node:dns/promises';
import { callOpenRouterChat } from '@/lib/openrouter/client';
import { WebsiteFetchError } from '@/lib/clientBrief/autofill';
import { DEFAULT_HYPOTHESES_MODEL } from '@/lib/projectBriefHypotheses/generateHypotheses';

/**
 * Серверная часть демо-персонализации («вставьте свой сайт» в демо-брифе):
 * SSRF-гейт перед скрейпом + генерация короткой цепочки писем по брифу.
 * Оркестрация шагов и лимиты живут в роуте /api/client/demo/personalize.
 */

export interface DemoPersonalizeLetter {
  subject: string;
  body: string;
  wait_days: number;
}

/** Модель демо-прогонов: дешёвая и переопределяемая отдельно от боевых фич. */
export const DEMO_PERSONALIZE_MODEL =
  process.env.DEMO_PERSONALIZE_MODEL ?? DEFAULT_HYPOTHESES_MODEL;

function isPrivateIpV4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateIp(ip: string): boolean {
  const v4mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4mapped) return isPrivateIpV4(v4mapped[1]);
  if (ip.includes(':')) {
    const lower = ip.toLowerCase();
    return (
      lower === '::' ||
      lower === '::1' ||
      lower.startsWith('fc') ||
      lower.startsWith('fd') ||
      lower.startsWith('fe8') ||
      lower.startsWith('fe9') ||
      lower.startsWith('fea') ||
      lower.startsWith('feb')
    );
  }
  return isPrivateIpV4(ip);
}

/**
 * SSRF-гейт: URL от АНОНИМНОГО посетителя демо, а скрейпер ходит по нему с
 * прод-сервера. Режем всё, что резолвится в приватные/служебные адреса
 * (localhost, 10.x, 169.254.x metadata и т.п.), до первого запроса.
 * Остаточный риск — redirect на приватный адрес после первого хопа
 * (fetchWebsiteHtml следует редиректам); принят осознанно: ответ уходит только
 * в LLM-промпт и посетителю, внутренних сервисов, отвечающих маркетинговым
 * HTML, на проде нет.
 */
export async function assertPublicWebsite(normalizedUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(normalizedUrl);
  } catch {
    throw new WebsiteFetchError('Невалидный URL сайта', 400);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new WebsiteFetchError('Поддерживаются только http/https', 400);
  }
  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new WebsiteFetchError('Этот адрес недоступен для разбора', 400);
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new WebsiteFetchError('Не удалось найти такой сайт (DNS)', 502);
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateIp(a.address))) {
    throw new WebsiteFetchError('Этот адрес недоступен для разбора', 400);
  }
}

/** Нормализованный host без www — ключ кэша прогонов. */
export function personalizeCacheDomain(resolvedOrNormalizedUrl: string): string {
  try {
    return new URL(resolvedOrNormalizedUrl).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return resolvedOrNormalizedUrl.toLowerCase();
  }
}

const LETTERS_SYSTEM_PROMPT = `Ты — копирайтер холодных B2B-писем на русском языке.
По брифу компании напиши цепочку из РОВНО 5 коротких писем для холодной email-рассылки её потенциальным клиентам.

Требования к письмам:
- Каждое письмо 400–700 знаков, деловой тон без канцелярита, один чёткий CTA.
- Письмо 1 — первое касание (боль + оффер); письма 2–4 — follow-up'ы с РАЗНЫМИ углами (кейс/цифры, другой сегмент боли, социальное доказательство); письмо 5 — короткое закрывающее (breakup).
- Каждое письмо самодостаточно и не повторяет предыдущие дословно.
- Используй merge-теги {{firstName}} и {{companyName}} для персонализации получателя.
- Никаких выдуманных фактов: только то, что есть в брифе. Если цифр нет — пиши без цифр.

Ответ — СТРОГО валидный JSON-массив из 5 объектов без пояснений и markdown-ограждений:
[{"subject":"...","body":"...","wait_days":0},{"subject":"...","body":"...","wait_days":3},{"subject":"...","body":"...","wait_days":4},{"subject":"...","body":"...","wait_days":5},{"subject":"...","body":"...","wait_days":7}]`;

function parseLettersJson(raw: string): DemoPersonalizeLetter[] {
  const cleaned = raw.replace(/```(?:json)?/gi, '').trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('AI вернул ответ без JSON-массива');
  const parsed = JSON.parse(cleaned.slice(start, end + 1)) as unknown;
  if (!Array.isArray(parsed)) throw new Error('AI вернул не массив');
  const letters = parsed
    .filter(
      (l): l is DemoPersonalizeLetter =>
        !!l &&
        typeof (l as DemoPersonalizeLetter).subject === 'string' &&
        typeof (l as DemoPersonalizeLetter).body === 'string',
    )
    .slice(0, 5)
    .map((l) => ({
      subject: l.subject.trim().slice(0, 200),
      body: l.body.trim().slice(0, 2000),
      wait_days: Number.isFinite(l.wait_days) ? Math.max(0, Math.round(l.wait_days)) : 3,
    }));
  // Панель показывает первые 3 и блюрит остальные; меньше 3 — цепочки нет.
  // Не хардфейлим на 4 (лучше показать 3+1, чем 502), но промпт просит 5.
  if (letters.length < 3) throw new Error('AI вернул неполную цепочку');
  return letters;
}

export async function generateDemoLetters(options: {
  apiKey: string;
  briefText: string;
  model?: string;
  signal?: AbortSignal;
}): Promise<DemoPersonalizeLetter[]> {
  const raw = await callOpenRouterChat({
    apiKey: options.apiKey,
    model: options.model ?? DEMO_PERSONALIZE_MODEL,
    messages: [
      { role: 'system', content: LETTERS_SYSTEM_PROMPT },
      { role: 'user', content: `БРИФ КОМПАНИИ:\n\n${options.briefText.slice(0, 12_000)}` },
    ],
    maxTokens: 4000,
    signal: options.signal,
  });
  return parseLettersJson(raw);
}
