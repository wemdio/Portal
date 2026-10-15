/**
 * Telegram ping to the team when a visitor submits the landing demo-gate
 * (name/phone/email) before entering /demo. Mirrors the support/lead alert
 * pattern (lib/clientSupport/telegramAlert.ts).
 *   - Bot token: DEMO_LEADS_TELEGRAM_BOT_TOKEN (dedicated bot for demo signups),
 *     falling back to LEAD_ALERTS → CHANGELOG so it still works before a dedicated
 *     bot is provisioned. Set the dedicated token to split it off its own bot.
 *   - Chat: DEMO_LEADS_TELEGRAM_CHAT_ID, falling back to the lead-alerts chat so
 *     it works out of the box (demo signups are leads); set the dedicated env to
 *     route them to their own chat.
 *   - Topic: DEMO_LEADS_TELEGRAM_THREAD_ID — for forum (topic-enabled) supergroups,
 *     the message_thread_id of the target topic. Paired with the chat: only honoured
 *     when the dedicated chat is set (a thread id is only valid within its own chat);
 *     when we fall back to the lead chat we inherit LEAD_ALERTS_TELEGRAM_THREAD_ID.
 *
 * Never throws: the /api/demo-lead route awaits it best-effort; a TG outage must
 * not break the visitor reaching the demo. The lead is already stored regardless.
 */

const TG_FETCH_TIMEOUT_MS = 10_000;

/** Language versions of the outreachos.xyz landing: /en/ and /ru/. */
export type DemoLeadPageLang = 'en' | 'ru';

export interface DemoLeadData {
  name: string;
  email: string;
  phone?: string | null;
  telegram?: string | null;
  company?: string | null;
  message?: string | null;
  /** Which surface produced the lead — drives the alert title. */
  source?: string | null;
  referrer?: string | null;
  /**
   * Campaign attribution: at signup — the landing's parent-domain cookie oos_utm
   * (read server-side by /api/signup); at /api/demo-lead — the fields the
   * outreachos.xyz form sends with the lead. Only its utm_* keys are rendered;
   * referrer/landing/ts/lang may also be present and are not read from here —
   * callers pass what they want shown as `referrer` (signup) or `outsideReferrer` /
   * `landingUrl` / `utmEarlierVisitAt` / `pageLang` (demo-lead).
   */
  utm?: Record<string, string> | null;
  /**
   * Language version of the landing page the form was sent from (outreachos.xyz
   * /en/ or /ru/), so the team answers in that language. Shown as
   * «🌐 Язык страницы: RU»; absent — no line.
   */
  pageLang?: DemoLeadPageLang | null;
  /** Site the visitor came from before the landing (not the landing itself). */
  outsideReferrer?: string | null;
  /** URL the visitor arrived on, query string included. */
  landingUrl?: string | null;
  /**
   * ISO time of the earlier visit the utm_* values come from — set only when the
   * landing form took them from its 30-day oos_utm cookie, not from the visit that
   * sent the lead. Shown as «(заход ДД.ММ ЧЧ:ММ МСК)» after the UTM line.
   */
  utmEarlierVisitAt?: string | null;
}

/** Telegram rejects sendMessage text longer than this, counted after entity parsing. */
const TG_TEXT_MAX = 4096;
/** What a URL — and, as a last resort, every value — is cut to when the alert is over TG_TEXT_MAX. */
const ALERT_CUT_MAX = 200;

/** Human label per lead source, for the Telegram alert title. */
const SOURCE_LABEL: Record<string, string> = {
  hero: 'Обсудить задачу',
  register: 'Регистрация',
  demo: 'Демо',
  // One form on both language pages (/en/, /ru/); the «🌐 Язык страницы» line tells them apart.
  eng_pilot: 'Лендинг outreachos.xyz: проверка ниши',
};

function sourceLabel(source?: string | null): string {
  return (source && SOURCE_LABEL[source]) || 'лендинг';
}

