import type { LeadCreatePayload } from '@/lib/instantly/types';
import { normalizeRecipients, type RecipientInput } from '@/lib/sender/recipientImport';
import { applyVars, recipientVars } from '@/lib/sender/template';
import { PLACEHOLDER_RE, placeholderKeys, varKey } from '@/lib/sender/templateVars';
import { normalizeVeExclusionDomain } from '../projectExclusions';

/**
 * Контакты VE2 и письма кампании «Рассылки»: как контакт становится строкой
 * базы и когда шаблон сломан. Общие правила для подачи контактов
 * (senderAppend) и наблюдения за кампанией (senderDelivery): сломанный шаблон
 * должен останавливать одну кампанию, а не съедать дневную квоту соседних.
 * Без базы данных и без campaignOps.
 */

/** С какой выборки пустые письма у большинства — поломка шаблона, а не данных. */
export const MASS_EMPTY_MIN_ROWS = 20;

const STANDARD_FIELDS = ['first_name', 'last_name', 'company_name', 'website', 'phone'] as const;

export interface SenderLetterVariant { subject: string; body: string }

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
}

function firstSorted(values: unknown): string | null {
  return Array.isArray(values) ? values.map(text).filter(Boolean).sort()[0] ?? null : null;
}

/**
 * Ключ компании: её адресам планировщик пишет с одного ящика и с разницей в
 * сутки. ИНН, иначе домен сайта, иначе корпоративный домен адреса; у
 * бесплатной почты компании не видно — ключа нет.
 */
function veGroupKey(lead: LeadCreatePayload, identity: unknown): string | null {
  const id = identity && typeof identity === 'object' ? identity as { inns?: unknown; domains?: unknown } : {};
  const inn = firstSorted(id.inns);
  if (inn) return `ve2:inn:${inn}`;
  const domain = normalizeVeExclusionDomain(text(lead.website))
    ?? firstSorted(id.domains)
    ?? normalizeVeExclusionDomain(text(lead.email).split('@')[1] ?? '');
  return domain ? `ve2:d:${domain}` : null;
}

/**
 * Контакт VE2 → строка базы «Рассылки». Переменные письма — custom_variables
 * (их пишет превью и шаблон, в том числе пустые), штатные поля — только если
 * переменной с тем же ключом нет: иначе company_name из колонки перебил бы
 * значение оператора {{companyName}}, как не бывает у Instantly.
 *
 * «Рассылка» различает переменные только по varKey, Instantly — по написанию:
 * companyName (оператор) и company_name (сырая колонка) у неё одна
 * переменная. Из таких берём написанную в шагах кампании (spellings), иначе
 * — оператора (написание не совпадает с ключом), а не порядок ключей jsonb.
 */
export function veLeadToRecipient(
  lead: LeadCreatePayload,
  identity: unknown,
  spellings: ReadonlySet<string> = new Set(),
): RecipientInput {
  const chosen = new Map<string, string>();
  const rank = (name: string) => (spellings.has(name) ? 2 : 0) + (name !== varKey(name) ? 1 : 0);
  for (const [key, value] of Object.entries(lead.custom_variables ?? {})) {
    if (value == null || typeof value === 'object') continue;
    const current = chosen.get(varKey(key));
    if (current === undefined || rank(key) > rank(current)) chosen.set(varKey(key), key);
  }
  const vars: Record<string, string> = {};
  for (const key of chosen.values()) vars[key] = String((lead.custom_variables as Record<string, unknown>)[key]);
  const taken = new Set(Object.keys(vars).map(varKey));
  for (const field of STANDARD_FIELDS) {
    const value = text(lead[field]);
    if (value && !taken.has(field)) vars[field] = value;
  }
  const name = [text(lead.first_name), text(lead.last_name)].filter(Boolean).join(' ') || null;
  return { email: lead.email, name, vars, groupKey: veGroupKey(lead, identity) };
}

/** Строки sender_campaign_steps → варианты первого письма и написания переменных всех шагов. */
export function parseSenderSteps(
  steps: ReadonlyArray<{ step_no: unknown; subject: unknown; body: unknown }>,
): { variants: SenderLetterVariant[]; spellings: Set<string> } {
  const variants = steps.filter((step) => Number(step.step_no) === 1)
    .map((step) => ({ subject: String(step.subject ?? ''), body: String(step.body ?? '') }));
  const spellings = new Set(steps.flatMap((step) => [...`${String(step.subject ?? '')}\n${String(step.body ?? '')}`
    .matchAll(PLACEHOLDER_RE)].map((match) => match[1].trim())));
  return { variants, spellings };
}

/** Какие переменные письма у контакта вообще есть — пусть и пустые. */
function providedKeys(row: RecipientInput): string[] {
  const keys = Object.keys(row.vars).map(varKey);
  keys.push('email');
  if (row.name) keys.push('name', 'first_name');
  return keys;
}

/**
 * Каким строкам этим шаблоном не написать: invalid — адрес некорректный,
 * empty — первое письмо пустое хотя бы в одном варианте (какой вариант
 * достанется получателю, станет известно после вставки, а пустой вариант
 * планировщик закрывает без письма).
 */
export function senderLetterProblems(
  variants: readonly SenderLetterVariant[],
  rows: readonly RecipientInput[],
): { invalid: number[]; empty: number[]; parsed: number } {
  const invalid: number[] = [];
  const empty: number[] = [];
  rows.forEach((row, index) => {
    const parsed = normalizeRecipients([row]).recipients[0];
    if (!parsed) { invalid.push(index); return; }
    const vars = recipientVars(parsed);
    if (!variants.every((variant) => applyVars(variant.subject, vars).trim() && applyVars(variant.body, vars).trim())) empty.push(index);
  });
  return { invalid, empty, parsed: rows.length - invalid.length };
}

/**
 * Шаблон сломан для этих контактов — текст причины, иначе null. Это не
 * плохие контакты, а правка шагов кампании: вариант без темы или текста
 * (недописанный черновик), переменная, которой нет ни у одного контакта,
 * письмо, пустое у большинства большой выборки. Маленькую выборку по пустым
 * письмам не судим: так одна пачка в начале очереди держала бы кампанию.
 */
export function senderTemplateFault(
  variants: readonly SenderLetterVariant[],
  rows: readonly RecipientInput[],
): string | null {
  if (!variants.length) return 'у кампании «Рассылки» нет первого письма';
  if (variants.some((variant) => !variant.subject.trim() || !variant.body.trim())) {
    return 'у первого письма кампании «Рассылки» есть вариант без темы или текста';
  }
  if (!rows.length) return null;
  const provided = new Set(rows.flatMap(providedKeys));
  const missing = [...new Set(variants.flatMap((variant) => placeholderKeys(`${variant.subject}\n${variant.body}`)))]
    .filter((key) => !provided.has(key));
  if (missing.length) {
    return `в первом письме кампании «Рассылки» есть переменные, которых нет у контактов: ${missing.map((key) => `{{${key}}}`).join(', ')}`;
  }
  const { empty, parsed } = senderLetterProblems(variants, rows);
  if (parsed >= MASS_EMPTY_MIN_ROWS && empty.length * 2 > parsed) {
    return `первое письмо кампании «Рассылки» выходит пустым у ${empty.length} из ${parsed} контактов — проверьте переменные в шагах`;
  }
  return null;
}
