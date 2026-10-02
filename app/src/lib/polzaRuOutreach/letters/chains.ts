/**
 * Цепочки «Нашего автоаутрича» (RU_OUTREACH_HANDOFF §2, §3.2). Все — четыре
 * письма в формате CEO (решение 26.09.2026), включая SDR-цепочку «найм»
 * (тексты INSTRUCTION_02) и «Автоматизированный аутрич» (тексты INSTRUCTION_03,
 * сплит 50/50).
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
 *
 * С 26.09.2026 письма компаниям собираются из шаблона цепочки оффера, который
 * один раз на запуск пишет Gemini 3.1 Pro (templateWriter.ts, спека
 * 2026-09-26-outreach-to-sender-design.md §4). Цепочки отсюда — образец тона и
 * структуры для писателя: он получает их собранными на плейсхолдерах. Под
 * компанию по-прежнему считаются здесь фраза-повод (openingSentence) и
 * гипотеза сегментов (buildSegmentsHypothesis).
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
  /** У «Автоматизации» — исходная цепочка: её подтверждённый повод идёт в письмо 2. */
  baseChain?: ChainType;
  /**
   * Режим образца для писателя шаблонов (templateWriter.ts): готовая
   * фраза-повод вместо собранной из сигнала — туда встаёт плейсхолдер
   * {{повод}}, сигнал с таким текстом не собрать. В этом режиме цепочка
   * собирается по контракту шаблона: повод — в письме 1 обоих вариантов и
   * только там (у SDR и «Автоматизации» его прежнее место — в других абзацах).
   */
  opening?: string;
  /**
   * Режим образца: плейсхолдер связки повода с предложением ({{связка}}) —
   * абзацем сразу после повода в письме 1 обоих вариантов.
   */
  bridge?: string;
  /**
   * Режим образца: абзац гипотезы сегментов ({{гипотеза}}) в письме 3 без
   * кейса — перед механикой, как в контракте шаблона. Без него письмо 3 —
   * гипотеза или механика, как раньше.
   */
  hypothesis?: string;
}

function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' });
}

/**
 * Фраза-повод письма 1. Только подтверждённые факты A/B; иначе null.
 * Компанию называем «вы», а не по имени (28.09.2026): название в кавычках не
 * склоняется («увидел рекламу «Академия …»», «…выиграла тендер» у мужского
 * рода), а обращение на «вы» звучит как письмо человеку, а не отчёт о нём.
 */
export function openingSentence(input: ChainInput, brand: string): string | null {
  const s = input.signal;
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
      return keyword && wordCount(keyword) <= 8 ? `Увидел вашу рекламу в Яндексе по запросу «${keyword}».` : 'Увидел вашу рекламу в Яндексе.';
    }
    case 'event': {
      if (!s) return null;
      const start = formatDate(s.meta?.event_start as string | undefined);
      return `Увидел вашу компанию среди участников выставки «${s.title}»${start ? ` (${start})` : ''}.`;
    }
    case 'growth_event': {
      if (!s) return null;
      if (s.source === 'news' && s.quote) return `Увидел новость: «${s.quote}».`;
      if (s.type === 'tender_won') {
        const subject = s.title && wordCount(s.title) <= 15 ? s.title : null;
        return `Увидел, что вы выиграли тендер${subject ? ` «${subject}»` : ''}.`;
      }
      // Цифры роста в письмо не несём сознательно: фраза-повод целиком попадает в разрешённые факты QA, и неподтверждённое число он бы не поймал.
      if (s.type === 'revenue_growth') return 'Увидел по открытой отчётности, что ваша выручка заметно выросла за последний год.';
      if (s.type === 'new_office' && s.source === 'gis') return 'Увидел, что у вас несколько филиалов.';
      if (s.type === 'new_office' && s.source === 'ymaps') return `Увидел, что у вас появилась новая точка: ${s.title}.`;
      if (s.type === 'contract_won') {
        const customer = typeof s.meta?.customer === 'string' ? s.meta.customer : null;
        const subject = s.title && wordCount(s.title) <= 15 ? s.title : null;
        if (!customer && !subject) return null;
        return `Увидел в ЕИС ваш свежий контракт${customer ? ` с заказчиком «${customer}»` : ''}${subject ? ` — «${subject}»` : ''}.`;
      }
      if (s.type === 'grant_or_accelerator') {
        const program = typeof s.meta?.program === 'string' ? s.meta.program : s.title;
        return program ? `Увидел вашу компанию среди участников программы «${program}».` : null;
      }
      return s.quote ? `Увидел на вашем сайте: «${s.quote}».` : null;
    }
    case 'icp_only':
      // Цитата — только законченная мысль: обрывок «производственных предприятий» в письме нелеп.
      return input.marketQuote && wordCount(input.marketQuote) >= 6 && wordCount(input.marketQuote) <= 20
        ? `На вашем сайте указано: «${input.marketQuote}».`
        : null;
    case 'automation':
      // Повод исходной цепочки, в том числе «мы с вами уже общались» у
      // возврата: шаблон оффера один на все его компании, и о разговоре в AMO
      // письмо узнаёт только из повода.
      return input.baseChain && input.baseChain !== 'automation'
        ? openingSentence({ ...input, chain: input.baseChain }, brand)
        : null;
  }
}

