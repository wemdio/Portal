/**
 * Шесть цепочек «Нашего автоаутрича» (RU_OUTREACH_HANDOFF §2, §3.2): пять по
 * четыре письма и SDR-цепочка «найм» — три письма по INSTRUCTION_02 (23.09).
 *
 *  1 — повод: вакансия / реклама / выставка / рост / профиль / прошлый разговор;
 *      на общий ящик — routing-вариант «кому переслать»;
 *  2 — боль и что делает Polza, почему outbound есть смысл проверить сейчас;
 *  3 — доказательство: утверждённый кейс / гипотеза сегментов (только при
 *      подтверждённом рынке) / механика без цифр;
 *  4 — мягкое закрытие: актуально, не актуально или к кому обратиться.
 *
 * Черновики текстов от 23.09.2026 — на согласовании у CEO. Факты о компании в
 * письмо попадают только из подтверждённого сигнала; боль сформулирована как
 * общее наблюдение о канале, а не диагноз получателя.
 */

import { wordCount } from '../evidence';
import { asStringArray, callJson } from '../llm';
import type { ChainType, Letter, Signal } from '../types';
import { caseBlock, claim, intro, paragraphs, q, signed, usedClaimIds, type AssembledChain, type LetterContext } from './common';

export interface ChainInput {
  chain: ChainType;
  signal: Signal | null;
  /** Сделка AMO с записанным разговором — разрешает «мы с вами уже общались». */
  priorContact: boolean;
  /** Дословная цитата о рынке/клиентах компании — без неё сегменты общие. */
  marketQuote: string | null;
  productSummary: string | null;
}

function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' });
}

/** Фраза-повод письма 1. Только подтверждённые факты A/B; иначе null. */
export function openingSentence(input: ChainInput, brand: string): string | null {
  const s = input.signal;
  const b = q(brand);
  switch (input.chain) {
    case 'reactivation':
      return input.priorContact ? 'Мы с вами уже общались по поводу email-аутрича.' : null;
    case 'hiring': {
      if (!s) return null;
      const quote = s.quote && s.level === 'A' && wordCount(s.quote) <= 20 ? ` В вакансии указано: «${s.quote}».` : '';
      return `Увидел, что вы ищете «${s.title}». Я не по поводу подбора кандидата.${quote}`;
    }
    case 'ad_budget': {
      const keyword = typeof s?.meta?.keyword === 'string' ? s.meta.keyword : null;
      return keyword && wordCount(keyword) <= 8 ? `Увидел рекламу ${b} в Яндексе по запросу «${keyword}».` : `Увидел рекламу ${b} в Яндексе.`;
    }
    case 'event': {
      if (!s) return null;
      const start = formatDate(s.meta?.event_start as string | undefined);
      return `Увидел ${b} среди участников выставки «${s.title}»${start ? ` (${start})` : ''}.`;
    }
    case 'growth_event': {
      if (!s) return null;
      if (s.source === 'news' && s.quote) return `Увидел новость: «${s.quote}».`;
      if (s.type === 'tender_won') {
        const subject = s.title && wordCount(s.title) <= 15 ? s.title : null;
        return `Увидел, что ${b} выиграла тендер${subject ? ` «${subject}»` : ''}.`;
      }
      // Цифры роста в письмо не несём: QA режет числа не из разрешённых источников.
      if (s.type === 'revenue_growth') return `Увидел по открытой отчётности, что ${b} заметно выросла за последний год.`;
      if (s.type === 'new_office' && s.source === 'gis') return `Увидел, что у ${b} несколько филиалов.`;
      if (s.type === 'new_office' && s.source === 'ymaps') return `Увидел, что у ${b} появилась новая точка: ${s.title}.`;
      if (s.type === 'contract_won') {
        const customer = typeof s.meta?.customer === 'string' ? s.meta.customer : null;
        const subject = s.title && wordCount(s.title) <= 15 ? s.title : null;
        if (!customer && !subject) return null;
        return `Увидел в ЕИС свежий контракт ${b}${customer ? ` с заказчиком «${customer}»` : ''}${subject ? ` — «${subject}»` : ''}.`;
      }
      if (s.type === 'grant_or_accelerator') {
        const program = typeof s.meta?.program === 'string' ? s.meta.program : s.title;
        return program ? `Увидел ${b} среди участников программы «${program}».` : null;
      }
      return s.quote ? `Увидел на вашем сайте: «${s.quote}».` : null;
    }
    case 'icp_only':
      // Цитата — только законченная мысль: обрывок «производственных предприятий» в письме нелеп.
      return input.marketQuote && wordCount(input.marketQuote) >= 6 && wordCount(input.marketQuote) <= 20
        ? `На вашем сайте указано: «${input.marketQuote}».`
        : null;
  }
}

