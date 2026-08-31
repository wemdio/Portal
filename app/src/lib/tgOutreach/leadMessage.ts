/**
 * Сообщение, которым лид или кандидат в партнёры передаётся человеку.
 *
 * Уходит менеджеру в Telegram и там живёт: по нему он решает, кому звонить.
 * Поэтому шапка отвечает на вопросы «кто и откуда» до того, как менеджер
 * начнёт читать переписку, а сама переписка идёт целиком — без неё непонятно,
 * на что человек согласился.
 *
 * Шапка держится короткой намеренно, лишнего в ней нет:
 *  - времена первого касания и ответа видны прямо в репликах ниже;
 *  - кто нажал кнопку — след для портала (`requested_by`), не для менеджера;
 *  - ссылка на профиль дублировала никнейм: по `@ник` в Telegram открывается
 *    тот же профиль в одно касание;
 *  - аккаунт, которым вели переписку, не пишем — карточка и так уходит именно
 *    с него, менеджер видит отправителя в шапке чата.
 */

export type ForwardKind = 'lead' | 'partner';

export interface LeadMessageInput {
  kind: ForwardKind;
  campaignName: string;
  username: string | null;
  tgUserId: number | null;
  /** Имя базы = оффер, по которому человека брали. */
  baseName?: string | null;
  /** Чат, из которого спарсили контакт, если он сохранился при загрузке базы. */
  sourceChat?: string | null;
  messages: Array<{ role?: string; content?: string; timestamp?: string }>;
  tzOffsetHours?: number;
}

const HEADER: Record<ForwardKind, string> = {
  lead: 'Лид',
  partner: 'Кандидат в партнёры',
};

/** Предел одного сообщения Telegram. */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

/** Метка времени реплики: «12.08 12:40». Битую дату молча опускаем. */
function fmtStamp(value: string | null | undefined, tz: number): string {
  if (!value) return '';
  const t = new Date(value).getTime();
  if (!Number.isFinite(t)) return '';
  const d = new Date(t + tz * 3_600_000);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${dd}.${mm} ${hh}:${mi}`;
}

function nick(username: string | null, tgUserId: number | null): string {
  const clean = (username ?? '').trim().replace(/^@/, '');
  if (clean) return `@${clean}`;
  return tgUserId ? `ID ${tgUserId}` : '—';
}

export function buildLeadMessage(input: LeadMessageInput): string {
  const tz = input.tzOffsetHours ?? 3;

  const lines: string[] = [];
  lines.push(`${HEADER[input.kind]} · ${input.campaignName}`);
  lines.push('');
  lines.push(`Никнейм: ${nick(input.username, input.tgUserId)}`);
  lines.push(`Оффер: ${input.baseName?.trim() || '—'}`);
  // Чат, из которого спарсили контакт. Он известен не у всех баз, а строка
  // «Источник: —» менеджеру ничего не сообщает — тогда её просто нет.
  const source = input.sourceChat?.trim();
  if (source) lines.push(`Источник: ${source}`);
  lines.push('');
  lines.push('── Переписка ──');

  if (input.messages.length === 0) {
    lines.push('(переписка не сохранилась)');
  } else {
    for (const m of input.messages) {
      // Кто написал, называем словами: «assistant» в сообщении менеджеру
      // выглядит внутренней кухней и читается хуже.
      const who = m.role === 'user' ? 'Клиент' : 'Мы';
      const stamp = fmtStamp(m.timestamp, tz);
      const when = stamp ? `[${stamp}] ` : '';
      lines.push(`${when}${who}: ${(m.content ?? '').trim()}`);
    }
  }

  return lines.join('\n');
}

/**
 * Разбить длинное сообщение по границе строк.
 *
 * Переписку отдаём целиком, а она может перерасти предел Telegram — тогда
 * сообщение уходит частями. Режем по строкам, чтобы реплика не рвалась
 * посередине; строку длиннее предела (кто-то прислал простыню без переносов)
 * режем жёстко — иначе она не уйдёт вовсе.
 */
export function splitTelegramMessage(text: string, limit = TELEGRAM_MESSAGE_LIMIT): string[] {
  if (text.length <= limit) return [text];

  const parts: string[] = [];
  let current = '';

  const push = () => {
    if (current) parts.push(current);
    current = '';
  };

  for (const line of text.split('\n')) {
    if (line.length > limit) {
      push();
      for (let i = 0; i < line.length; i += limit) parts.push(line.slice(i, i + limit));
      continue;
    }
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit) {
      push();
      current = line;
    } else {
      current = candidate;
    }
  }
  push();

  return parts;
}
