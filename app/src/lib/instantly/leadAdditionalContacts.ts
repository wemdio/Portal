import { normalizeLeadPhone } from './leadContactValues';

/** Explicit contact fields only. Never infer messenger availability from a phone. */
export interface AdditionalLeadContacts {
  telegram?: string;
  whatsapp?: string;
  address?: string;
}

function contactText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text && text.length <= 1000 && !/[<>\u0000-\u001f]/u.test(text) &&
    !/^(?:null|none|unknown|undefined|not available|n\/?a|нет(?: данных)?|не указан[ао]?)$/iu.test(text) ? text : null;
}

function contactUrl(value: string): URL | null {
  if (/\s|\\/u.test(value)) return null;
  try {
    const url = new URL(/^https?:\/\//iu.test(value) ? value : `https://${value}`);
    return /^(?:http|https):$/u.test(url.protocol) && !url.username && !url.password && !url.port
      ? url : null;
  } catch { return null; }
}

export function normalizeLeadTelegram(value: unknown): string | null {
  const text = contactText(value);
  if (!text) return null;
  const username = (name: string) => /^[a-z][a-z\d_]{4,31}$/iu.test(name) &&
    !/^(?:share|joinchat|addlist|proxy|socks|login|iv|boost|giftcode|addstickers|addemoji|setlanguage)$/iu.test(name)
    ? `https://t.me/${name}` : null;
  if (/^@?[a-z][a-z\d_]{4,31}$/iu.test(text)) return username(text.replace(/^@/u, ''));
  const url = contactUrl(text);
  if (!url || !/^(?:t\.me|telegram\.me)$/iu.test(url.hostname) || url.search || url.hash) return null;
  // A post, invite, bot action or shared article is not a contact username.
  const match = /^\/([a-z][a-z\d_]{4,31})\/?$/iu.exec(url.pathname);
  return match ? username(match[1]) : null;
}

function whatsappNumber(value: string, explicitInternational = false): string | null {
  const phone = normalizeLeadPhone(value);
  if (!phone || phone.includes(';') || /доб\./u.test(phone)) return null;
  let digits = phone.replace(/\D/gu, '');
  if (!explicitInternational && /^8\d{10}$/u.test(digits)) digits = `7${digits.slice(1)}`;
  if (!/^[1-9]\d{9,14}$/u.test(digits)) return null;
  // Local numbers have no provable country code; don't manufacture a link.
  if (!explicitInternational && !/^\+/u.test(value.trim()) && !/^[78]\d{10}$/u.test(digits)) return null;
  return `https://wa.me/${digits}`;
}

export function normalizeLeadWhatsapp(value: unknown): string | null {
  const text = contactText(typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value);
  if (!text) return null;
  const number = whatsappNumber(text);
  if (number) return number;
  const url = contactUrl(text);
  if (!url || url.hash) return null;
  if (url.hostname.toLowerCase() === 'wa.me') {
    const phone = /^\/(\d{10,15})\/?$/u.exec(url.pathname);
    if (phone) return whatsappNumber(phone[1], true);
    // WhatsApp Business short links identify a contact, unlike group invites.
    if (/^\/message\/[a-z\d]{6,64}\/?$/iu.test(url.pathname)) return `https://wa.me${url.pathname.replace(/\/$/u, '')}`;
  }
  if (/^(?:api|web)\.whatsapp\.com$/iu.test(url.hostname) && /^\/send\/?$/u.test(url.pathname)) {
    return whatsappNumber(url.searchParams.get('phone') ?? '', true);
  }
  return null;
}

export function normalizeLeadAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/gu, ' ').trim();
  if (text.length < 6 || text.length > 500 || !/\p{L}/u.test(text) ||
    /[<>@]|https?:|www\.|[\u0000-\u001f]/iu.test(text) ||
    /^(?:не указан[ао]?|нет(?: данных)?|unknown|undefined|not available|null|none|n\/?a)$/iu.test(text)) return null;
  return text;
}