const WHAT_WE_DO =
  'Я занимаюсь развитием Polza Agency. Мы подбираем подходящие компании, находим в них ЛПР и пишем им от вашего лица, а заинтересованные ответы передаём вашему менеджеру вместе с перепиской.';

interface ChainCopy {
  subjects: (b: string, s: Signal | null) => [string, string];
  /** Абзац после повода в письме 1 (что делает Polza под этот повод). */
  letter1: string;
  cta1: (b: string) => string;
  /** Письмо 2: «на днях писал …» и боль. */
  recall: (b: string, s: Signal | null) => string;
  pain: string;
  cta2: (b: string) => string;
}

/** Цепочки CEO по четыре письма; «найм» — отдельная SDR-цепочка (buildSdrChain). */
const COPY: Record<Exclude<ChainType, 'hiring'>, ChainCopy> = {
  reactivation: {
    subjects: (b) => [`снова по поводу аутрича для ${b}`, `новая гипотеза для ${b}`],
    letter1:
      'Возвращаюсь не с тем же предложением. Сейчас мы начинаем с узких сегментов и конкретного повода для обращения к каждой компании — вакансии, выставки, новые филиалы, — а не с одной общей рассылки.',
    cta1: (b) => `Есть смысл посмотреть свежую гипотезу для ${b}?`,
    recall: (b) => `На днях писал про новый подход к аутричу для ${b}.`,
    pain:
      'Предлагаю начать с малого: 2–3 узких сегмента, в каждом свой повод для письма, и отчёт по ответам. Если сегмент не отвечает, меняем гипотезу, а не повторяем рассылку. Заинтересованные ответы передаём вашему менеджеру вместе с перепиской.',
    cta2: () => 'Удобно созвониться на 15 минут и выбрать сегменты для первого теста?',
  },
  ad_budget: {
    subjects: (b) => [`вопрос по привлечению клиентов в ${b}`, `клиенты для ${b} помимо рекламы`],
    letter1:
      'Реклама хорошо ловит тех, кто уже ищет подрядчика. Мы в Polza Agency работаем с другой частью рынка: находим компании, которые подходят вам по профилю, но сами пока не ищут, и выходим на их ЛПР письмами от вашего лица.',
    cta1: (b) => `Есть смысл обсудить, как это может дополнить рекламу ${b}?`,
    recall: (b) => `На днях писал про привлечение клиентов для ${b} помимо рекламы.`,
    pain:
      'У рекламы обычно есть предел: когда спрос в поиске выбран, каждый следующий клиент обходится дороже. Холодный аутрич от поискового спроса не зависит — мы сами выбираем сегменты, собираем компании и ЛПР и передаём вашему менеджеру заинтересованные ответы вместе с перепиской.',
    cta2: () => 'Предлагаю на 15 минут созвониться и прикинуть, какие сегменты можно проверить. Когда будет удобно?',
  },
  event: {
    subjects: (b, s) => [s?.title && wordCount(s.title) <= 6 ? `по поводу выставки «${s.title}»` : `вопрос по выставке и ${b}`, `встречи с ЛПР для ${b}`],
    letter1:
      'Вокруг выставки удобно выходить к ЛПР: мы в Polza Agency собираем компании вашего рынка, находим ответственных и пишем им от вашего лица — до события, чтобы договориться о встречах, или после, чтобы продолжить контакты.',
    cta1: (b) => `Есть смысл обсудить такой выход на рынок для ${b}?`,
    recall: (_b, s) => `На днях писал по поводу выставки${s?.title ? ` «${s.title}»` : ''}.`,
    pain:
      'На выставке успеваешь поговорить только с частью рынка, остальные компании остаются без контакта. Их можно добрать письмами: собрать компании и ЛПР вокруг тематики выставки и написать каждому с конкретным поводом. Заинтересованные ответы передаём вашему менеджеру.',
    cta2: () => 'Удобно созвониться на 15 минут и обсудить список сегментов?',
  },
  growth_event: {
    subjects: (b) => [`вопрос по B2B-продажам в ${b}`, `новые B2B-клиенты для ${b}`],
    letter1:
      'После таких событий часто нужно быстро проверить, где ещё есть спрос. Мы в Polza Agency находим B2B-компании под ваш продукт, выходим на ЛПР письмами от вашего лица и передаём заинтересованные ответы вашему менеджеру.',
    cta1: (b) => `Есть смысл обсудить такой тест для ${b}?`,
    recall: (b) => `На днях писал по поводу новых B2B-клиентов для ${b}.`,
    pain:
      'Новому продукту, региону или проекту нужны первые клиенты, а входящий поток на старте обычно небольшой. Outbound позволяет не ждать: выбираем 2–3 сегмента, собираем компании и ЛПР и быстро видим, какие из них откликаются.',
    cta2: () => 'Удобно созвониться на 15 минут и прикинуть первые сегменты?',
  },
  icp_only: {
    subjects: (b) => [`вопрос по B2B-продажам в ${b}`, `новые B2B-клиенты для ${b}`],
    letter1: WHAT_WE_DO,
    cta1: (b) => `Подскажите, есть смысл обсудить такой канал привлечения клиентов для ${b}?`,
    recall: (b) => `На днях писал по поводу привлечения B2B-клиентов для ${b}.`,
    pain:
      'Часто холодные письма считают массовой рассылкой. У нас наоборот: сначала выбираем сегменты, затем собираем в них компании и ЛПР, пишем каждому письмо с конкретным поводом для обращения и передаём вашему отделу продаж заинтересованные ответы вместе с перепиской.',
    cta2: () => 'Предлагаю на 15 минут созвониться и прикинуть объём доступной базы. Когда будет удобно?',
  },
};

