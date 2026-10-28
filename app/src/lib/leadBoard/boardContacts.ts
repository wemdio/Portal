/** Presentation only: phone and JSON-backed contacts retain separate storage. */
export type BoardContactKey = 'phone' | 'telegram' | 'whatsapp' | 'address';
export type BoardContactValues = { phone: string | null; custom?: Record<string, unknown> | null };
export type BoardContactDraft = Record<BoardContactKey, string>;
export type BoardContactPatch = { phone?: string | null; custom?: Record<string, string | null> };

export const BOARD_CONTACT_FIELDS: readonly { key: BoardContactKey; label: string; limit: number }[] = [
  { key: 'phone', label: 'Телефоны', limit: 200 },
  { key: 'telegram', label: 'Telegram', limit: 500 },
  { key: 'whatsapp', label: 'WhatsApp', limit: 500 },
  { key: 'address', label: 'Адрес', limit: 500 },
];

export function boardContactDraft(value: BoardContactValues): BoardContactDraft {
  const text = (v: unknown) => typeof v === 'string' ? v : '';
  return { phone: text(value.phone), telegram: text(value.custom?.telegram),
    whatsapp: text(value.custom?.whatsapp), address: text(value.custom?.address) };
}

/** Send only touched fields, not a stale copy of the other contacts/custom keys. */
export function boardContactChanges(before: BoardContactDraft, after: BoardContactDraft): BoardContactPatch {
  const patch: BoardContactPatch = {};
  for (const { key } of BOARD_CONTACT_FIELDS) {
    const value = after[key].trim();
    if (value === before[key].trim()) continue;
    if (key === 'phone') patch.phone = value || null;
    else (patch.custom ??= {})[key] = value || null;
  }
  return patch;
}

const COPY_LABELS: Record<BoardContactKey, string> = { phone: 'Тел.', telegram: 'Telegram', whatsapp: 'WhatsApp', address: 'Адрес' };
// Clipboard consumers may discard control characters before interpreting a cell.
// Normalize them before checking phone-only labels/formula-like prefixes.
const flat = (value: string) => value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
const escapeValue = (value: string) => flat(value).replace(/\\/gu, '\\\\').replace(/\|/gu, '\\|');

/** All four values occupy ONE cell in a copied row/table; email stays separate. */
export function formatBoardContactText(value: BoardContactValues): string {
  const draft = boardContactDraft(value);
  draft.phone = flat(draft.phone.replace(/\r?\n/gu, '; '));
  const fields = BOARD_CONTACT_FIELDS.filter(({ key }) => flat(draft[key]));
  if (fields.length === 1 && fields[0].key === 'phone' &&
    !/^(?:Тел\.|Телефоны?|Telegram|WhatsApp|Адрес):/iu.test(draft.phone.trim()) &&
    (!/^[=+@-]/u.test(draft.phone.trim()) || /^\+?\d[\d ();,.-]*$/u.test(draft.phone.trim()))) return draft.phone;
  return fields.map(({ key }) => `${COPY_LABELS[key]}: ${escapeValue(draft[key])}`).join(' | ');
}

/** Only the new Contacts header calls this. Unknown prose remains a legacy phone value. */
export function parseBoardContactText(raw: string): { phone: string | null; custom?: Record<string, string> } {
  const text = raw.trim();
  const legacy = () => ({ phone: text || null });
  if (!/^(?:Тел\.|Телефоны?|Telegram|WhatsApp|Адрес):/iu.test(text)) return legacy();
  const parts: string[] = [];
  let part = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && /[\\|]/u.test(text[i + 1] ?? '')) { part += text[++i]; continue; }
    if (text[i] === '|' && /\s/u.test(text[i - 1] ?? '') && /\s/u.test(text[i + 1] ?? '')) {
      parts.push(part.trim()); part = ''; continue;
    }
    part += text[i];
  }
  parts.push(part.trim());
  const fields: Partial<BoardContactDraft> = {};
  for (const item of parts) {
    const match = /^(Тел\.|Телефоны?|Telegram|WhatsApp|Адрес):\s*(.*)$/iu.exec(item);
    if (!match) return legacy();
    const key: BoardContactKey = /^тел/iu.test(match[1]) ? 'phone' : /^адрес$/iu.test(match[1]) ? 'address' : match[1].toLowerCase() as 'telegram' | 'whatsapp';
    if (Object.prototype.hasOwnProperty.call(fields, key)) return legacy();
    fields[key] = match[2].trim();
  }
  const custom = Object.fromEntries(Object.entries(fields).filter(([key]) => key !== 'phone'));
  return { phone: fields.phone || null, ...(Object.keys(custom).length ? { custom } : {}) };
}

/** Clickable contact targets are allowlisted; arbitrary manual text stays plain. */
export function boardContactHref(key: BoardContactKey, value: string): string | null {
  const text = value.trim();
  if (key === 'address' || !text || /[<>\u0000-\u001f\\]/u.test(text)) return null;
  if (key === 'phone') {
    return /^\+?[\d ().-]+$/u.test(text) && /^\d{7,15}$/u.test(text.replace(/\D/gu, ''))
      ? `tel:${text.replace(/[ ().-]/gu, '')}` : null;
  }
  const telegramAction = /^(?:share|joinchat|addlist|proxy|socks|login|iv|boost|giftcode|addstickers|addemoji|setlanguage)$/iu;
  if (key === 'telegram' && /^@[a-z][a-z\d_]{4,31}$/iu.test(text)) return telegramAction.test(text.slice(1)) ? null : `https://t.me/${text.slice(1)}`;
  if (key === 'whatsapp' && /^\+[\d ().-]+$/u.test(text) && /^[1-9]\d{9,14}$/u.test(text.replace(/\D/gu, ''))) return `https://wa.me/${text.replace(/\D/gu, '')}`;
  if (/\s/u.test(text)) return null;
  try {
    const url = new URL(/^https?:\/\//iu.test(text) ? text : `https://${text}`);
    if (!/^https?:$/u.test(url.protocol) || url.username || url.password || url.port || url.search || url.hash) return null;
    if (key === 'telegram' && /^(?:t\.me|telegram\.me)$/iu.test(url.hostname) &&
      /^\/[a-z][a-z\d_]{4,31}\/?$/iu.test(url.pathname) &&
      !telegramAction.test(url.pathname.replace(/^\/|\/$/gu, ''))) {
      return `https://t.me${url.pathname}`;
    }
    if (key === 'whatsapp' && url.hostname === 'wa.me' && /^\/(?:[1-9]\d{9,14}|message\/[a-z\d]{6,64})\/?$/iu.test(url.pathname)) return `https://wa.me${url.pathname}`;
  } catch { /* Not a safe contact link; retain readable/editable text. */ }
  return null;
}

export function boardContactDisplay(key: BoardContactKey, value: string): string {
  const href = boardContactHref(key, value);
  if (key === 'telegram' && href) return `@${new URL(href).pathname.slice(1).replace(/\/$/u, '')}`;
  if (key === 'whatsapp' && href && /^\/\d+$/u.test(new URL(href).pathname)) return `+${new URL(href).pathname.slice(1)}`;
  return value.trim();
}
