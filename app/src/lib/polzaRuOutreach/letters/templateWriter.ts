/**
 * Шаблоны цепочек «Нашего автоаутрича»: Gemini 3.1 Pro пишет цепочку один раз
 * на оффер запуска, под компанию подставляются проверенные факты (спека
 * 2026-09-26-outreach-to-sender-design.md §4, как у движка вертикалей).
 *
 * Лениво: шаблон оффера пишется, когда до писем дошла первая компания этого
 * оффера. Параллельные компании оффера ждут один и тот же промис
 * (createChainTemplates), а между процессами — воркер и роут «Переписать
 * цепочку» — строку в polza_chain_templates сначала занимают (status
 * pending), и только занявший платит писателю. Так за один оффер не платим
 * дважды.
 *
 * Вход писателю: суть оффера и цель каждого из четырёх писем, образец —
 * нынешняя цепочка CEO из chains.ts, собранная на плейсхолдерах, утверждённые
 * формулировки оффера и правила автопроверки (qa.ts). Ответ проверяет
 * runTemplateQa; провал — один повтор с замечаниями, снова провал — шаблон
 * failed, компании оффера уходят в «очень спорные», а у оффера на экране —
 * кнопка «Переписать цепочку».
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { callOutreachJson, outreachWorstCaseUsd, type OutreachLlmUsage } from '@/lib/outreachLlm/client';
import { BudgetExceededError, LlmAuthError, LlmCallError } from '@/lib/outreachLlm/context';
import { claimsForChain, formatSignature, type CaseRecord, type OfferClaim, type SenderProfile } from '../libraries';
import { describeTemplateFlag, runTemplateQa, type TemplateQaInput } from '../qa';
import {
  CHAIN_LABELS,
  TEMPLATE_PLACEHOLDERS,
  TEMPLATE_SIGN_OFF,
  chainUsesCase,
  chainUsesHypothesis,
  templatePlaceholdersFor,
  type ChainTemplateLetters,
  type ChainType,
  type Signal,
} from '../types';
import { buildChain, openingSentence, type ChainInput } from './chains';
import { intro, type LetterContext } from './common';

const P = TEMPLATE_PLACEHOLDERS;
const TABLE = 'polza_chain_templates';
const LANG = 'ru';
const ROW_COLUMNS = 'id,offer_key,status,letters,qa_flags,model,cost_usd,attempt,error,updated_at';

/** Первая попытка и одна повторная — с замечаниями автопроверки. */
const MAX_WRITER_ATTEMPTS = 2;
/**
 * Меньше этого до срока (роут «Переписать цепочку») повторную попытку не
 * начинаем: Gemini не успеет, а оборванный запрос всё равно оплачен (как
 * MIN_ATTEMPT_MS писателя в outreachLlm/client.ts).
 */
const WRITER_MIN_ATTEMPT_MS = 60_000;
/**
 * Лимит токенов ответа писателя. Gemini считает в нём и скрытые рассуждения:
 * шесть писем шаблона с рассуждениями в 8000 по умолчанию могут не влезть, а
 * обрезанный ответ оплачен и выброшен. Платим только за написанное, поэтому
 * запас сверху ничего не стоит; обрезанный всё же — клиент повторит с 16000.
 */
const WRITER_MAX_TOKENS = 12_000;
/**
 * Длина промпта писателя для оценки сверху, пока сам промпт не собран (запас
 * лимита под шаблоны считается на старте запуска). Первая попытка — system и
 * задание с образцом цепочки, 6–8 тысяч символов; берём с запасом на длинные
 * утверждённые формулировки.
 */
const WRITER_PROMPT_CHARS_ESTIMATE = 12_000;

/**
 * Оценка сверху одной попытки писателя: промпт и WRITER_MAX_TOKENS ответа по
 * цене модели писателя (Gemini 3.1 Pro — около $0.14). Столько клиент
 * бронирует в лимите на ИИ под каждый вызов писателя.
 */
export function writerAttemptWorstUsd(): number {
  return outreachWorstCaseUsd(LANG, 'writer', WRITER_PROMPT_CHARS_ESTIMATE, WRITER_MAX_TOKENS);
}
/**
 * Срок одного вызова писателя в воркере — со всеми повторами транспорта.
 * Gemini отвечает за 20–60 с; без срока зависший Requesty держал бы компании
 * оффера до 15 минут.
 */
export const WORKER_WRITER_TIMEOUT_MS = 300_000;
/**
 * В роуте «Переписать цепочку» — меньше: пользователь ждёт ответа на экране,
 * а у прокси 300 с на запрос. Два вызова (попытка и повтор) — около 200 с,
 * остальное — на пересборку писем.
 */
export const ROUTE_WRITER_TIMEOUT_MS = 100_000;
/**
 * Строка pending дольше этого — занявший процесс умер (перезапуск воркера или
 * Next посреди записи): её можно занять заново. Больше двух вызовов писателя
 * в воркере (2 × 5 мин).
 */
export const PENDING_STALE_MS = 15 * 60_000;
const POLL_MS = 5_000;

export interface ChainTemplate {
  id: string;
  chain: ChainType;
  status: 'ok' | 'failed';
  /** Письма шаблона; у failed — последний вариант писателя (на экран), если он был. */
  letters: ChainTemplateLetters | null;
  qaFlags: string[];
  /** Почему шаблона нет совсем: ИИ не ответил, лимит на ИИ, ключ. */
  error: string | null;
  model: string | null;
  /** Все попытки шаблона, включая прошлые «Переписать цепочку». */
  costUsd: number;
  /** Сколько раз писатель писал этот шаблон. */
  attempt: number;
}