export interface SegmentsHypothesis {
  segments: [string, string];
  selectionSignals: string[];
  exclusions: string[];
}

export function hypothesisText(brand: string, h: SegmentsHypothesis): string {
  return paragraphs(
    `Для ${q(brand)} я бы начал с двух сегментов: ${h.segments[0]} и ${h.segments[1]}.`,
    h.selectionSignals.length ? `Отбирать компании внутри них можно по признакам вроде: ${h.selectionSignals.join(', ')}.` : null,
    h.exclusions.length ? `В тест не брал бы: ${h.exclusions.join(', ')}.` : null,
    'Это предварительная гипотеза — на старте её нужно сверить с вашим продуктом и экономикой сделки.',
  );
}

const MECHANISM =
  'Обычно первый тест выглядит так: согласовываем 2–3 сегмента, собираем в них компании и ЛПР, готовим письма под каждый сегмент с отдельным поводом для обращения — и по ответам видно, какие сегменты стоит масштабировать.';

/**
 * SDR-цепочка — три письма по INSTRUCTION_02 (Максим, 23.09.2026): вакансия и
 * причина → механика → простой вопрос о планах. Кейс по отрасли не подбираем
 * (SDR_ENTERPRISE_PROOF_AND_OFFER_ROUTING §2): в письмо 2 идёт утверждённая
 * фраза о ролях, до которых доходили в клиентских кампаниях (claim
 * `sdr_role_proof`), а без неё — описание процесса.
 */
function buildSdrChain(ctx: LetterContext, input: ChainInput): AssembledChain & { campaignHypothesis: string | null } {
  const b = q(ctx.brand);
  const s = ctx.sender;
  const signal = input.signal;
  const title = signal?.title ? `«${signal.title}»` : 'специалиста по привлечению клиентов';
  const quote = signal?.quote && signal.level === 'A' && wordCount(signal.quote) <= 30 ? signal.quote : null;
  const market =
    input.marketQuote && wordCount(input.marketQuote) >= 4 && wordCount(input.marketQuote) <= 25
      ? `У вас указано: «${input.marketQuote}».`
      : null;
  const roleProof = claim(ctx, 'sdr_role_proof');

  const letter1: Letter = ctx.isRouting
    ? {
        n: 1,
        subject: `вопрос по B2B-продажам в ${b}`,
        body: signed(
          paragraphs(
            'Добрый день!',
            `Подскажите, пожалуйста, кто в ${b} отвечает за продажи и привлечение новых клиентов?`,
            `Увидел вакансию ${title} и хочу обсудить внешний email-outreach как дополнительный канал первичного контакта с B2B-компаниями.`,
            'Буду благодарен, если передадите письмо ответственному сотруднику или подскажете его контакт.',
          ),
          s,
        ),
      }
    : {
        n: 1,
        subject: `по поводу вакансии в ${b}`,
        body: signed(
          paragraphs(
            `Добрый день! Я очень коротко по поводу ${b}.`,
            `Увидел, что вы ищете ${title}. Я не по поводу подбора кандидата.`,
            'Я занимаюсь развитием Polza Agency. Мы привлекаем B2B-клиентов через email-outreach: подбираем компании, находим ЛПР и пишем им от вашего лица. Первичный контакт и переписку до заинтересованного ответа берём на себя, после чего передаём ответ вашему менеджеру вместе с контекстом.',
            `Есть смысл коротко обсудить, как это можно проверить для ${b}?`,
          ),
          s,
        ),
      };

  const letter2: Letter = {
    n: 2,
    subject: '',
    body: signed(
      paragraphs(
        'Добрый день!',
        `${intro(s)}. На днях писал по поводу привлечения B2B-клиентов для ${b}.`,
        quote ? `В вакансии ${title} указано: «${quote}».` : null,
        market,
        roleProof?.claim_text,
        'Наш процесс выглядит так: согласовываем 2–3 приоритетных сегмента, собираем компании и ЛПР, готовим письма под каждый сегмент и передаём вашему менеджеру заинтересованные ответы вместе с перепиской.',
        `Предлагаю на 15 минут созвониться и собрать черновик первого теста для ${b}. Если увидим, что канал для задачи не подходит, скажу прямо. Когда будет удобно?`,
      ),
      s,
    ),
  };

  const letter3: Letter = {
    n: 3,
    subject: '',
    body: signed(
      paragraphs(
        'Добрый день!',
        `${intro(s, true)}. Понимаю, что сейчас, возможно, не до этого, поэтому всего один короткий вопрос.`,
        `Привлечение новых клиентов вообще входит в планы ${b} на ближайшие месяцы?`,
        'Если актуально, могу предварительно прикинуть потенциал: сколько компаний подходит под ваш портрет клиента и какой объём разумно взять в первый тест. Если тема отложена, подскажите, к какому времени вернуться, и я напомню о себе ближе к сроку без лишних писем.',
      ),
      s,
    ),
  };

  return {
    letters: [letter1, letter2, letter3],
    subjectB: `вопрос по B2B-продажам в ${b}`,
    caseId: null,
    claimIds: usedClaimIds(roleProof),
    campaignHypothesis: null,
  };
}

