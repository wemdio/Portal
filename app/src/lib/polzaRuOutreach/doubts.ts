/**
 * Признаки сомнения строки (дизайн v3 §2, решение 25.09.2026; с 26.09.2026 —
 * до писем, спека 2026-09-26-outreach-to-sender-design.md §2).
 *
 * Готовые компании уходят в Instantly, где место под контакты ограничено, —
 * поэтому сомнительное помечаем, а очень сомнительное (VERY_DOUBTFUL_FROM
 * признаков и больше) убираем из выгрузки в отдельную вкладку и писем ему не
 * пишем. Признаки считаются сразу после оценки: к этому времени известны все.
 *
 * Исключение — непроверенная почта (unverifiedEmailDoubts): она делает строку
 * очень спорной сразу на шаге почты, до разбора ИИ, — платить за разбор
 * компании, которой письмо может не дойти, незачем.
 *
 * Шаг писем добавляет свой признак поверх признаков оценки (withLettersDoubt):
 * шаблон цепочки оффера не прошёл проверку или письма компании не прошли
 * автопроверку. Такая строка очень спорная сразу, как бы мало ни было прочих
 * признаков, — письма без проверки в рассылку не идут.
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

/**
 * Почта с сайта, которую SMTP-проверка не подтвердила (прокси, greylisting,
 * таймаут): дойдёт ли письмо — неизвестно. Строка сразу очень спорная — без
 * разбора ИИ, оценки и писем; прочие признаки без разбора не посчитать.
 */
export function unverifiedEmailDoubts(email: string): Doubts {
  return { flags: ['EMAIL_UNVERIFIED'], detail: [`почта ${email} не проверена: SMTP-проверка не дала ответа`], veryDoubtful: true };
}

export function computeDoubts(i: DoubtInput): Doubts {
  const flags: DoubtCode[] = [];
  const detail: string[] = [];

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

  return { flags, detail, veryDoubtful: flags.length >= VERY_DOUBTFUL_FROM };
}

/* ── Признаки шага писем ── */

type LettersDoubt = Extract<DoubtCode, 'TEMPLATE_FAILED' | 'LETTERS_QA_FAILED'>;

// Пояснения шага писем начинаются так — и только они: куски computeDoubts
// начинаются иначе («общая почта…», «оценка…», «повод…», «B2B…», «название…»).
// По началу «Переписать цепочку» убирает прежнее пояснение из doubt_detail.
const TEMPLATE_DETAIL_START = 'цепочка оффера ';
const LETTERS_QA_DETAIL_START = 'письма не прошли автопроверку';
// doubt_detail — куски через «; »: точка с запятой внутри пояснения разрезала бы его.
const DETAIL_SEPARATOR = '; ';
const MAX_LETTERS_DETAIL = 500;

export interface DoubtPatch {
  doubt_flags: string[];
  doubt_detail: string | null;
}

/** Шаблон оффера не написан (ИИ не ответил) или не прошёл проверку — почему, коротко. */
export function templateDoubtText(template: { qaFlags: readonly string[]; error: string | null }): string {
  const text = template.error
    ? `${TEMPLATE_DETAIL_START}не написана: ${template.error}`
    : `${TEMPLATE_DETAIL_START}не прошла проверку: ${template.qaFlags.join(', ') || 'без замечаний'}`;
  return text.slice(0, MAX_LETTERS_DETAIL);
}

/** Письма компании не прошли автопроверку (runQa) — её флаги. */
export function lettersQaDoubtText(flags: readonly string[]): string {
  return `${LETTERS_QA_DETAIL_START}: ${flags.join(', ')}`.slice(0, MAX_LETTERS_DETAIL);
}

/** Убрать признаки шага писем: письма строки собираются заново («Переписать цепочку»). */
export function dropLettersDoubts(flags: readonly string[] | null, detail: string | null): DoubtPatch {
  const doubt_flags = (flags ?? []).filter((f) => f !== 'TEMPLATE_FAILED' && f !== 'LETTERS_QA_FAILED');
  const kept = (detail ?? '')
    .split(DETAIL_SEPARATOR)
    .filter((s) => s.trim() && !s.startsWith(TEMPLATE_DETAIL_START) && !s.startsWith(LETTERS_QA_DETAIL_START));
  return { doubt_flags, doubt_detail: kept.join(DETAIL_SEPARATOR) || null };
}

/**
 * Признак шага писем поверх признаков оценки: прежний признак шага писем
 * заменяется, пояснение идёт последним куском doubt_detail.
 */
export function withLettersDoubt(flags: readonly string[] | null, detail: string | null, code: LettersDoubt, text: string): DoubtPatch {
  const kept = dropLettersDoubts(flags, detail);
  return {
    doubt_flags: [...kept.doubt_flags, code],
    doubt_detail: [kept.doubt_detail, text.replace(/;/g, ',')].filter(Boolean).join(DETAIL_SEPARATOR),
  };
}