export interface TemplateWriterDeps {
  /** Воркер — service role; роут — клиент пользователя (RLS: его запуски). */
  db: SupabaseClient;
  jobId: string;
  sender: SenderProfile;
  claims: OfferClaim[];
  /** Срок одного вызова писателя (со всеми повторами транспорта). */
  writerTimeoutMs: number;
  /**
   * Общий срок записи шаблона (Date.now()), обе попытки: роуту надо уложиться
   * в свой таймаут. Повтор, которому не хватит минуты, не начинается.
   */
  deadlineAt?: number;
  /** Остановка запуска: обрывает вызов писателя, строка шаблона освобождается. */
  signal?: AbortSignal;
}

interface TemplateRow {
  id: string;
  offer_key: string;
  status: string;
  letters: unknown;
  qa_flags: string[] | null;
  model: string | null;
  cost_usd: number | string | null;
  attempt: number | null;
  error: string | null;
  updated_at: string;
}

function log(level: 'info' | 'warn', msg: string): void {
  console[level](`[polza-ru-outreach][templates][${level.toUpperCase()}] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function roundUsd(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/* ─────────────────────────── Промпт писателя ─────────────────────────── */

interface OfferBrief {
  essence: string;
  goals: [string, string, string, string];
}

const LETTER3_CEO =
  'показать на примере, как это выглядит: в варианте с кейсом — кейс, в варианте без кейса — гипотеза сегментов ({{гипотеза}}) и механика первого теста; предложить прислать короткий план первого теста';
const LETTER4 =
  'мягкое закрытие: последнее письмо, не хочу надоедать; не актуально — вернусь позже; занимается другой человек — к кому обратиться; вопрос: актуально сейчас или лучше вернуться позже';

/** Суть оффера и цель каждого письма — пересказ цепочек CEO и Максима из chains.ts. */
const OFFER_BRIEFS: Record<ChainType, OfferBrief> = {
  reactivation: {
    essence:
      'С компанией уже был записанный разговор в AMO, тогда не сложилось. Возвращаемся не с тем же предложением: теперь начинаем с узких сегментов и конкретного повода для обращения к каждой компании (вакансии, выставки, новые филиалы), а не с одной общей рассылки.',
    goals: [
      'напомнить о прошлом разговоре ({{повод}}) и сказать, что изменилось в подходе; спросить, есть ли смысл посмотреть свежую гипотезу',
      'предложить начать с малого: 2–3 узких сегмента, в каждом свой повод для письма, и отчёт по ответам; сегмент не отвечает — меняем гипотезу, а не повторяем рассылку; предложить созвон на 15 минут, чтобы выбрать сегменты',
      LETTER3_CEO,
      LETTER4,
    ],
  },
  hiring: {
    essence:
      'Компания ищет SDR/BDR — сотрудника для холодного поиска B2B-клиентов. Мы пишем не по поводу подбора кандидата: Polza Agency ведёт внешний email-outreach от лица компании — подбирает компании, находит ЛПР, берёт на себя первичный контакт и переписку до заинтересованного ответа и передаёт ответ менеджеру с контекстом. Это можно запустить параллельно с наймом.',
    goals: [
      'повод — вакансия ({{повод}} уже говорит о ней и о том, что мы не по поводу подбора кандидата, — не повторяй это); коротко, что делает Polza; спросить, есть ли смысл коротко обсудить, как это проверить',
      'новому сотруднику нужно время выйти на поток: собрать базу, найти ЛПР, подобрать тексты, понять, какие сегменты отвечают; внешний outbound можно запустить параллельно с наймом; предложить созвон на 15 минут и черновик первого теста',
      'доказательство: утверждённая формулировка о ролях, до которых доходили в клиентских кампаниях (если она есть в списке), и процесс работы; предложить прикинуть потенциал: сколько компаний подходит под портрет клиента и какой объём взять в первый тест',
      LETTER4,
    ],
  },
  ad_budget: {
    essence:
      'Компания даёт рекламу в Яндексе. Реклама ловит тех, кто уже ищет подрядчика; Polza работает с другой частью рынка — компаниями, которые подходят по профилю, но сами пока не ищут: находим их ЛПР и пишем им от лица компании. Это дополнение к рекламе, а не замена.',
    goals: [
      '{{повод}} — реклама; чем холодный аутрич дополняет рекламу; спросить, есть ли смысл обсудить',
      'у рекламы есть предел: когда спрос в поиске выбран, каждый следующий клиент обходится дороже; аутрич от поискового спроса не зависит — сами выбираем сегменты, собираем компании и ЛПР, заинтересованные ответы передаём менеджеру с перепиской; предложить созвон на 15 минут',
      LETTER3_CEO,
      LETTER4,
    ],
  },
  event: {
    essence:
      'Компания участвует в выставке. Вокруг выставки удобно выходить к ЛПР: собираем компании её рынка, находим ответственных и пишем им от лица компании — до события, чтобы договориться о встречах, или после, чтобы продолжить контакты.',
    goals: [
      '{{повод}} — выставка; как письма помогают выйти к ЛПР вокруг неё; спросить, есть ли смысл обсудить',
      'на выставке успеваешь поговорить только с частью рынка, остальные остаются без контакта — их можно добрать письмами с конкретным поводом; заинтересованные ответы передаём менеджеру; предложить созвон на 15 минут',
      LETTER3_CEO,
      LETTER4,
    ],
  },
  growth_event: {
    essence:
      'У компании событие роста: новый продукт, регион, филиал, контракт, тендер, грант, рост выручки. После такого нужно быстро проверить, где ещё есть спрос: Polza находит B2B-компании под продукт, выходит на их ЛПР письмами от лица компании и передаёт заинтересованные ответы менеджеру.',
    goals: [
      '{{повод}} — событие роста; зачем после него быстро проверить спрос и что делает Polza; спросить, есть ли смысл обсудить такой тест',
      'новому продукту, региону или проекту нужны первые клиенты, а входящий поток на старте небольшой; outbound позволяет не ждать: 2–3 сегмента, компании и ЛПР, быстро видно, какие откликаются; предложить созвон на 15 минут',
      LETTER3_CEO,
      LETTER4,
    ],
  },
  icp_only: {
    essence:
      'Особого повода нет — компания похожа на клиентов Polza: продаёт B2B и понятно кому. Предлагаем холодный email-аутрич как канал привлечения B2B-клиентов: выбираем сегменты, собираем компании и ЛПР, каждому пишем с конкретным поводом, заинтересованные ответы передаём отделу продаж вместе с перепиской.',
    goals: [
      'что делает Polza ({{повод}}, если есть, — цитата с сайта компании о её рынке); спросить, есть ли смысл обсудить такой канал привлечения клиентов',
      'холодные письма часто считают массовой рассылкой — у нас наоборот: сегменты, компании и ЛПР, каждому письмо с поводом; предложить созвон на 15 минут, чтобы прикинуть объём доступной базы',
      LETTER3_CEO,
      LETTER4,
    ],
  },
  automation: {
    essence:
      '«Автоматизированный аутрич»: один раз согласовываем аудитории и предложения, дальше база компаний пополняется по правилам, а кампании по нескольким узким сегментам идут без ручного запуска каждой гипотезы — у каждого сегмента своё предложение и причина обращения. Формат подходит не всем: нужен B2B, понятные основные сегменты и кому обрабатывать заинтересованные ответы.',
    goals: [
      'новый формат ({{повод}} — повод компании, если он есть): автоматизированный email-outreach по нескольким узким B2B-сегментам; спросить, есть ли смысл обсудить применимость формата',
      'объём растёт не за счёт одной большой одинаковой рассылки: база и сегменты по правилам, у каждого сегмента своё предложение; примеры сегментации — не утверждения о планах компании; предложить созвон на 15 минут',
      'доказательство: в варианте с кейсом — кейс, без кейса — механика формата; кому формат подходит, а кому нет; предложить прислать короткий план первого теста',
      LETTER4,
    ],
  },
};

const EXAMPLE_BRAND = 'Альфа';
/**
 * Приметные куски примеров {{повод}} — в шаблон они попасть не должны: это
 * чужая компания в письме всем компаниям оффера (runTemplateQa, example_leak).
 * Общие слова примеров («поиск и привлечение новых B2B-клиентов») сюда не
 * входят — их шаблон может сказать и сам.
 */
const EXAMPLE_FRAGMENTS = [
  EXAMPLE_BRAND,
  'оборудование для складов',
  'Металлообработка',
  'филиал в Казани',
  'Менеджер по активным продажам',
  'складского оборудования',
  'пищевых производств',
];

/** Как выглядит {{повод}} у этого оффера — из того же openingSentence, что подставит его компаниям. */
function openingExamples(chain: ChainType): string[] {
  const signal = (type: Signal['type'], source: Signal['source'], title: string, extra: Partial<Signal> = {}): Signal => ({
    type, source, title, date: null, url: null, quote: null, level: 'B', ...extra,
  });
  const base: ChainInput = { chain, signal: null, priorContact: false, marketQuote: null, productSummary: null };
  const ad = signal('ad_running', 'direct', 'оборудование для складов', { meta: { keyword: 'оборудование для складов' } });
  const news = signal('new_office', 'news', 'Альфа открыла филиал в Казани', { quote: 'Альфа открыла филиал в Казани', level: 'A' });
  const byChain: Record<ChainType, ChainInput[]> = {
    reactivation: [{ ...base, priorContact: true }],
    hiring: [{ ...base, signal: signal('sales_hiring', 'hh', 'Менеджер по активным продажам', { quote: 'поиск и привлечение новых B2B-клиентов', level: 'A' }) }],
    ad_budget: [{ ...base, signal: ad }],
    event: [{ ...base, signal: signal('trade_show_exhibitor', 'exhibitors', 'Металлообработка') }],
    growth_event: [{ ...base, signal: news }, { ...base, signal: signal('tender_won', 'tenders', 'поставка складского оборудования') }],
    icp_only: [{ ...base, marketQuote: 'поставляем оборудование для пищевых производств по всей России' }],
    automation: [{ ...base, baseChain: 'ad_budget', signal: ad }, { ...base, baseChain: 'reactivation', priorContact: true }],
  };
  const inputs = byChain[chain];
  return inputs.map((input) => openingSentence(input, EXAMPLE_BRAND)).filter((s): s is string => Boolean(s));
}

/**
 * Образец — нынешняя цепочка оффера, собранная на плейсхолдерах в режиме
 * образца (chains.ts: повод — в письме 1 обоих вариантов, гипотеза — абзацем
 * перед механикой), то есть сам по себе правильный шаблон: runTemplateQa его
 * пропускает, и писатель не учится на образце тому, за что его потом
 * завернёт проверка. Отправитель настоящий: так он представляется в письмах
 * 2–3, а это одинаково для всех компаний запуска.
 */
export function sampleTemplate(chain: ChainType, sender: SenderProfile, claims: OfferClaim[]): ChainTemplateLetters {
  const sampleCase: CaseRecord = { case_id: 'sample', public_name: '', industry_groups: [], allowed_chains: [], case_text_short: P.case };
  const input: ChainInput = {
    chain,
    signal: null,
    priorContact: chain === 'reactivation',
    marketQuote: null,
    productSummary: null,
    baseChain: chain === 'automation' ? 'growth_event' : undefined,
    opening: P.opening,
    hypothesis: chainUsesHypothesis(chain) ? P.hypothesis : undefined,
  };
  const ctx = (isRouting: boolean, caseRecord: CaseRecord | null): LetterContext => ({
    brand: P.brand, sender, isRouting, caseRecord, claims: claimsForChain(claims, chain),
  });
  const direct = buildChain(ctx(false, chainUsesCase(chain) ? sampleCase : null), input, null).letters;
  const routing = buildChain(ctx(true, null), input, null).letters;
  const noCase = buildChain(ctx(false, null), input, null).letters;
  const signature = formatSignature(sender);
  const text = (body: string) => body.split(signature).join(P.signature);
  return {
    subject: direct[0].subject,
    bodyDirect: text(direct[0].body),
    bodyRouting: text(routing[0].body),
    letter2: text(direct[1].body),
    bodyWithCase: chainUsesCase(chain) ? text(direct[2].body) : null,
    bodyWithoutCase: text(noCase[2].body),
    letter4: text(direct[3].body),
  };
}

function sampleText(sample: ChainTemplateLetters): string {
  return [
    `ТЕМА ПИСЬМА 1: ${sample.subject}`,
    '',
    'ПИСЬМО 1 — ЛИЧНО (почта ЛПР):',
    sample.bodyDirect,
    '',
    'ПИСЬМО 1 — «ПЕРЕШЛИТЕ ОТВЕТСТВЕННОМУ» (общая почта):',
    sample.bodyRouting,
    '',
    'ПИСЬМО 2:',
    sample.letter2,
    '',
    ...(sample.bodyWithCase !== null ? ['ПИСЬМО 3 — С КЕЙСОМ:', sample.bodyWithCase, ''] : []),
    'ПИСЬМО 3 — БЕЗ КЕЙСА:',
    sample.bodyWithoutCase,
    '',
    'ПИСЬМО 4:',
    sample.letter4,
  ].join('\n');
}

const WRITER_SYSTEM = [
  'Ты пишешь холодные письма для Polza Agency — агентства B2B email-outreach: мы подбираем компании под продукт клиента, находим в них ЛПР, пишем им от лица клиента и передаём заинтересованные ответы его менеджеру вместе с перепиской.',
  'Нужен ШАБЛОН цепочки из четырёх писем для одного оффера. Шаблон один на все компании оффера: под каждую компанию код заменит только плейсхолдеры, весь остальной текст уйдёт как есть. Поэтому в тексте нет ничего о конкретной компании, кроме плейсхолдеров.',
  '',
  'ПЛЕЙСХОЛДЕРЫ — ровно в таком написании, других {{…}} не бывает:',
  '{{бренд}} — название компании-получателя. Пиши его в кавычках-ёлочках: «{{бренд}}».',
  '{{повод}} — готовая фраза-повод из проверенных фактов о компании: одно-два законченных предложения с точкой. Только в письме 1. Бывает пустой, тогда её абзац удаляется. Ставь её отдельным абзацем (пустая строка до и после, без другого текста), письмо должно читаться и без неё; её смысл своими словами не повторяй.',
  '{{кейс}} — утверждённый текст кейса клиента Polza со строчной буквы, вставляется дословно. Пиши: «Для примера: {{кейс}}».',
  '{{гипотеза}} — два-четыре предложения гипотезы первых сегментов для компании. Бывает пустой — ставь отдельным абзацем без другого текста.',
  '{{подпись}} — подпись отправителя в несколько строк.',
  '',
  'ПРАВИЛА:',
  '1. Каждое письмо начинается строкой «Добрый день!» и заканчивается ровно так: «С уважением,», перевод строки, «{{подпись}}».',
  '2. Абзацы разделяй пустой строкой.',
  '3. В каждом письме ровно один вопросительный знак — один призыв к действию.',
  '4. У письма 1 есть тема: коротко, со строчной буквы, без «!» и «?», без слов «резюме», «кандидат», «отклик». Письма 2–4 — ответы в той же ветке, без темы.',
  '5. Цифры — только «15 минут», «2–3» перед словом «сегмент» («2–3 сегмента», «2–3 узких сегмента») и цифры внутри утверждённых формулировок (их вставляй только дословно). Числа словами тоже нельзя: «десятки», «сотни», «тысячи», «вдвое», «втрое», «в N раз». Не обещай сроков и результатов: никаких «неделя», «месяц», «квартал», «процент». Не выдумывай результаты, объёмы, число клиентов.',
  '6. О компании-получателе — ничего сверх {{повод}}: не додумывай её рынок, клиентов, планы и проблемы. Боль — общее наблюдение о канале, а не диагноз получателю.',
  '7. Никаких намёков на прошлый контакт — «мы с вами уже общались», «ранее обсуждали», «переписывались», «созванивались», «наш разговор», «наша встреча» — кроме оффера «Возврат». Если разговор был, о нём скажет {{повод}}.',
  '8. Нельзя слов с корнями «срочн» и «гарант» — даже с отрицанием («не срочно», «без гарантий» тоже нельзя). Нельзя давить дефицитом («последний шанс», «осталось N мест»), писать «уникальный», «мы лучшие», «революционный», эмодзи, восклицательные знаки (кроме «Добрый день!»), разметку markdown и служебные слова (score, pipeline, ICP, LLM, evidence, JSON, null, TODO, скоринг).',
  '9. Тон — как в образце: коротко, по-деловому, от первого лица отправителя, без канцелярита. Письмо 4 — самое короткое.',
  `10. Примеры из задания (компания «${EXAMPLE_BRAND}» и её поводы) — только чтобы понять, что подставит код; в шаблон их не переносить.`,
  '',
  'Ответ — строгий JSON-объект по формату из сообщения, без markdown и пояснений.',
].join('\n');

function contractText(chain: ChainType): string {
  const letter3 = chainUsesCase(chain)
    ? '{"n":3,"body_with_case":"…","body_without_case":"…"}'
    : '{"n":3,"body_without_case":"…"}';
  return [
    '{"letters":[',
    '  {"n":1,"subject":"…","body_direct":"…","body_routing":"…"},',
    '  {"n":2,"body":"…"},',
    `  ${letter3},`,
    '  {"n":4,"body":"…"}]}',
  ].join('\n');
}

interface RetryNote {
  flags: string[];
  previous: unknown;
}

function writerUserPrompt(chain: ChainType, sender: SenderProfile, claims: OfferClaim[], retry: RetryNote | null): string {
  const brief = OFFER_BRIEFS[chain];
  const chainClaims = claimsForChain(claims, chain);
  const places = [
    `${P.opening} — в письме 1, в обоих вариантах, и больше нигде`,
    ...(chainUsesCase(chain) ? [`${P.case} — только в письме 3 «с кейсом»`] : []),
    ...(chainUsesHypothesis(chain) ? [`${P.hypothesis} — только в письме 3 «без кейса», отдельным абзацем`] : []),
    `${P.signature} — в конце каждого письма`,
  ];
  const lines = [
    `ОФФЕР: ${CHAIN_LABELS[chain]}`,
    `СУТЬ: ${brief.essence}`,
    'ЦЕЛИ ПИСЕМ:',
    ...brief.goals.map((goal, i) => `${i + 1} — ${goal}`),
    'body_routing — для общей почты (info@, office@): письмо читает не ЛПР — спроси, кто отвечает за продажи и привлечение клиентов, коротко объясни суть и попроси переслать письмо ответственному или подсказать его контакт.',
    '',
    `ПЛЕЙСХОЛДЕРЫ ЭТОГО ОФФЕРА: ${templatePlaceholdersFor(chain).join(', ')}.`,
    ...(!chainUsesCase(chain) ? [`${P.case} этому офферу не подбирается: плейсхолдера нет, и письма 3 «с кейсом» тоже.`] : []),
    ...(!chainUsesHypothesis(chain) ? [`${P.hypothesis} в этом оффере не используется.`] : []),
    `ОБЯЗАТЕЛЬНО: ${places.join('; ')}.`,
    `${P.opening} у этого оффера выглядит так (пример для компании «${EXAMPLE_BRAND}» — в шаблон не переносить):`,
    ...openingExamples(chain).map((example) => `— ${example}`),
    '',
    `ОТПРАВИТЕЛЬ: ${intro(sender)} — так он представляется в письмах 2–3, как в образце; другого имени не пиши.`,
    'УТВЕРЖДЁННЫЕ ФОРМУЛИРОВКИ (вставлять только дословно; цифры — только из них):',
    ...(chainClaims.length ? chainClaims.map((c) => `— ${c.claim_text}`) : ['— нет: пиши без цифр.']),
    '',
    'ОБРАЗЕЦ — нынешняя цепочка этого оффера, тексты согласованы с CEO. Держись их смысла, порядка и тона; формулировки можно улучшать:',
    sampleText(sampleTemplate(chain, sender, claims)),
    '',
    'ФОРМАТ ОТВЕТА — JSON:',
    contractText(chain),
    'Внутри строк JSON абзацы разделяй \\n\\n, а «С уважением,» и {{подпись}} — одним \\n.',
  ];
  if (retry) {
    lines.push(
      '',
      'ПРОШЛЫЙ ВАРИАНТ НЕ ПРОШЁЛ ПРОВЕРКУ. Исправь все замечания и верни цепочку целиком:',
      ...retry.flags.map((flag) => `— ${describeTemplateFlag(flag)}`),
      'Прошлый вариант:',
      JSON.stringify(retry.previous),
    );
  }
  return lines.join('\n');
}

/* ─────────────────────────── Разбор ответа ─────────────────────────── */

/** Тело письма: переводы строк, хвостовые пробелы и концовка с подписью — в одном виде. */
function normalizeBody(value: unknown): string {
  if (typeof value !== 'string') return '';
  let text = value.replace(/\r\n?/g, '\n');
  // Модель иногда экранирует перевод строки дважды — в тексте остаётся «\n».
  if (!text.includes('\n') && text.includes('\\n')) text = text.replace(/\\n/g, '\n');
  text = text.replace(/[ \t]+\n/g, '\n').trim();
  // «С уважением,» и подпись через пустую строку или с пробелами — та же концовка.
  return text.replace(/С уважением,?[ \t]*\n\s*\{\{подпись\}\}$/, TEMPLATE_SIGN_OFF);
}

/**
 * Письма шаблона из ответа писателя или из строки базы (тот же контракт).
 * Нет массива letters — null; недостающее поле — пустая строка, её поймает
 * runTemplateQa («текст пустой»).
 */
export function parseTemplateLetters(raw: unknown, chain: ChainType): ChainTemplateLetters | null {
  const list = raw && typeof raw === 'object' ? (raw as { letters?: unknown }).letters : undefined;
  const items: unknown[] | null = Array.isArray(list) ? list : list && typeof list === 'object' ? Object.values(list) : null;
  if (!items) return null;
  const byN = new Map<number, Record<string, unknown>>();
  items.forEach((item, i) => {
    if (!item || typeof item !== 'object') return;
    const n = Number((item as { n?: unknown }).n ?? i + 1);
    if (!byN.has(n)) byN.set(n, item as Record<string, unknown>);
  });
  const field = (n: number, key: string) => normalizeBody(byN.get(n)?.[key]);
  return {
    subject: field(1, 'subject').replace(/\s+/g, ' '),
    bodyDirect: field(1, 'body_direct'),
    bodyRouting: field(1, 'body_routing'),
    letter2: field(2, 'body'),
    bodyWithCase: chainUsesCase(chain) ? field(3, 'body_with_case') : null,
    bodyWithoutCase: field(3, 'body_without_case'),
    letter4: field(4, 'body'),
  };
}

/** Письма шаблона в контракт писателя — так они лежат в polza_chain_templates.letters. */
export function templateLettersToJson(t: ChainTemplateLetters): Array<Record<string, unknown>> {
  return [
    { n: 1, subject: t.subject, body_direct: t.bodyDirect, body_routing: t.bodyRouting },
    { n: 2, body: t.letter2 },
    t.bodyWithCase === null
      ? { n: 3, body_without_case: t.bodyWithoutCase }
      : { n: 3, body_with_case: t.bodyWithCase, body_without_case: t.bodyWithoutCase },
    { n: 4, body: t.letter4 },
  ];
}

function senderTexts(sender: SenderProfile): string[] {
  return [sender.sender_name, sender.company_name, intro(sender), intro(sender, true)];
}

/* ─────────────────────────── Строка в базе ─────────────────────────── */

function isStale(row: TemplateRow): boolean {
  const t = Date.parse(row.updated_at);
  return !Number.isFinite(t) || Date.now() - t > PENDING_STALE_MS;
}

function templateFromRow(row: TemplateRow, chain: ChainType): ChainTemplate {
  const letters = row.letters ? parseTemplateLetters({ letters: row.letters }, chain) : null;
  const ok = row.status === 'ok' && letters !== null;
  return {
    id: row.id,
    chain,
    status: ok ? 'ok' : 'failed',
    letters,
    qaFlags: row.qa_flags ?? [],
    error: row.error ?? (row.status === 'ok' && !letters ? 'письма шаблона в базе не разбираются' : null),
    model: row.model,
    costUsd: Number(row.cost_usd ?? 0) || 0,
    attempt: Number(row.attempt ?? 0) || 0,
  };
}

async function readRow(db: SupabaseClient, jobId: string, chain: ChainType): Promise<TemplateRow | null> {
  const { data, error } = await db.from(TABLE).select(ROW_COLUMNS).eq('job_id', jobId).eq('lang', LANG).eq('offer_key', chain).maybeSingle();
  if (error) throw new Error(`Не удалось прочитать цепочку оффера «${chain}»: ${error.message}`);
  return (data as TemplateRow | null) ?? null;
}

/**
 * Первая генерация оффера в запуске: строка сразу вставляется pending — она
 * наша. Уже есть (её занял другой процесс) — null: insert … on conflict do
 * nothing возвращает только вставленное.
 */
async function claimNew(db: SupabaseClient, jobId: string, chain: ChainType): Promise<TemplateRow | null> {
  const { data, error } = await db
    .from(TABLE)
    .upsert(
      {
        job_id: jobId, lang: LANG, offer_key: chain, status: 'pending', letters: null, qa_flags: [],
        cost_usd: 0, attempt: 1, error: null, updated_at: new Date().toISOString(),
      },
      { onConflict: 'job_id,lang,offer_key', ignoreDuplicates: true },
    )
    .select(ROW_COLUMNS);
  if (error) throw new Error(`Не удалось занять цепочку оффера «${chain}»: ${error.message}`);
  return ((data ?? []) as TemplateRow[])[0] ?? null;
}

/**
 * Новая попытка на готовой строке: failed, ok (перечитать не удалось) или
 * pending, чей процесс умер. Условие по attempt и статусу — сравнение с
 * обменом: из двух одновременных попыток строку займёт одна, вторая получит
 * null и платить не будет.
 */
async function claimExisting(db: SupabaseClient, row: TemplateRow): Promise<TemplateRow | null> {
  const attempt = Number(row.attempt ?? 0) || 0;
  const base = db
    .from(TABLE)
    .update({ status: 'pending', attempt: attempt + 1, error: null, updated_at: new Date().toISOString() })
    .eq('id', row.id)
    .eq('attempt', attempt);
  const query = row.status === 'pending'
    ? base.eq('status', 'pending').lt('updated_at', new Date(Date.now() - PENDING_STALE_MS).toISOString())
    : base.neq('status', 'pending');
  const { data, error } = await query.select(ROW_COLUMNS);
  if (error) throw new Error(`Не удалось занять цепочку оффера «${row.offer_key}»: ${error.message}`);
  return ((data ?? []) as TemplateRow[])[0] ?? null;
}

/**
 * Итог в строку — только пока она наша (pending с нашей попыткой): если её
 * заняли заново как зависшую, чужой результат не перетираем. Сбой записи —
 * ещё раз; не вышло — шаблон всё равно отдаём запуску: он оплачен.
 */
async function finishRow(db: SupabaseClient, claimed: TemplateRow, patch: Record<string, unknown>): Promise<boolean> {
  for (let i = 0; i < 2; i += 1) {
    const { data, error } = await db
      .from(TABLE)
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', claimed.id)
      .eq('status', 'pending')
      .eq('attempt', Number(claimed.attempt ?? 0) || 0)
      .select('id');
    if (!error) return Boolean(data?.length);
    log('warn', `template ${claimed.id} save failed: ${error.message}`);
  }
  return false;
}

/* ─────────────────────────── Генерация ─────────────────────────── */

/**
 * Писатель пишет шаблон в занятую строку: попытка, проверка, при провале —
 * повтор с замечаниями. Итог — в строку. Лимит на ИИ, ключ и прочие
 * непредвиденные ошибки освобождают строку (failed с текстом) и летят дальше:
 * они про весь запуск, а не про оффер.
 */
/**
 * Вход проверки шаблона оффера, кроме самих писем: утверждённые формулировки,
 * представление отправителя, примеры из промпта. Один для ответа писателя и
 * для образца (sampleTemplate) — образец обязан проходить ту же проверку.
 */
export function templateQaInput(chain: ChainType, sender: SenderProfile, claims: OfferClaim[]): Omit<TemplateQaInput, 'letters'> {
  return {
    chain,
    claimTexts: claimsForChain(claims, chain).map((c) => c.claim_text),
    senderTexts: senderTexts(sender),
    exampleTexts: [...EXAMPLE_FRAGMENTS, ...openingExamples(chain)],
  };
}

async function writeTemplate(deps: TemplateWriterDeps, chain: ChainType, claimed: TemplateRow): Promise<ChainTemplate> {
  const qaInput = templateQaInput(chain, deps.sender, deps.claims);
  const firstAttempt = Number(claimed.attempt ?? 1) || 1;
  let cost = 0;
  let model = claimed.model;
  let calls = 0;
  let letters: ChainTemplateLetters | null = null;
  let flags: string[] = [];
  let error: string | null = null;
  let fatal: unknown = null;
  let retry: RetryNote | null = null;
  const onUsage = (usage: OutreachLlmUsage) => {
    cost += usage.costUsd;
    model = usage.model;
  };
  try {
    for (let attempt = 1; attempt <= MAX_WRITER_ATTEMPTS; attempt += 1) {
      const left = deps.deadlineAt === undefined ? Infinity : deps.deadlineAt - Date.now();
      if (attempt > 1 && left < WRITER_MIN_ATTEMPT_MS) {
        // Повтор не успеет до срока роута: шаблон failed с замечаниями первой
        // попытки, «Переписать цепочку» можно нажать ещё раз.
        log('warn', `job ${deps.jobId}: chain ${chain} retry skipped — ${Math.round(left / 1000)} s left before the deadline`);
        break;
      }
      calls += 1;
      const raw = await callOutreachJson({
        role: 'writer',
        system: WRITER_SYSTEM,
        user: writerUserPrompt(chain, deps.sender, deps.claims, retry),
        title: `chain-${chain}`,
        maxTokens: WRITER_MAX_TOKENS,
        lang: LANG,
        onUsage,
        timeoutMs: Math.min(deps.writerTimeoutMs, Math.max(1, left)),
        signal: deps.signal,
      });
      letters = parseTemplateLetters(raw, chain);
      flags = letters ? runTemplateQa({ ...qaInput, letters }).flags : ['letters_missing'];
      if (!flags.length) break;
      log('warn', `job ${deps.jobId}: chain ${chain} attempt ${attempt} failed QA: ${flags.join(', ')}`);
      retry = { flags, previous: raw };
    }
  } catch (err) {
    if (deps.signal?.aborted) {
      // Запуск остановили посреди записи: строку освобождаем, остановку — дальше.
      fatal = err;
      error = 'запуск остановлен, цепочка не дописана';
    } else if (err instanceof LlmCallError) {
      // Клиент уже повторил сеть, 5xx и битый JSON — третий раз писать не просим.
      error = `ИИ не ответил: ${err.message}`;
    } else {
      fatal = err;
      error = err instanceof BudgetExceededError
        ? 'лимит на ИИ исчерпан раньше, чем цепочка была написана'
        : err instanceof Error ? err.message : String(err);
    }
  }
  const ok = !error && letters !== null && flags.length === 0;
  const template: ChainTemplate = {
    id: claimed.id,
    chain,
    status: ok ? 'ok' : 'failed',
    letters,
    qaFlags: flags,
    error,
    model,
    costUsd: roundUsd((Number(claimed.cost_usd ?? 0) || 0) + cost),
    attempt: firstAttempt + Math.max(0, calls - 1),
  };
  const saved = await finishRow(deps.db, claimed, {
    status: template.status,
    letters: letters ? templateLettersToJson(letters) : null,
    qa_flags: flags,
    model,
    cost_usd: template.costUsd,
    attempt: template.attempt,
    error: error ? error.slice(0, 1000) : null,
  });
  if (!saved) log('warn', `job ${deps.jobId}: chain ${chain} result not saved (row ${claimed.id} was taken over or the DB failed)`);
  log('info', `job ${deps.jobId}: chain ${chain} ${template.status} after ${calls} writer call(s), $${cost.toFixed(4)}${error ? ` — ${error}` : ''}`);
  if (fatal) throw fatal;
  return template;
}

/**
 * Шаблон оффера для воркера: своя строка или готовая чужая. Чужую pending
 * (её пишет другой процесс) ждём, пока допишет; умер — занимаем заново.
 * retryFailed — повтор после «ИИ не ответил»: failed-строку занимаем заново
 * (со сравнением, как «Переписать цепочку»), а не отдаём как есть.
 */
async function obtainTemplate(deps: TemplateWriterDeps, chain: ChainType, retryFailed = false): Promise<ChainTemplate> {
  const deadline = Date.now() + PENDING_STALE_MS + 2 * POLL_MS;
  for (;;) {
    // Запуск остановили, пока ждали чужую запись, — не ждём дальше.
    deps.signal?.throwIfAborted();
    const claimed = await claimNew(deps.db, deps.jobId, chain);
    if (claimed) return writeTemplate(deps, chain, claimed);
    const row = await readRow(deps.db, deps.jobId, chain);
    if (row && row.status === 'failed' && retryFailed) {
      const taken = await claimExisting(deps.db, row);
      if (taken) return writeTemplate(deps, chain, taken);
      // Занял кто-то другой — дождёмся его итога на следующем круге.
      await sleep(POLL_MS);
      continue;
    }
    if (row && row.status !== 'pending') return templateFromRow(row, chain);
    if (row && isStale(row)) {
      const taken = await claimExisting(deps.db, row);
      if (taken) return writeTemplate(deps, chain, taken);
    }
    if (Date.now() > deadline) {
      throw new Error(`Цепочка оффера «${chain}» не дописана другим процессом за ${Math.round(PENDING_STALE_MS / 60_000)} мин`);
    }
    await sleep(POLL_MS);
  }
}

export interface ChainTemplates {
  get(chain: ChainType): Promise<ChainTemplate>;
  /**
   * Офферы, чей шаблон не написан из-за молчания модели (ошибка, а не
   * замечания проверки), — забыть и занять заново. Один раз на оффер за
   * запуск: раннер зовёт это на шаге писем следующей волны, и следующий get()
   * по оферу снова зовёт писателя. Возвращает офферы, которым дан повтор.
   */
  retryFailed(): ChainType[];
  /**
   * Все начатые записи шаблонов закончились — строки шаблонов дописаны (или
   * отпущены после остановки). false — не дождались за timeoutMs. Раннер ждёт
   * их перед итоговой записью: «Переписать цепочку» сразу после неё видит
   * шаблоны законченными, а не «пишется».
   */
  settled(timeoutMs: number): Promise<boolean>;
}

/**
 * Шаблоны запуска в воркере: один промис на оффер — компании оффера, дошедшие
 * до писем одновременно, ждут одного писателя. Провал по замечаниям проверки
 * запоминается до конца запуска (писатель ответил — повтор уже был внутри
 * записи). Провал из-за молчания модели запоминается только до следующей волны:
 * Requesty или Gemini могли лечь на минуту.
 */
export function createChainTemplates(deps: TemplateWriterDeps): ChainTemplates {
  const byChain = new Map<ChainType, Promise<ChainTemplate>>();
  const settled = new Map<ChainType, ChainTemplate>();
  const retried = new Set<ChainType>();
  const retrying = new Set<ChainType>();
  return {
    get(chain) {
      const known = byChain.get(chain);
      if (known) return known;
      const promise = obtainTemplate(deps, chain, retrying.has(chain));
      byChain.set(chain, promise);
      promise.then(
        (template) => {
          settled.set(chain, template);
          retrying.delete(chain);
        },
        (err: unknown) => {
          // Сбой базы — не ответ писателя: следующая компания оффера попробует
          // снова. Лимит на ИИ и ключ — про весь запуск, их запоминаем.
          if (!(err instanceof BudgetExceededError) && !(err instanceof LlmAuthError)) byChain.delete(chain);
        },
      );
      return promise;
    },
    retryFailed() {
      const chains: ChainType[] = [];
      for (const [chain, template] of settled) {
        if (template.status !== 'failed' || !template.error || retried.has(chain)) continue;
        retried.add(chain);
        retrying.add(chain);
        settled.delete(chain);
        byChain.delete(chain);
        chains.push(chain);
      }
      return chains;
    },
    settled(timeoutMs) {
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
        timer.unref?.();
        void Promise.allSettled([...byChain.values()]).then(() => {
          clearTimeout(timer);
          resolve(true);
        });
      });
    },
  };
}

/**
 * Какой шаблон запуска сейчас пишется (pending, процесс жив) — или null.
 * «Переписать цепочку» ждёт, пока допишется любой шаблон запуска: иначе две
 * пересборки одного запуска делили бы лимит готовых и расход на ИИ.
 */
export async function templateBeingWritten(db: SupabaseClient, jobId: string): Promise<ChainType | null> {
  const { data, error } = await db.from(TABLE).select(ROW_COLUMNS).eq('job_id', jobId).eq('lang', LANG).eq('status', 'pending');
  if (error) throw new Error(`Не удалось прочитать цепочки запуска: ${error.message}`);
  const busy = ((data ?? []) as TemplateRow[]).find((row) => !isStale(row));
  return busy ? (busy.offer_key as ChainType) : null;
}

/**
 * Статус шаблона оффера в запуске (ok, failed, pending) или null — строки нет:
 * у оффера не было компаний, дошедших до писем.
 */
export async function templateStatus(db: SupabaseClient, jobId: string, chain: ChainType): Promise<string | null> {
  return (await readRow(db, jobId, chain))?.status ?? null;
}

export type RegenerateTemplateResult =
  | { kind: 'missing' }
  | { kind: 'busy' }
  | { kind: 'done'; template: ChainTemplate; wrote: boolean };

/**
 * «Переписать цепочку»: новая попытка писателя для failed или зависшей
 * pending строки. Шаблон уже прошёл проверку — писатель не нужен, возвращаем
 * его (роут пересоберёт письма застрявших строк). Строку пишет кто-то ещё —
 * busy.
 */
export async function regenerateChainTemplate(deps: TemplateWriterDeps, chain: ChainType): Promise<RegenerateTemplateResult> {
  const row = await readRow(deps.db, deps.jobId, chain);
  if (!row) return { kind: 'missing' };
  if (row.status === 'ok') {
    const current = templateFromRow(row, chain);
    if (current.status === 'ok') return { kind: 'done', template: current, wrote: false };
  }
  if (row.status === 'pending' && !isStale(row)) return { kind: 'busy' };
  const claimed = await claimExisting(deps.db, row);
  if (!claimed) return { kind: 'busy' };
  return { kind: 'done', template: await writeTemplate(deps, chain, claimed), wrote: true };
}
