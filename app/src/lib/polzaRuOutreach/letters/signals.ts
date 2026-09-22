/**
 * Цепочка оффера «По сигналам» — четыре письма (SPEC §12, правила RU §7).
 *
 * В ТЗ для этого оффера нет готовых текстов — только структура. Поэтому
 * тексты фиксированы здесь, а персонализация — одна фраза сигнала по шаблону
 * его типа (без LLM) и гипотеза сегментов в письме 3.
 *
 *  1 — сигнал и причина обращения, что делает Polza, низкопороговый CTA; две темы;
 *  2 — возражение «это массовая рассылка», механика, кейс или без него, CTA;
 *  3 — гипотеза: два сегмента, признаки отбора, исключения; при неподтверждённом
 *      рынке — только общие формулировки;
 *  4 — короткое закрытие с бинарным CTA, короче писем 2 и 3.
 *
 * Сегменты письма 3 пишет LLM только при подтверждённом рынке; ответ проходит
 * жёсткую чистку (без цифр, короткие фразы) и формулируется как гипотеза.
 */

import { wordCount } from '../evidence';
import { asStringArray, callJson } from '../llm';
import type { Signal } from '../types';
import { caseBlock, claim, intro, paragraphs, q, signed, usedClaimIds, type AssembledChain, type LetterContext } from './common';

export interface SegmentsHypothesis {
  segments: [string, string];
  selectionSignals: string[];
  exclusions: string[];
}

export interface SignalsLetterInput {
  signal: Signal | null;
  /** Цитата рынка/клиентов компании (сверена) — без неё сегменты общие. */
  marketQuote: string | null;
  hypothesis: SegmentsHypothesis | null;
}

function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' });
}

/** Одна фраза-повод по типу сигнала. Только подтверждённые A/B-факты. */
export function signalSentence(signal: Signal | null, brand: string): string | null {
  if (!signal || (signal.level !== 'A' && signal.level !== 'B')) return null;
  const b = q(brand);
  switch (signal.type) {
    case 'sdr_hiring':
    case 'sales_hiring':
    case 'multiple_sales_vacancies': {
      const quote = signal.quote && wordCount(signal.quote) <= 20 ? ` В вакансии указано: «${signal.quote}».` : '';
      return `Увидел, что вы ищете «${signal.title}».${quote}`;
    }
    case 'trade_show_exhibitor': {
      const start = formatDate(signal.meta?.event_start as string | undefined);
      return `Увидел ${b} среди участников выставки «${signal.title}»${start ? ` (${start})` : ''}.`;
    }
    case 'contract_won': {
      const customer = typeof signal.meta?.customer === 'string' ? signal.meta.customer : null;
      const subject = signal.title && wordCount(signal.title) <= 15 ? signal.title : null;
      if (!customer && !subject) return null;
      return `Увидел в ЕИС свежий контракт ${b}${customer ? ` с заказчиком «${customer}»` : ''}${subject ? ` — «${subject}»` : ''}.`;
    }
    default:
      return signal.quote ? `Увидел на вашем сайте: «${signal.quote}».` : null;
  }
}

function subjectsFor(signal: Signal | null, brand: string): [string, string] {
  const b = q(brand);
  if (signal && (signal.type === 'sales_hiring' || signal.type === 'sdr_hiring' || signal.type === 'multiple_sales_vacancies')) {
    return [`по поводу вакансии в ${b}`, `новые B2B-клиенты для ${b}`];
  }
  return [`вопрос по B2B-продажам в ${b}`, `новые B2B-клиенты для ${b}`];
}