/** Headline: a registration is a sign-up notice, not a "новый лид". */
function titleLine(source?: string | null): string {
  if (source === 'register') return '✅ <b>Новая регистрация</b>';
  return `🎯 <b>Новый лид — ${esc(sourceLabel(source))}</b>`;
}

function getToken(): string {
  return (
    process.env.DEMO_LEADS_TELEGRAM_BOT_TOKEN ||
    process.env.LEAD_ALERTS_TELEGRAM_BOT_TOKEN ||
    process.env.CHANGELOG_BOT_TOKEN ||
    ''
  );
}

function getChatId(): string {
  return (
    process.env.DEMO_LEADS_TELEGRAM_CHAT_ID ||
    process.env.LEAD_ALERTS_TELEGRAM_CHAT_ID ||
    ''
  );
}

function getThreadId(): number | null {
  // A thread id is only valid inside its own chat, so pair it with the chat above:
  // use the dedicated thread when the dedicated chat is set; otherwise (we fell back
  // to the lead chat) inherit the lead chat's thread. Unset/invalid → no thread.
  const raw = process.env.DEMO_LEADS_TELEGRAM_CHAT_ID
    ? process.env.DEMO_LEADS_TELEGRAM_THREAD_ID
    : process.env.LEAD_ALERTS_TELEGRAM_THREAD_ID;
  const n = Number(raw ?? '');
  return Number.isFinite(n) && n > 0 ? n : null;
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** `text` cut to at most `max` UTF-16 units of whole code points, ending with «…». */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = '';
  for (const ch of text) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }
  return `${out}…`;
}

/** Length after entity parsing (tags dropped, an entity is one character), in UTF-16 units — never less than Telegram counts. */
function visibleLength(html: string): number {
  return html.replace(/<[^>]*>/g, '').replace(/&(?:amp|lt|gt);/g, '&').length;
}

const VISIT_TIME = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** « (заход 13.10 14:05 МСК)» for an ISO time, '' when it does not parse. */
function earlierVisitSuffix(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '';
  const p: Record<string, string> = {};
  for (const part of VISIT_TIME.formatToParts(time)) p[part.type] = part.value;
  return ` (заход ${p.day}.${p.month} ${p.hour}:${p.minute} МСК)`;
}

interface AlertCuts { url: number; message: number; value: number }
const NO_CUTS: AlertCuts = { url: Infinity, message: Infinity, value: Infinity };

function renderLeadAlert(data: DemoLeadData, cuts: AlertCuts): string {
  const value = (text: string) => esc(clip(text, cuts.value));
  const url = (text: string) => esc(clip(text, Math.min(cuts.url, cuts.value)));
  const lines: string[] = [
    titleLine(data.source),
    '',
    `<b>Имя:</b> ${value(data.name)}`,
    `<b>Почта:</b> ${value(data.email)}`,
  ];
  if (data.company) lines.push(`<b>Компания:</b> ${value(data.company)}`);
  if (data.phone) lines.push(`<b>Телефон:</b> ${value(data.phone)}`);
  if (data.telegram) lines.push(`<b>Telegram:</b> ${value(data.telegram)}`);
  // Fixed labels only, never the caller's string: the line stays short and constant,
  // so the TG_TEXT_MAX cuts in leadAlertText have nothing to cut in it.
  const pageLang = data.pageLang === 'ru' ? 'RU' : data.pageLang === 'en' ? 'EN' : '';
  if (pageLang) lines.push(`<b>🌐 Язык страницы:</b> ${pageLang}`);
  if (data.utm) {
    const u = data.utm;
    const visit = data.utmEarlierVisitAt ? earlierVisitSuffix(data.utmEarlierVisitAt) : '';
    const main = [u.utm_source, u.utm_medium, u.utm_campaign].filter(Boolean).join(' / ');
    if (main) lines.push(`<b>📈 UTM:</b> ${value(main)}${visit}`);
    const extra = [u.utm_term, u.utm_content].filter(Boolean).join(' / ');
    if (extra) lines.push(`<b>UTM доп.:</b> ${value(extra)}${main ? '' : visit}`);
  }
  if (data.outsideReferrer) lines.push(`<b>Пришёл с:</b> ${url(data.outsideReferrer)}`);
  if (data.landingUrl) lines.push(`<b>Страница входа:</b> ${url(data.landingUrl)}`);
  if (data.message) {
    lines.push('');
    lines.push(esc(clip(data.message, Math.min(cuts.message, cuts.value))));
  }
  if (data.referrer) {
    lines.push('');
    lines.push(`<i>${url(data.referrer)}</i>`);
  }
  return lines.join('\n');
}

