/**
 * Разбор пользовательского ввода для ручек календаря технички.
 *
 * Проверки собраны в одном месте: иначе очередная ручка забудет одну из них и
 * ответит пятисоткой на `amount: "абв"`. Всё, что здесь бросает
 * `ValidationError`, ручка отдаёт как 400.
 */
import {
  BILLING_CYCLES,
  CURRENCIES,
  SERVICE_TYPES,
  type BillingCycle,
  type Currency,
  type ServiceType,
} from '@/lib/techCalendar/types';

export class ValidationError extends Error {}

type Body = Record<string, unknown>;

function fail(message: string): never {
  throw new ValidationError(message);
}

function parseName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) fail('Название сервиса обязательно');
  return (value as string).trim();
}

function parseType(value: unknown): ServiceType {
  if (!SERVICE_TYPES.includes(value as ServiceType)) fail('Неизвестный тип сервиса');
  return value as ServiceType;
}

function parseCurrency(value: unknown): Currency {
  if (!CURRENCIES.includes(value as Currency)) fail('Валюта может быть только RUB или USD');
  return value as Currency;
}

function parseCycle(value: unknown): BillingCycle {
  if (!BILLING_CYCLES.includes(value as BillingCycle)) fail('Неизвестный цикл оплаты');
  return value as BillingCycle;
}

function parseAmount(value: unknown): number {
  // Number('') === 0 и Number('   ') === 0 — пустая/пробельная строка иначе
  // тихо проезжает как нулевая сумма вместо явной ошибки 400.
  if (typeof value === 'string' && !value.trim()) fail('Сумма должна быть числом');
  const num = typeof value === 'string' ? Number(value) : value;
  if (typeof num !== 'number' || !Number.isFinite(num)) fail('Сумма должна быть числом');
  if ((num as number) < 0) fail('Сумма не может быть отрицательной');
  return Math.round((num as number) * 100) / 100;
}

function parseDate(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('Дата в формате ГГГГ-ММ-ДД');
  const [y, m, d] = (value as string).split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    fail('Такой даты не существует');
  }
  return value as string;
}

function parseNotes(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') fail('Заметка должна быть текстом');
  return (value as string).trim() || null;
}

function parseUpdatedAt(value: unknown): string {
  const isoTimestampWithZone = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
  if (
    typeof value !== 'string'
    || !isoTimestampWithZone.test(value)
    || Number.isNaN(Date.parse(value))
  ) {
    fail('Версия карточки указана неверно');
  }
  return value;
}

/**
 * PATCH/DELETE/решение всегда должны прислать версию карточки,
 * которую видел пользователь. Это не даёт тихо затереть более свежую
 * правку другого администратора.
 */
export function parseExpectedUpdatedAt(body: Body): string {
  if (body.expected_updated_at === undefined) fail('Обновите страницу и повторите');
  return parseUpdatedAt(body.expected_updated_at);
}

export interface CreateInput {
  service_name: string;
  service_type: ServiceType;
  amount: number;
  currency: Currency;
  billing_cycle: BillingCycle;
  next_billing_date: string;
  notes: string | null;
}

export function parseCreateInput(body: Body): CreateInput {
  return {
    service_name: parseName(body.service_name),
    service_type: body.service_type === undefined ? 'other' : parseType(body.service_type),
    amount: body.amount === undefined ? 0 : parseAmount(body.amount),
    currency: body.currency === undefined ? 'RUB' : parseCurrency(body.currency),
    billing_cycle: body.billing_cycle === undefined ? 'monthly' : parseCycle(body.billing_cycle),
    next_billing_date: parseDate(body.next_billing_date),
    notes: parseNotes(body.notes),
  };
}

export type PatchInput = Partial<CreateInput>;

export function parsePatchInput(body: Body): PatchInput {
  const patch: PatchInput = {};
  if (body.service_name !== undefined) patch.service_name = parseName(body.service_name);
  if (body.service_type !== undefined) patch.service_type = parseType(body.service_type);
  if (body.amount !== undefined) patch.amount = parseAmount(body.amount);
  if (body.currency !== undefined) patch.currency = parseCurrency(body.currency);
  if (body.billing_cycle !== undefined) patch.billing_cycle = parseCycle(body.billing_cycle);
  if (body.next_billing_date !== undefined) patch.next_billing_date = parseDate(body.next_billing_date);
  if (body.notes !== undefined) patch.notes = parseNotes(body.notes);
  if (!Object.keys(patch).length) fail('Нечего менять');
  return patch;
}

export interface RenewInput {
  next_billing_date?: string;
  amount?: number;
  expected_updated_at?: string;
}

export function parseRenewInput(body: Body): RenewInput {
  const input: RenewInput = {};
  if (body.next_billing_date !== undefined) input.next_billing_date = parseDate(body.next_billing_date);
  if (body.amount !== undefined) input.amount = parseAmount(body.amount);
  if (body.expected_updated_at !== undefined) {
    input.expected_updated_at = parseUpdatedAt(body.expected_updated_at);
  }
  return input;
}

export interface DecisionInput {
  decision: 'keep' | 'cancel';
  notes: string | null;
}

export function parseDecisionInput(body: Body): DecisionInput {
  if (body.decision !== 'keep' && body.decision !== 'cancel') fail('Решение может быть keep или cancel');
  return { decision: body.decision, notes: parseNotes(body.notes) };
}