export function buildSignalsChain(ctx: LetterContext, input: SignalsLetterInput): AssembledChain {
  const b = q(ctx.brand);
  const s = ctx.sender;
  const opening = signalSentence(input.signal, ctx.brand);
  const [subjectA, subjectB] = subjectsFor(opening ? input.signal : null, ctx.brand);
  const value = claim(ctx, 'letter2_value');
  const caseText = caseBlock(ctx);

  const letter1 = {
    n: 1,
    subject: subjectA,
    body: signed(
      paragraphs(
        'Добрый день!',
        opening ?? `Пишу коротко по поводу привлечения B2B-клиентов для ${b}.`,
        'Я занимаюсь развитием Polza Agency. Мы помогаем B2B-компаниям находить целевые компании, выходить на ЛПР и передавать отделу продаж заинтересованные диалоги. Это можно запустить как отдельный тест параллельно вашей текущей работе с клиентами.',
        ctx.isRouting
          ? `Подскажите, пожалуйста, кто в ${b} отвечает за продажи и привлечение новых клиентов? Буду благодарен, если передадите ему письмо.`
          : `Есть смысл прикинуть такой тест для ${b}?`,
      ),
      s,
    ),
  };

  const letter2 = {
    n: 2,
    subject: '',
    body: signed(
      paragraphs(
        'Добрый день!',
        `${intro(s)}. На днях писал по поводу привлечения B2B-клиентов для ${b}.`,
        'Часто холодные письма считают массовой рассылкой. У нас наоборот: сначала выбираем сегменты, затем собираем в них компании и ЛПР, пишем каждому письмо с конкретным поводом для обращения и передаём вашему отделу продаж заинтересованные ответы вместе с перепиской.',
        caseText,
        value?.claim_text,
        `Предлагаю на 15 минут созвониться и разобрать, как такой тест мог бы выглядеть для ${b}. Когда будет удобно?`,
      ),
      s,
    ),
  };

  const h = input.marketQuote ? input.hypothesis : null;
  const hypothesisBlock = h
    ? paragraphs(
        `Для первого теста можно проверить два сегмента: ${h.segments[0]} и ${h.segments[1]}.`,
        h.selectionSignals.length ? `Отбирать компании внутри них можно по признакам вроде: ${h.selectionSignals.join(', ')}.` : null,
        h.exclusions.length ? `В тест не брал бы: ${h.exclusions.join(', ')}.` : null,
        'Это предварительная гипотеза — на старте её нужно сверить с вашим продуктом и экономикой сделки.',
      )
    : paragraphs(
        'Для первого теста я бы не делал одну широкую рассылку, а взял два узких сегмента потенциальных клиентов и для каждого — свой повод для обращения: например, найм в продажах, открытие филиалов или участие в отраслевых выставках.',
        'Ваших текущих клиентов, конкурентов и компании без подходящего профиля в такой тест не берём. Сами сегменты — гипотеза, её нужно сверить с вашим продуктом и экономикой сделки.',
      );

  const letter3 = {
    n: 3,
    subject: '',
    body: signed(
      paragraphs(
        'Добрый день!',
        `Ещё одна мысль по ${b}.`,
        hypothesisBlock,
        'Могу прислать короткий список сегментов и признаков отбора?',
      ),
      s,
    ),
  };

  const letter4 = {
    n: 4,
    subject: '',
    body: signed(
      paragraphs(
        'Добрый день!',
        'Оставлю это здесь, чтобы не надоедать.',
        'Если привлечение новых клиентов сейчас не в приоритете, можно вернуться к теме позже. Если этим занимается другой человек, достаточно переслать ему письмо.',
        'Поставить тему на паузу или прислать короткий план теста?',
      ),
      s,
    ),
  };

  return {
    letters: [letter1, letter2, letter3, letter4],
    subjectB,
    caseId: ctx.caseRecord?.case_id ?? null,
    claimIds: usedClaimIds(value),
  };
}

const SEGMENTS_SYSTEM = `Ты помогаешь агентству B2B-аутрича Polza набросать гипотезу первого теста для компании-клиента. Верни СТРОГИЙ JSON:
{
  "segments": [string, string],        // два возможных сегмента БУДУЩИХ клиентов компании, по 2–7 слов, именительный падеж множественного числа (например «производственные холдинги»)
  "selection_signals": [string, string], // 2 признака отбора компаний внутри сегментов, по 2–6 слов, фраза-признак (например «открывают новые филиалы»)
  "exclusions": [string]               // 1 группа, кому писать не стоит, 2–6 слов, именительный падеж множественного числа
}
Правила: сегменты ДОЛЖНЫ соответствовать подтверждённому рынку из цитаты; без цифр, названий конкретных компаний, превосходных степеней и обещаний.`;

/** Гипотеза сегментов письма 3. Только при подтверждённой цитате рынка. */
export async function buildSegmentsHypothesis(input: {
  brand: string;
  productSummary: string | null;
  marketQuote: string;
}): Promise<SegmentsHypothesis | null> {
  const raw = await callJson(
    SEGMENTS_SYSTEM,
    [`КОМПАНИЯ: ${input.brand}`, `ЧТО ПРОДАЁТ: ${input.productSummary ?? 'не указано'}`, `ПОДТВЕРЖДЁННЫЙ РЫНОК (цитата): «${input.marketQuote}»`].join('\n'),
    'segments',
    400,
  );
  const clean = (items: string[], maxWords: number) =>
    items
      .map((t) => t.replace(/[.;!?]+$/g, '').trim())
      .filter((t) => t && !/\d/.test(t) && wordCount(t) <= maxWords && !/[{}«»"]/.test(t));
  const segments = clean(asStringArray(raw.segments, 2), 7);
  if (segments.length < 2) return null;
  return {
    segments: [segments[0], segments[1]],
    selectionSignals: clean(asStringArray(raw.selection_signals, 2), 6),
    exclusions: clean(asStringArray(raw.exclusions, 1), 6),
  };
}

