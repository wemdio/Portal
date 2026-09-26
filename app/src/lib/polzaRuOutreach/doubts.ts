/**
 * Признаки сомнения строки, прошедшей порог (дизайн v3 §2, решение 25.09.2026;
 * с 26.09.2026 — до писем, спека 2026-09-26-outreach-to-sender-design.md §2).
 *
 * Готовые компании уходят в Instantly, где место под контакты ограничено, —
 * поэтому сомнительное помечаем, а очень сомнительное (VERY_DOUBTFUL_FROM
 * признаков и больше или непроверенная почта) убираем из выгрузки в отдельную
 * вкладку. Считаем сразу после оценки: все признаки к этому времени известны,
 * и очень спорной строке письма не пишем вовсе.
 */

import { companyKey } from './company';
import { VERY_DOUBTFUL_FROM, type ChainType, type DoubtCode, type Signal } from './types';

const DAY = 86_400_000;
const WEAK_AGE_DAYS = 30;
const NEAR_THRESHOLD_GAP = 10;

/** Локальная часть общего ящика: info@, sales@, office@, zakaz@ … */
const GENERIC_LOCAL =
  /^(info|sales|office|hello|mail|zakaz|order|orders|contact|contacts|support|admin|reception|secretary|priem|post|pr|marketing|market|welcome|client|clients|service|manager|opt|shop|team|general)([._-]?\d*)?$/i;

export interface DoubtInput {
  email: string;
  emailType: 'department' | 'generic' | 'person' | null;
  /**
   * SMTP-проверка адреса не дала ответа (прокси, greylisting, таймаут): адрес
   * с сайта, но дойдёт ли письмо — неизвестно.
   */
  emailUnverified: boolean;
  score: number;
  writeThreshold: number;
  chain: ChainType;
  primary: Signal | null;
  /** B2B подтверждён дословной цитатой с сайта или из вакансии. */
  b2bQuoted: boolean;
  /** Название из источника и бренд со страницы. */
  sourceName: string;
  brand: string;
  /** В источнике было только доменное имя (Директ) — сравнивать нечего. */
  sourceIsDomainOnly: boolean;
}

export interface Doubts {
  flags: DoubtCode[];
  detail: string[];
  veryDoubtful: boolean;
}

function namesLookAlike(a: string, b: string): boolean {
  const x = companyKey(a);
  const y = companyKey(b);
  if (!x || !y) return true;
  if (x.includes(y) || y.includes(x)) return true;
  // Общий кусок от 4 символов — «СтройМаш» и «Строймаш-Урал» похожи.
  for (let i = 0; i + 4 <= y.length; i += 1) if (x.includes(y.slice(i, i + 4))) return true;
  return false;
}

export function computeDoubts(i: DoubtInput): Doubts {
  const flags: DoubtCode[] = [];
  const detail: string[] = [];

  // Первым — решающий признак: в пояснении строки он виден сразу.
  if (i.emailUnverified) {
    flags.push('EMAIL_UNVERIFIED');
    detail.push(`почта ${i.email} не проверена: SMTP-проверка не дала ответа`);
  }

  const local = i.email.split('@')[0] ?? '';
  if (i.emailType === 'generic' || GENERIC_LOCAL.test(local)) {
    flags.push('GENERIC_MAILBOX');
    detail.push(`общая почта ${i.email}`);
  }

  if (i.score < i.writeThreshold + NEAR_THRESHOLD_GAP) {
    flags.push('NEAR_THRESHOLD');
    detail.push(`оценка ${i.score} при пороге ${i.writeThreshold}`);
  }

  if (i.chain !== 'reactivation') {
    const weak: string[] = [];
    const t = i.primary?.date ? new Date(i.primary.date).getTime() : NaN;
    if (i.chain === 'icp_only') weak.push('повода нет, только профиль');
    else if (!Number.isFinite(t)) weak.push('повод без даты');
    else {
      const age = (Date.now() - t) / DAY;
      const futureEvent = i.chain === 'event' && age < 0;
      if (!futureEvent && age > WEAK_AGE_DAYS) weak.push(`повод ${Math.round(age)} дн. назад`);
    }
    if (weak.length) {
      flags.push('WEAK_SIGNAL');
      detail.push(...weak);
    }
  }

  const company: string[] = [];
  if (!i.b2bQuoted) company.push('B2B подтверждён косвенно');
  if (!i.sourceIsDomainOnly && !namesLookAlike(i.sourceName, i.brand)) {
    company.push(`название на сайте «${i.brand}» не похоже на «${i.sourceName}»`);
  }
  if (company.length) {
    flags.push('COMPANY_DOUBT');
    detail.push(...company);
  }

  // Непроверенная почта — очень спорная сама по себе: остальные признаки
  // говорят о качестве повода, а этот — о том, дойдёт ли письмо вообще.
  return { flags, detail, veryDoubtful: flags.includes('EMAIL_UNVERIFIED') || flags.length >= VERY_DOUBTFUL_FROM };
}
