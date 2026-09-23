/**
 * Автоматический QA цепочки перед выгрузкой (правила RU §13, INSTRUCTION_02 §5,
 * INSTRUCTION_03 §6, дизайн §6).
 *
 * QA не переписывает письмо. Провал → строка manual_review с флагами. Допустима
 * только пересборка из другого утверждённого варианта, если это следует из
 * данных (evidence → generic), — это делает раннер, не QA.
 *
 * Цифры: любая цифра в письме должна прийти из разрешённого источника —
 * подписи, утверждённого кейса или claim, дословной цитаты, названия
 * компании/вакансии/выставки/контракта или фиксированных слов шаблона
 * («15 минут», «2–3 сегмента»). Остаток с цифрой = неподтверждённое число.
 */

import { formatSignature, type SenderProfile } from './libraries';
import type { Letter, QaResult } from './types';
import { LETTER_COUNT } from './types';

export interface QaInput {
  letters: Letter[];
  /** Статус компании в AMO: открытая сделка и клиент блокируют выгрузку. */
  amoStatus: string | null;
  sender: SenderProfile;
  priorContact: boolean;
  caseText: string | null;
  claimTexts: string[];
  /** Дословные цитаты и структурные поля, которые письмо может повторять. */
  allowedFacts: string[];
  /** Рынок, названный моделью: упоминается только при сверенной цитате рынка. */
  targetMarket: string | null;
  marketQuote: string | null;
  recipientEmail: string | null;
}

const TEMPLATE_NUMBERS = ['15 минут', '2–3', '2-3', 'B2B', 'b2b'];

const FORBIDDEN: Array<[RegExp, string]> = [
  [/срочн/i, 'forbidden:urgency'],
  [/уникальн/i, 'forbidden:unique'],
  [/гарантир/i, 'forbidden:guarantee'],
  [/последний шанс|предложение сгорает|осталось\s+\S+\s+мест/i, 'forbidden:scarcity'],
  [/мы лучшие|революцион/i, 'forbidden:superlative'],
  [/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u, 'forbidden:emoji'],
  [/\bjson\b|```|\bundefined\b|\bnull\b|confidence|\bTODO\b/i, 'internal_text'],
  // Внутренняя кухня конвейера не должна утекать в письмо (RU_OUTREACH_HANDOFF §3.6).
  [/\b(score|scoring|pipeline|validation|pre-scoring|rerank|icp|llm|evidence|lead_score)\b|скоринг|ца-балл/i, 'internal_words'],
];

const CANDIDATE_LIKE_SUBJECT = /резюме|отклик|кандидат|соискател|ваканси[ияю]\s+[«"]?[^»"]{40,}/i;

function stripAll(text: string, pieces: string[]): string {
  let out = text;
  // Длинные куски первыми: название компании внутри фразы-сигнала не должно
  // разрушить совпадение самой фразы.
  for (const piece of [...pieces].sort((a, b) => b.length - a.length)) {
    if (piece && piece.trim()) out = out.split(piece).join(' ');
  }
  return out;
}

export function runQa(input: QaInput): QaResult {
  const flags: string[] = [];
  if (input.letters.length !== LETTER_COUNT) flags.push(`letter_count:${input.letters.length}/${LETTER_COUNT}`);
  if (input.amoStatus === 'open_deal' || input.amoStatus === 'client') flags.push(`amo_blocked:${input.amoStatus}`);
  if (!input.recipientEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.recipientEmail)) flags.push('email_invalid');

  const signature = `С уважением,\n${formatSignature(input.sender)}`;
  const first = input.letters[0];
  if (!first?.subject?.trim()) flags.push('subject_missing');
  else {
    if (CANDIDATE_LIKE_SUBJECT.test(first.subject)) flags.push('subject_candidate_like');
    if (/[A-ZА-ЯЁ]{6,}/.test(first.subject.replace(/«[^»]*»/g, ''))) flags.push('subject_caps');
    if (/[!]/.test(first.subject)) flags.push('subject_exclamation');
  }

  const bodyWords: number[] = [];
  for (const letter of input.letters) {
    const tag = `L${letter.n}`;
    const body = letter.body ?? '';
    if (!body.endsWith(signature)) flags.push(`${tag}:signature_mismatch`);
    const text = body.endsWith(signature) ? body.slice(0, -signature.length) : body;
    bodyWords.push(text.trim().split(/\s+/).filter(Boolean).length);

    if (/\{\{|\}\}/.test(body)) flags.push(`${tag}:placeholder_left`);
    const questions = (text.match(/\?/g) ?? []).length;
    if (questions > 1) flags.push(`${tag}:more_than_one_cta`);
    const exclamations = text.replace(/^Добрый день!/, '').match(/!/g) ?? [];
    if (exclamations.length) flags.push(`${tag}:exclamation`);
    for (const [re, flag] of FORBIDDEN) if (re.test(text)) flags.push(`${tag}:${flag}`);
    if (/уже общались/i.test(text) && !input.priorContact) flags.push(`${tag}:false_prior_contact`);
    if (input.targetMarket && !input.marketQuote && text.toLowerCase().includes(input.targetMarket.toLowerCase())) {
      flags.push(`${tag}:market_without_evidence`);
    }

    const rest = stripAll(text, [
      ...(input.caseText ? [input.caseText] : []),
      ...input.claimTexts,
      ...input.allowedFacts,
      ...TEMPLATE_NUMBERS,
    ]);
    if (/\d/.test(rest)) flags.push(`${tag}:unsupported_number`);
  }

  if (input.caseText && !input.letters.some((l) => l.body.includes(input.caseText as string))) {
    flags.push('case_text_mismatch');
  }

  if (bodyWords.length === 4) {
    if (!(bodyWords[3] < bodyWords[1] && bodyWords[3] < bodyWords[2])) flags.push('L4:not_shortest');
  }

  return { status: flags.length ? 'failed' : 'passed', flags };
}