/**
 * The lead alert as Telegram HTML. A text within TG_TEXT_MAX is returned exactly as
 * built. Over it, Telegram would reject the message and the alert would be lost, so
 * only what is shown gets shorter (callers store the full values), each cut ending
 * with «…»: first the URLs, then the message body by as much as is still over, and
 * if that is not enough, every value.
 */
function leadAlertText(data: DemoLeadData): string {
  const full = renderLeadAlert(data, NO_CUTS);
  if (visibleLength(full) <= TG_TEXT_MAX) return full;
  const urlsCut = renderLeadAlert(data, { ...NO_CUTS, url: ALERT_CUT_MAX });
  const over = visibleLength(urlsCut) - TG_TEXT_MAX;
  if (over <= 0) return urlsCut;
  const message = Math.max(1, (data.message?.length ?? 0) - over);
  const messageCut = renderLeadAlert(data, { ...NO_CUTS, url: ALERT_CUT_MAX, message });
  if (visibleLength(messageCut) <= TG_TEXT_MAX) return messageCut;
  return renderLeadAlert(data, { url: ALERT_CUT_MAX, message: ALERT_CUT_MAX, value: ALERT_CUT_MAX });
}

/**
 * Сигнал «посетитель демо прогнал СВОЙ сайт через персонализацию» — это тёплый
 * лид (человек примерил продукт на свою компанию), даже без контактов.
 * Летит в тот же бот/чат/топик, что и остальные демо-лиды. Never throws.
 */
export async function sendDemoPersonalizeTelegramAlert(data: {
  domain: string;
  resolvedUrl?: string | null;
  ip?: string | null;
}): Promise<void> {
  const token = getToken();
  const chatId = getChatId();
  if (!token || !chatId) return;

  const lines = [
    '🔍 <b>Демо: разбор сайта посетителя</b>',
    '',
    `<b>Сайт:</b> ${esc(data.resolvedUrl || data.domain)}`,
  ];
  if (data.ip) lines.push(`<i>ip: ${esc(data.ip)}</i>`);

  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text: lines.join('\n'),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  const threadId = getThreadId();
  if (threadId) payload.message_thread_id = threadId;

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TG_FETCH_TIMEOUT_MS),
    });
  } catch {
    // best-effort
  }
}

export async function sendDemoLeadTelegramAlert(data: DemoLeadData): Promise<void> {
  const token = getToken();
  const chatId = getChatId();
  if (!token || !chatId) {
    console.warn(
      `[demo-lead-alert] skipped (token=${token ? 'set' : 'missing'}, chat=${chatId ? 'set' : 'missing'}). ` +
        'Set DEMO_LEADS_TELEGRAM_BOT_TOKEN + DEMO_LEADS_TELEGRAM_CHAT_ID ' +
        '(token falls back to LEAD_ALERTS/CHANGELOG).',
    );
    return;
  }

  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text: leadAlertText(data),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  const threadId = getThreadId();
  if (threadId) payload.message_thread_id = threadId;

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TG_FETCH_TIMEOUT_MS),
    });
  } catch {
    // fire-and-forget — lead is already persisted
  }
}