/**
 * Тексты образца переписаны 28.09.2026: прежние шли в шаблоны почти дословно,
 * и продажи назвали письма «топорными и одинаковыми». Смысл и порядок писем
 * те же. Правила: название компании — только с родовым словом («в компании
 * «…»», «для компании «…»»: в кавычках оно не склоняется, и «кто в
 * «Академия …» отвечает» читалось как ошибка) или без предлога; в письме 1
 * сначала повод и строка о компании, вопрос — в конце.
 */
/**
 * Предложение письма 1 по замечанию CEO 02.10.2026: сначала выгода — новые
 * заявки каждый месяц, — потом простыми словами, что это (получатели не знают
 * слова «аутрич»: это автоматические рассылки на почты), и модель оплаты —
 * один раз за настройку, дальше поддержка при необходимости. Цифры заявок
 * в месяц нет, пока её не утвердят формулировкой в «Библиотеках».
 */
const WHAT_WE_DO =
  'Я из Polza Agency. Помогаем B2B-компаниям получать новые заявки каждый месяц: настраиваем автоматические рассылки писем на почты компаний, которым подходит ваш продукт, — от вашего имени, а ответивших с интересом передаём вашему менеджеру.';
const PAY_ONCE = 'Платите один раз за настройку, дальше — только поддержка, если она понадобится, а заявки продолжают приходить.';

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

/** Цепочки CEO; «найм» и «автоматизация» — тексты Максима в том же формате из четырёх писем. */
const COPY: Record<Exclude<ChainType, 'hiring' | 'automation'>, ChainCopy> = {
  reactivation: {
    subjects: (b) => [`снова про аутрич для ${b}`, `новая гипотеза для ${b}`],
    letter1: paragraphs(
      'С тех пор у нас появился формат проще: один раз настраиваем автоматические рассылки писем на почты подходящих вам компаний, и новые заявки приходят каждый месяц. Каждой компании пишем с конкретным поводом — вакансия, выставка, новый филиал.',
      PAY_ONCE,
    ),
    cta1: () => 'Есть смысл показать, как это выглядело бы для вас сейчас?',
    recall: () => 'Возвращаюсь к своему письму про новый подход к аутричу.',
    pain:
      'Предлагаю начать с малого теста: 2–3 узких сегмента, свой повод для письма в каждом и отчёт по ответам. Если сегмент молчит, меняем гипотезу, а не отправляем то же самое повторно. Тех, кто ответил с интересом, передаём вашему менеджеру вместе с перепиской.',
    cta2: () => 'Созвонимся на 15 минут и выберем сегменты для первого теста?',
  },
  ad_budget: {
    subjects: (b) => [`клиенты для ${b} помимо рекламы`, `новые клиенты без роста ставок`],
    letter1: paragraphs(WHAT_WE_DO, PAY_ONCE),
    cta1: () => 'Интересно посмотреть, как это может дополнить вашу рекламу?',
    recall: () => 'На днях писал про клиентов помимо рекламы.',
    pain:
      'У рекламы есть потолок: когда горячий спрос в поиске выбран, каждый следующий клиент выходит дороже. Холодным письмам поисковый спрос не нужен — мы сами выбираем сегменты, собираем компании и ЛПР, а ответы с интересом передаём вашему менеджеру вместе с перепиской.',
    cta2: () => 'Созвонимся на 15 минут и прикинем, какие сегменты стоит проверить первыми?',
  },
  event: {
    subjects: (b, s) => [s?.title && wordCount(s.title) <= 6 ? `про выставку «${s.title}»` : `встречи на выставке для ${b}`, `встречи с ЛПР для ${b}`],
    letter1: paragraphs(WHAT_WE_DO, PAY_ONCE),
    cta1: () => 'Есть смысл обсудить, как это сделать вокруг выставки?',
    recall: (_b, s) => `На днях писал про выставку${s?.title ? ` «${s.title}»` : ''}.`,
    pain:
      'На самой выставке успеваешь поговорить только с частью рынка. Остальных можно добрать письмами: собрать компании и ЛПР по тематике выставки и написать каждому с понятным поводом. Ответы с интересом передаём вашему менеджеру.',
    cta2: () => 'Созвонимся на 15 минут и обсудим список сегментов?',
  },
  growth_event: {
    subjects: (b) => [`новые B2B-клиенты для ${b}`, `вопрос про B2B-продажи`],
    letter1: paragraphs(WHAT_WE_DO, PAY_ONCE),
    cta1: () => 'Есть смысл обсудить такой тест?',
    recall: () => 'На днях писал про новых B2B-клиентов.',
    pain:
      'Новому продукту, региону или проекту нужны первые клиенты, а входящих заявок на старте обычно немного. Холодные письма позволяют не ждать: берём 2–3 сегмента, собираем компании и ЛПР и быстро видим, кто откликается.',
    cta2: () => 'Созвонимся на 15 минут и прикинем первые сегменты?',
  },
  icp_only: {
    subjects: (b) => [`новые B2B-клиенты для ${b}`, `вопрос про B2B-продажи`],
    letter1: paragraphs(WHAT_WE_DO, PAY_ONCE),
    cta1: (b) => `Есть смысл обсудить такой канал для компании ${b}?`,
    recall: () => 'На днях писал про холодные письма как канал привлечения клиентов.',
    pain:
      'Холодные письма часто путают с массовой рассылкой. У нас наоборот: сначала выбираем сегменты, потом собираем в них компании и ЛПР и каждому пишем с конкретным поводом. Ответы с интересом передаём вашему отделу продаж вместе с перепиской.',
    cta2: () => 'Созвонимся на 15 минут и прикинем, сколько подходящих компаний есть на вашем рынке?',
  },
};

