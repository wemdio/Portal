/**
 * Каскад продуктов русского автоаутрича — чистая логика без БД и `server-only`.
 *
 * Компании предлагают три продукта по кругу СДР → классика → автоаутрич, начиная
 * с первого по поводу, с паузой между цепочками. Все три предложены, результата
 * нет — больше не пишем. Спека: docs/superpowers/specs/2026-10-28-outreach-three-products-cascade-design.md.
 */

import type { ChainType, Signal } from './types';

/** Шаги круга: по ним считается «что предложено» и «что дальше». */
export const CASCADE_STEPS = ['sdr', 'classic', 'auto'] as const;
export type CascadeStep = (typeof CASCADE_STEPS)[number];

/** Продукты в письмах: на шаге «классика» бывает РФ/СНГ или за рубеж. */
export const PRODUCTS = ['sdr', 'classic', 'classic_abroad', 'auto'] as const;
export type Product = (typeof PRODUCTS)[number];

export const PRODUCT_LABELS: Record<Product, string> = {
  sdr: 'СДР',
  classic: 'Классический аутрич РФ/СНГ',
  classic_abroad: 'Классический аутрич за рубеж',
  auto: 'Автоаутрич',
};

export function isProduct(v: string): v is Product {
  return (PRODUCTS as readonly string[]).includes(v);
}

/** Шаг круга, которому принадлежит продукт: обе «классики» — один шаг. */
export function stepOfProduct(p: Product): CascadeStep {
  return p === 'classic_abroad' ? 'classic' : p;
}

/**
 * Первый продукт компании выбирает повод (подтверждено владельцем 28.10.2026):
 * найм и выставка — вручную выходим на клиентов (СДР); реклама и возврат старого
 * отказа — поток заявок без рекламы (автоаутрич); рост и «только профиль» — классика.
 * Record заставляет добавить шаг при новом типе цепочки.
 */
const FIRST_STEP: Record<ChainType, CascadeStep> = {
  hiring: 'sdr',
  event: 'sdr',
  ad_budget: 'auto',
  reactivation: 'auto',
  automation: 'auto',
  growth_event: 'classic',
  icp_only: 'classic',
};

export function firstStepFor(chain: ChainType): CascadeStep {
  return FIRST_STEP[chain];
}

/**
 * Что считается предложенным в строках до каскада: цепочка `automation` — это
 * автоаутрич, все остальные (и строка без цепочки) — классика.
 */
export function legacyStepOf(chain: ChainType | null): CascadeStep {
  return chain === 'automation' ? 'auto' : 'classic';
}

/**
 * Следующий шаг по кругу после последнего предложенного (массив — по времени),
 * пропуская уже предложенные. Все три предложены — `null`, нового круга нет.
 * Пустой список тоже `null`: у новой компании первый шаг даёт `firstStepFor`.
 */
export function nextStep(offered: CascadeStep[]): CascadeStep | null {
  if (offered.length === 0) return null;
  const last = CASCADE_STEPS.indexOf(offered[offered.length - 1]);
  for (let i = 1; i <= CASCADE_STEPS.length; i += 1) {
    const step = CASCADE_STEPS[(last + i) % CASCADE_STEPS.length];
    if (!offered.includes(step)) return step;
  }
  return null;
}

/**
 * Вернувшаяся компания: какой шаг круга предложить теперь и что уже предлагали
 * (по времени). У новой компании этого нет — первый шаг даёт повод.
 */
export interface CascadeReturn {
  next: CascadeStep;
  offered: CascadeStep[];
}

/** Признаки выхода за рубеж: на шаге «классика» вместо РФ/СНГ идёт «за рубеж». */
export function isAbroad(signals: Signal[]): boolean {
  return signals.some((s) => s.type === 'export_launch');
}

export function productFor(step: CascadeStep, abroad: boolean): Product {
  return step === 'classic' && abroad ? 'classic_abroad' : step;
}

/** Что предлагает строка: шаг круга, продукт и номер шага каскада (1–3). */
export interface CascadeOffer {
  step: CascadeStep;
  product: Product;
  cascadeNo: number;
}

/**
 * Продукт строки. Повод (цепочка) объясняет, почему пишем сейчас, продукт —
 * что предлагаем: вернувшейся компании — следующий шаг круга, новой — первый
 * по поводу. Номер шага — сколько уже предложено плюс этот.
 */
export function cascadeOffer(chain: ChainType, signals: Signal[], returning?: CascadeReturn | null): CascadeOffer {
  const step = returning?.next ?? firstStepFor(chain);
  return { step, product: productFor(step, isAbroad(signals)), cascadeNo: (returning?.offered.length ?? 0) + 1 };
}

export type ReplyOutcome = 'decline' | 'later' | 'other';