export function buildChain(ctx: LetterContext, input: ChainInput, hypothesis: SegmentsHypothesis | null): AssembledChain & { campaignHypothesis: string | null } {
  if (input.chain === 'hiring') return buildSdrChain(ctx, input);
  const copy = COPY[input.chain];
  const b = q(ctx.brand);
  const s = ctx.sender;
  const opening = openingSentence(input, ctx.brand);
  const [subjectA, subjectB] = copy.subjects(b, input.signal);
  const value = claim(ctx, 'letter2_value');
  const hypoText = !ctx.caseRecord && hypothesis && input.marketQuote ? hypothesisText(ctx.brand, hypothesis) : null;

  const letter1: Letter = ctx.isRouting
    ? {
        n: 1,
        subject: subjectA,
        body: signed(
          paragraphs(
            'Добрый день!',
            `Подскажите, пожалуйста, кто в ${b} отвечает за продажи и привлечение новых клиентов?`,
            opening,
            WHAT_WE_DO,
            'Буду благодарен, если передадите письмо ответственному сотруднику или подскажете его контакт.',
          ),
          s,
        ),
      }
    : {
        n: 1,
        subject: subjectA,
        body: signed(
          paragraphs(
            'Добрый день!',
            opening ?? `Пишу коротко по поводу привлечения B2B-клиентов для ${b}.`,
            copy.letter1,
            copy.cta1(b),
          ),
          s,
        ),
      };

  const letter2: Letter = {
    n: 2,
    subject: '',
    body: signed(
      paragraphs('Добрый день!', `${intro(s)}. ${copy.recall(b, input.signal)}`, copy.pain, value?.claim_text, copy.cta2(b)),
      s,
    ),
  };

  const letter3: Letter = {
    n: 3,
    subject: '',
    body: signed(
      paragraphs(
        'Добрый день!',
        `${intro(s, true)}. Покажу на примере, как это выглядит.`,
        caseBlock(ctx) ?? hypoText ?? MECHANISM,
        `Могу прислать короткий план первого теста для ${b}?`,
      ),
      s,
    ),
  };

  const letter4: Letter = {
    n: 4,
    subject: '',
    body: signed(
      paragraphs(
        'Добрый день!',
        'Не хочу надоедать, поэтому последнее письмо.',
        'Если тема сейчас не актуальна, скажите — вернусь позже. Если этим занимается другой человек, подскажите, к кому лучше обратиться.',
        'Актуально сейчас или лучше вернуться позже?',
      ),
      s,
    ),
  };

  return {
    letters: [letter1, letter2, letter3, letter4],
    subjectB,
    caseId: ctx.caseRecord?.case_id ?? null,
    claimIds: usedClaimIds(value),
    campaignHypothesis: hypoText,
  };
}

const SEGMENTS_SYSTEM = `Ты помогаешь агентству B2B-аутрича Polza набросать гипотезу первого теста для компании-клиента. Верни СТРОГИЙ JSON:
{
  "segments": [string, string],          // два возможных сегмента БУДУЩИХ клиентов компании, по 2–7 слов, именительный падеж множественного числа
  "selection_signals": [string, string], // 2 признака отбора компаний внутри сегментов, по 2–6 слов (например «открывают новые филиалы»)
  "exclusions": [string]                 // 1 группа, кому писать не стоит, 2–6 слов, именительный падеж множественного числа
}
Правила: сегменты ДОЛЖНЫ соответствовать подтверждённому рынку из цитаты; без цифр, названий конкретных компаний, превосходных степеней и обещаний.`;

/** Гипотеза сегментов письма 3 — только при подтверждённой цитате рынка. */
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