export interface SegmentsHypothesis {
  segments: [string, string];
  selectionSignals: string[];
  exclusions: string[];
}

export function hypothesisText(brand: string, h: SegmentsHypothesis): string {
  return paragraphs(
    `Для компании ${q(brand)} я бы начал с двух сегментов: ${h.segments[0]} и ${h.segments[1]}.`,
    h.selectionSignals.length ? `Отбирать компании внутри них можно по признакам вроде: ${h.selectionSignals.join(', ')}.` : null,
    h.exclusions.length ? `В тест не брал бы: ${h.exclusions.join(', ')}.` : null,
    'Это предварительная гипотеза — на старте её нужно сверить с вашим продуктом и экономикой сделки.',
  );
}

const MECHANISM =
  'Первый тест обычно выглядит так: договариваемся о 2–3 сегментах, собираем в них компании и ЛПР, пишем под каждый сегмент со своим поводом — и по ответам видно, какие сегменты стоит расширять.';

/** Письмо 4 всех цепочек (формат CEO): мягкое закрытие. */
function closingLetter(s: LetterContext['sender']): Letter {
  return {
    n: 4,
    subject: '',
    body: signed(
      paragraphs(
        'Добрый день!',
        'Это последнее письмо, дальше не побеспокою.',
        'Если этим занимается коллега, подскажите, кому переслать. Если тема не ко времени, так и напишите — вернусь позже.',
        'Тема сейчас актуальна?',
      ),
      s,
    ),
  };
}

