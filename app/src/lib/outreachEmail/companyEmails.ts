/**
 * Адреса компании автоаутрича (RU и EN): до трёх проверенных почт в колонке
 * emails строки (docs/superpowers/specs/2026-09-29-outreach-multi-email-design.md).
 *
 * Модуль без серверных зависимостей: список читают и раннеры, и заливка в
 * «Рассылку», и экран с выгрузками.
 *
 * Главный адрес — первый элемент; он же лежит в прежних колонках строки (EN
 * selected_company_email, RU recipient_email). Старые строки (emails = [])
 * читаются как «только главный адрес».
 */

/** Вердикт адреса: проверка SMTP или контакт из AMO (RU «Возврат», не проверяется). */
export type CompanyEmailVerification = 'ok' | 'catch_all' | 'unverified' | 'crm_contact';

/** Элемент колонки emails — как лежит в базе. */
export interface CompanyEmail {
  email: string;
  verification: CompanyEmailVerification;
  /** Как email_type строки (EN generic_company / department_company / person_company, RU department / generic / person). */
  type: string | null;
  /** Письмо 1 этому адресу — вариант «перешлите тому, кто отвечает». */
  is_routing: boolean;
}

/** Сколько адресов компании берём в работу. */
export const MAX_COMPANY_EMAILS = 3;

const VERIFICATIONS = new Set<CompanyEmailVerification>(['ok', 'catch_all', 'unverified', 'crm_contact']);

function asVerification(value: unknown): CompanyEmailVerification | null {
  return typeof value === 'string' && VERIFICATIONS.has(value as CompanyEmailVerification)
    ? (value as CompanyEmailVerification)
    : null;
}

/**
 * Адреса строки. main — главный адрес из прежних колонок: он всегда первый,
 * даже если список пуст (старые строки) или разошёлся с колонками после
 * ручной правки. Повторы адреса (без учёта регистра) убираются.
 */
export function readCompanyEmails(raw: unknown, main: CompanyEmail | null): CompanyEmail[] {
  const out: CompanyEmail[] = [];
  const seen = new Set<string>();
  const push = (item: CompanyEmail) => {
    const key = item.email.trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ ...item, email: item.email.trim() });
  };
  if (main?.email) push(main);
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const row = item as Record<string, unknown>;
      const email = typeof row.email === 'string' ? row.email : '';
      const verification = asVerification(row.verification);
      if (!email || !verification) continue;
      push({
        email,
        verification,
        type: typeof row.type === 'string' ? row.type : null,
        is_routing: row.is_routing === true,
      });
    }
  }
  return out.slice(0, MAX_COMPANY_EMAILS);
}

/**
 * Нужен ли второй вариант письма 1: среди адресов есть оба вида (лично и общий
 * ящик). Возвращает вид, которого нет у главного адреса (true — «перешлите
 * ответственному»), или null — второй вариант не нужен.
 */
export function altRoutingFor(emails: CompanyEmail[]): boolean | null {
  return altVariantFor(emails)?.isRouting ?? null;
}

/** То же, что altRoutingFor, вместе с первым адресом этого вида — для проверки писем. */
export function altVariantFor(emails: CompanyEmail[]): { isRouting: boolean; recipientEmail: string } | null {
  const main = emails[0];
  if (!main) return null;
  const other = emails.find((item) => item.is_routing !== main.is_routing);
  return other ? { isRouting: other.is_routing, recipientEmail: other.email } : null;
}

/**
 * Адреса компании, кроме главного (Почта 2, Почта 3), — для экрана и выгрузки.
 * main — главный адрес из прежних колонок строки.
 */
export function extraCompanyEmails(raw: unknown, main: string | null | undefined): CompanyEmail[] {
  const mainKey = (main ?? '').trim().toLowerCase();
  const list = readCompanyEmails(raw, null);
  // Главный — первый в списке. Главным считаем колонку строки: без неё —
  // первый элемент списка.
  const rest = mainKey ? list.filter((item) => item.email.toLowerCase() !== mainKey) : list.slice(1);
  return rest.slice(0, MAX_COMPANY_EMAILS - 1);
}

/** Статус адреса для экрана и выгрузки. */
export function companyEmailStatusLabel(verification: string | null | undefined): string {
  switch (verification) {
    case 'ok':
      return 'проверена';
    case 'catch_all':
      return 'catch-all';
    case 'unverified':
      return 'не проверена';
    case 'crm_contact':
      return 'контакт AMO';
    default:
      return '';
  }
}

/** «a@x.ru (проверена)» — адрес со статусом для ячейки выгрузки. */
export function companyEmailCell(item: CompanyEmail | undefined): string {
  if (!item) return '';
  const status = companyEmailStatusLabel(item.verification);
  return status ? `${item.email} (${status})` : item.email;
}

/**
 * Второй вариант письма 1 в letters строки: поля у письма n = 1. Писем 2–4 и
 * темы он не меняет — цепочка у компании одна, различается только текст
 * письма 1 (лично / «перешлите ответственному»).
 */
export interface Letter1Alt {
  /** Текст письма 1 для адресов другого вида. */
  alt_body?: string;
  /** Вид этого варианта: true — «перешлите ответственному». */
  alt_routing?: boolean;
}

/** Текст письма 1 для адреса: свой вариант, если он есть, иначе основной. */
export function letter1BodyFor(
  letter1: { body: string } & Letter1Alt,
  isRouting: boolean,
): string {
  if (letter1.alt_body && letter1.alt_routing === isRouting) return letter1.alt_body;
  return letter1.body;
}