// «Не» — только в начале слова (lookbehind): «вне интересно» отказом не считается.
const DECLINE_RE = /(?<![а-яё])(?:не\s*актуальн|не\s*интересн|не\s*интересу|не\s*заинтерес(?:ов|у)|не\s+нужн|не\s+рассматрива)|нет\s+потребност/;
const LATER_RE = /через\s+квартал|через\s+полгода|через\s+\d+\s+месяц|в\s+следующем\s+(?:квартале|году)|после\s+нового\s+года|напишите\s+позже/;

/** Сколько символов ответа читаем: дальше обычно подписи и хвосты. */
const REPLY_HEAD_CHARS = 2000;

/**
 * Что значит ответ, не признанный лидом: отказ закрывает каскад целиком, «через
 * квартал» — пауза 90 дней, остальное («не тот человек», «переслал коллеге») —
 * дальше по каскаду, как молчание. Просьба вернуться позже проверяется первой:
 * «сейчас не актуально, напишите через квартал» — это «позже», а не отказ
 * (решение владельца 28.10.2026).
 *
 * `body` — ответ БЕЗ процитированной переписки: функция структуры письма не видит,
 * а наше четвёртое письмо в цитате может содержать «не актуально». Вызывающий
 * очищает текст сам (`stripQuoted` из senderLeads/telegram.ts); здесь режется
 * только длина.
 */
export function classifyCascadeReply(body: string | null): ReplyOutcome {
  const text = (body ?? '').slice(0, REPLY_HEAD_CHARS).toLowerCase();
  if (LATER_RE.test(text)) return 'later';
  if (DECLINE_RE.test(text)) return 'decline';
  return 'other';
}

/** Факты о компании, из которых решается «писать, ждать или закрыто». */
export interface CascadeFacts {
  /** Предложенные шаги по времени (по всем прошлым запускам компании). */
  offered: CascadeStep[];
  /** Последнее ушедшее письмо по всем запускам; null — писем ещё нет. */
  lastSentAt: Date | null;
  /** Цепочка ещё идёт: есть активный получатель с запланированными письмами. */
  chainRunning: boolean;
  /** Ответ признан лидом. */
  lead: boolean;
  /** Каскад закрыт: отказ, встречное предложение, метка менеджера «не лид». */
  closed: boolean;
  /**
   * Отписка, жалоба, ручной стоп-лист или «не пишите» с любого адреса компании;
   * несуществующий адрес (hard_bounce) закрывает только этот адрес.
   */
  suppressed: boolean;
  /** Когда пришёл ответ «напишите позже»; null — такого нет. */
  laterAt: Date | null;
}

export type CascadeDecision =
  | { kind: 'due'; next: CascadeStep }
  | { kind: 'wait'; until: Date }
  | { kind: 'closed'; reason: 'lead' | 'declined' | 'suppressed' | 'all_offered' };

const DAY_MS = 24 * 60 * 60 * 1000;

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY_MS);
}

/** Битая дата из БД (Invalid Date) не должна давать «пора писать» из-за NaN. */
function isValidDate(d: Date | null): d is Date {
  return d !== null && Number.isFinite(d.getTime());
}

/**
 * Решение по компании: лид, стоп-лист, отказ и «все три предложены» закрывают
 * каскад. Идущая цепочка или отсутствие даты письма — ждём (до окончания цепочки
 * срок неизвестен, потому now + пауза как ориентир). Битая дата письма — как её
 * отсутствие (ждём, лучше не написать, чем написать рано), битая дата ответа
 * «позже» игнорируется. Иначе срок — позднейший из
 * «последнее письмо + пауза» и «ответ „позже“ + 90 дней»: пришёл он до конца
 * паузы или позже, раньше срока не пишем.
 */
export function cascadeDecision(f: CascadeFacts, now: Date, pauseDays = 14, laterDays = 90): CascadeDecision {
  if (f.lead) return { kind: 'closed', reason: 'lead' };
  if (f.suppressed) return { kind: 'closed', reason: 'suppressed' };
  if (f.closed) return { kind: 'closed', reason: 'declined' };
  const next = nextStep(f.offered);
  if (next === null) return { kind: 'closed', reason: 'all_offered' };
  if (f.chainRunning || !isValidDate(f.lastSentAt)) return { kind: 'wait', until: addDays(now, pauseDays) };

  let until = addDays(f.lastSentAt, pauseDays);
  if (isValidDate(f.laterAt)) {
    const laterUntil = addDays(f.laterAt, laterDays);
    if (laterUntil.getTime() > until.getTime()) until = laterUntil;
  }
  return until.getTime() > now.getTime() ? { kind: 'wait', until } : { kind: 'due', next };
}