/**
 * SDR-цепочка — тексты INSTRUCTION_02 (Максим, 23.09.2026) в формате CEO из
 * четырёх писем (решение 26.09.2026): вакансия → боль найма и что делает Polza
 * → доказательство → мягкое закрытие. Кейс по отрасли не подбираем
 * (SDR_ENTERPRISE_PROOF_AND_OFFER_ROUTING §2): в письмо 3 идёт утверждённая
 * фраза о ролях, до которых доходили в клиентских кампаниях (claim
 * `sdr_role_proof`), и описание процесса.
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
        subject: `про поиск клиентов для ${b}`,
        body: signed(
          paragraphs(
            'Добрый день!',
            // В образце вакансию называет {{повод}} — отдельным абзацем, как в шаблоне.
            input.opening ?? `Увидел вакансию ${title}.`,
            input.bridge,
            'Я из Polza Agency. Новые заявки можно получать каждый месяц уже сейчас, параллельно с наймом: настраиваем автоматические рассылки писем на почты подходящих компаний от вашего имени и передаём менеджеру тех, кто ответил с интересом.',
            PAY_ONCE,
            `Подскажите, кто в компании ${b} отвечает за продажи? Буду благодарен, если перешлёте ему это письмо.`,
          ),
          s,
        ),
      }
    : {
        n: 1,
        subject: `про поиск клиентов для ${b}`,
        body: signed(
          paragraphs(
            'Добрый день!',
            input.opening ?? `Увидел, что вы ищете ${title}. Я не по поводу подбора кандидата.`,
            input.bridge,
            'Я из Polza Agency. Новые заявки можно получать каждый месяц уже сейчас: настраиваем автоматические рассылки писем на почты подходящих компаний от вашего имени, ведём переписку до ответа с интересом и передаём его вашему менеджеру вместе с контекстом.',
            PAY_ONCE,
            'Есть смысл запустить это параллельно с наймом?',
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
        `${intro(s)}. На днях писал про поиск B2B-клиентов параллельно с наймом.`,
        quote ? `В вакансии ${title} указано: «${quote}».` : null,
        market,
        'Новому сотруднику нужно время, чтобы выйти на поток: собрать базу, найти ЛПР, подобрать тексты и понять, какие сегменты отвечают. Мы можем начать сразу и взять на себя первый контакт и переписку до ответа с интересом.',
        'Предлагаю созвониться на 15 минут и набросать первый тест. Если увидим, что канал вам не подходит, скажу прямо. Когда удобно?',
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
        `${intro(s, true)}. Коротко — как это выглядит на практике.`,
        roleProof?.claim_text,
        'Договариваемся о 2–3 приоритетных сегментах, собираем компании и ЛПР, пишем под каждый сегмент и передаём вашему менеджеру ответы с интересом вместе с перепиской.',
        'Могу заранее прикинуть, сколько компаний подходит под ваш портрет клиента и какой объём разумно взять в первый тест. Прислать расчёт?',
      ),
      s,
    ),
  };

  return {
    letters: [letter1, letter2, letter3, closingLetter(s)],
    subjectB: `вопрос про B2B-продажи`,
    caseId: null,
    claimIds: usedClaimIds(roleProof),
    campaignHypothesis: null,
  };
}

const AUTOMATION_MECHANISM =
  'Как это устроено: на старте один раз согласовываем аудитории и предложения, дальше база пополняется по правилам, а кампании по сегментам запускаются без ручного запуска каждой гипотезы. Заинтересованные ответы передаём вашему менеджеру вместе с перепиской — обработка лидов остаётся на вашей стороне.';

/**
 * «Автоматизированный аутрич» — тексты INSTRUCTION_03 (Максим, 22.09.2026) в
 * формате CEO из четырёх писем: новый формат → возражение «объём = хуже
 * персонализация» → кейс или механика и самоквалификация → мягкое закрытие. «Мы с вами уже общались» — только при разговоре в AMO;
 * цифры оффера — только из утверждённого claim `automation_value`.
 */
function buildAutomationChain(ctx: LetterContext, input: ChainInput): AssembledChain & { campaignHypothesis: string | null } {
  const b = q(ctx.brand);
  const s = ctx.sender;
  const value = claim(ctx, 'automation_value');
  // Повод исходной цепочки — в письме 2. В образце для писателя шаблонов
  // (input.opening) он в письме 1 обоих вариантов, как требует контракт шаблона.
  const signalBlock = input.opening !== undefined ? null : openingSentence(input, ctx.brand);
  const sampleOpening = input.opening ?? null;

  const letter1: Letter = ctx.isRouting
    ? {
        n: 1,
        subject: `новые заявки для ${b}`,
        body: signed(
          paragraphs(
            'Добрый день!',
            sampleOpening,
            input.bridge,
            'Я из Polza Agency. Помогаем получать новые заявки каждый месяц: один раз настраиваем автоматические рассылки писем на почты подходящих компаний под несколько ваших направлений, дальше база пополняется и рассылки идут сами.',
            PAY_ONCE,
            `Подскажите, кто в компании ${b} отвечает за лидогенерацию? Буду благодарен, если перешлёте ему это письмо.`,
          ),
          s,
        ),
      }
    : input.priorContact
      ? {
          n: 1,
          subject: `новые заявки для ${b}`,
          body: signed(
            paragraphs(
              'Добрый день!',
              'Мы с вами уже общались по поводу email-аутрича. Сейчас у Polza есть формат, в котором мы один раз согласовываем аудитории и предложения, настраиваем сбор базы и цепочки, а дальше кампании запускаются по заданным правилам без постоянного ручного согласования каждого запуска.',
              'Это позволяет параллельно вести несколько узких сегментов, а не одну широкую рассылку.',
              value?.claim_text,
              'Есть смысл посмотреть, как такой формат сработал бы у вас?',
            ),
            s,
          ),
        }
      : {
          n: 1,
          subject: `новые заявки для ${b}`,
          body: signed(
            paragraphs(
              'Добрый день!',
              sampleOpening,
              input.bridge,
              'Я из Polza Agency. Помогаем получать новые заявки каждый месяц: один раз настраиваем автоматические рассылки писем на почты подходящих компаний под несколько ваших направлений, дальше база пополняется и рассылки идут сами.',
              PAY_ONCE,
              value?.claim_text,
              'Есть смысл обсудить, подойдёт ли такой формат вам?',
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
        `${intro(s)}. На днях писал про автоматизацию холодных писем.`,
        signalBlock,
        'Здесь объём растёт не за счёт одной большой одинаковой рассылки. База компаний собирается и пополняется по правилам, поэтому можно параллельно вести несколько узких сегментов — каждый со своим предложением и причиной обращения.',
        'Например, отдельно можно писать компаниям, которые нанимают продавцов, выходят в новый регион или развивают партнёрский канал — это примеры, а не догадки о ваших планах.',
        'Предлагаю созвониться на 15 минут: посмотрим, какие сегменты можно выделить у вас и сколько контактов там реально есть. Когда удобно?',
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
        `${intro(s, true)}. Коротко — как это выглядит на практике.`,
        caseBlock(ctx) ?? AUTOMATION_MECHANISM,
        'Формат подходит не всем: он имеет смысл, если вы уже продаёте B2B и понимаете основные сегменты своей аудитории, хотите параллельно проверять больше гипотез и у вас есть кому обрабатывать заинтересованные ответы. Без этого дополнительный объём контактов сам по себе не даст пользы.',
        'Если это про вас, прислать короткий план первого теста?',
      ),
      s,
    ),
  };

  return {
    letters: [letter1, letter2, letter3, closingLetter(s)],
    subjectB: `автоматизированный аутрич для ${b}`,
    caseId: ctx.caseRecord?.case_id ?? null,
    claimIds: usedClaimIds(value),
    campaignHypothesis: null,
  };
}

export function buildChain(ctx: LetterContext, input: ChainInput, hypothesis: SegmentsHypothesis | null): AssembledChain & { campaignHypothesis: string | null } {
  if (input.chain === 'hiring') return buildSdrChain(ctx, input);
  if (input.chain === 'automation') return buildAutomationChain(ctx, input);
  const copy = COPY[input.chain];
  const b = q(ctx.brand);
  const s = ctx.sender;
  const opening = input.opening ?? openingSentence(input, ctx.brand);
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
            opening,
            input.bridge,
            WHAT_WE_DO,
            PAY_ONCE,
            `Подскажите, кто в компании ${b} отвечает за привлечение новых клиентов? Буду благодарен, если перешлёте ему это письмо.`,
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
            opening ?? 'Пишу коротко про новых B2B-клиентов.',
            input.bridge,
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
        `${intro(s, true)}. Коротко — как это выглядит на практике.`,
        // Образец шаблона: гипотеза отдельным абзацем перед механикой — пустая
        // гипотеза удаляется, механика остаётся.
        caseBlock(ctx) ?? (input.hypothesis !== undefined ? paragraphs(input.hypothesis, MECHANISM) : hypoText ?? MECHANISM),
        `Прислать короткий план первого теста для компании ${b}?`,
      ),
      s,
    ),
  };

  return {
    letters: [letter1, letter2, letter3, closingLetter(s)],
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

/**
 * Гипотеза сегментов письма 3 — только при подтверждённой цитате рынка.
 * timeoutMs — общий срок вызова (роут «Переписать цепочку» ограничен своим
 * таймаутом); без него — таймаут клиента по роли.
 */
export async function buildSegmentsHypothesis(
  input: {
    brand: string;
    productSummary: string | null;
    marketQuote: string;
  },
  options: { timeoutMs?: number } = {},
): Promise<SegmentsHypothesis | null> {
  // Без массива segments ответ — сбой модели: LlmCallError (раннер пишет письма
  // без гипотезы), и серию «ИИ молчит» такой ответ не обнуляет.
  const raw = await callJson(
    SEGMENTS_SYSTEM,
    [`КОМПАНИЯ: ${input.brand}`, `ЧТО ПРОДАЁТ: ${input.productSummary ?? 'не указано'}`, `ПОДТВЕРЖДЁННЫЙ РЫНОК (цитата): «${input.marketQuote}»`].join('\n'),
    'segments',
    400,
    (r) => Array.isArray(r.segments),
    options.timeoutMs,
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
