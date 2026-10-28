/**
 * Шаблоны цепочек «Нашего автоаутрича»: Gemini 3.1 Pro пишет цепочку один раз
 * на оффер запуска, под компанию подставляются проверенные факты (спека
 * 2026-09-26-outreach-to-sender-design.md §4, как у движка вертикалей).
 *
 * С 29.10.2026 оффер — продукт каскада (СДР, классика РФ/СНГ и за рубеж,
 * автоаутрич): шаблон один на продукт, повод компании приносят {{повод}} и
 * {{связка}} (спека 2026-10-28-outreach-three-products-cascade-design.md,
 * решение 1). У запусков до каскада ключ шаблона — цепочка (повод); их шаблоны
 * открываются и переписываются по сути продукта, которым каскад считает эту
 * цепочку (templateProduct).
 *
 * Лениво: шаблон оффера пишется, когда до писем дошла первая компания этого
 * оффера. Параллельные компании оффера ждут один и тот же промис
 * (createChainTemplates), а между процессами — воркер и роут «Переписать
 * цепочку» — строку в polza_chain_templates сначала занимают (status
 * pending), и только занявший платит писателю. Так за один оффер не платим
 * дважды.
 *
 * Вход писателю: суть продукта и цель каждого из четырёх писем, образец —
 * цепочка продукта из fixedTemplates.ts, утверждённые формулировки и правила
 * автопроверки (qa.ts). Ответ проверяет runTemplateQa; провал — один повтор с
 * замечаниями, снова провал — шаблон failed, компании оффера уходят в «очень
 * спорные», а у оффера на экране — кнопка «Переписать цепочку».
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { callOutreachJson, outreachWorstCaseUsd, type OutreachLlmUsage } from '@/lib/outreachLlm/client';
import { BudgetExceededError, LlmAuthError, LlmCallError } from '@/lib/outreachLlm/context';
import { PRODUCT_LABELS, isProduct, legacyStepOf, productFor, type Product } from '../cascade';
import { claimsForChain, type OfferClaim, type SenderProfile } from '../libraries';
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
  type TemplateKey,
} from '../types';
import { openingSentence, type ChainInput } from './chains';
import { intro } from './common';
import { FIXED_TEMPLATES_MODEL, fixedTemplate } from './fixedTemplates';

const P = TEMPLATE_PLACEHOLDERS;
const TABLE = 'polza_chain_templates';
const LANG = 'ru';
/**
 * 09–14.10.2026 шаблон оффера был утверждёнными текстами (fixedTemplates.ts)
 * без Gemini. С 14.10.2026 снова пишет Gemini — с этими текстами как образцом
 * и жёстким лимитом длины (бережём ящики). Вернуть готовые тексты — true здесь.
 */
const USE_FIXED_TEMPLATES = false;
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
  // Готовые тексты писателя не зовут — бронировать под него нечего.
  if (USE_FIXED_TEMPLATES) return 0;
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
  /** Ключ шаблона: продукт или, у запусков до каскада, цепочка. */
  key: TemplateKey;
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
  /** Предложение письма 1 (оба варианта, сразу после {{связка}}). */
  offer: string;
  goals: [string, string, string, string];
}

/**
 * Продукт шаблона: у запусков с каскадом ключ — сам продукт, у запусков до него
 * — цепочка, и её шаблон пишется по продукту, которым каскад её считает
 * (legacyStepOf: «Автоматизация» — автоаутрич, остальные — классика).
 */
export function templateProduct(key: TemplateKey): Product {
  return isProduct(key) ? key : productFor(legacyStepOf(key), false);
}

/**
 * Письмо 4 всех продуктов. Последним его не называем и больше не писать не
 * обещаем: после паузы каскад предложит компании следующий продукт.
 */
const LETTER4 =
  'мягкое закрытие, самое короткое письмо: если тема не ко времени — пусть так и скажут, вернёмся позже; если этим занимается другой человек — к кому обратиться. Не называй письмо последним и не обещай больше не писать: позже мы можем написать с другим предложением';

/**
 * Суть продукта и цель каждого письма — по КП (спека каскада, «Три продукта»).
 * Цен в письмах нет: они в КП и у менеджера. Каждое письмо продаёт только свой
 * продукт: обещание из КП другого продукта — провал (анти-цель спеки).
 */
const OFFER_BRIEFS: Record<Product, OfferBrief> = {
  sdr: {
    essence:
      'СДР — ручной выход на нужные компании (само слово «СДР» получатель не знает). Наша команда сама находит в компаниях, которые нужны получателю, тех, кто принимает решения, и выходит на них от его имени — вручную, а не массовой рассылкой. Подходит, когда возможных клиентов немного (узкая ниша), есть свой список целевых компаний или нужны крупные компании, до которых не достучаться обычными письмами. Ответы с интересом передаём менеджеру получателя вместе с перепиской. Результат и стоимость наш менеджер называет после разговора о задаче. Не обещай системы, автоматизации, заявок каждый месяц и того, что что-то «станет вашим», — это другие продукты.',
    offer:
      'главное в письме, идёт первым: наша команда вручную находит тех, кто принимает решения в нужных получателю компаниях, и выходит на них от его имени. Предложение отвечает на {{связка}}: повод → почему сейчас нужны встречи с конкретными компаниями → как мы на них выходим.',
    goals: [
      'суть одной-двумя фразами; позвать на короткий созвон с нашим менеджером',
      'крупных клиентов в узкой нише массовыми письмами не взять — к ним нужен личный выход; созвон на 15 минут с менеджером: он разберёт задачу и назовёт ожидаемый результат и стоимость. Список компаний НЕ проси — тогда получатель будет ждать конкретики в ответ',
      'как это выглядит: в варианте с кейсом — кейс, в варианте без кейса — {{гипотеза}} и как работает команда (находим ответственных, выходим вручную, ответы передаём менеджеру с перепиской); предложить обсудить задачу с менеджером',
      `${LETTER4}; вопрос — актуально ли сейчас поговорить с нашим менеджером`,
    ],
  },
  classic: {
    essence:
      'Классический поиск клиентов по России и СНГ: наша команда ведёт кампанию за получателя — выбирает сегменты и гипотезы, собирает базу, находит тех, кто принимает решения, пишет им цепочки писем от его имени и передаёт ответы с интересом его менеджеру вместе с перепиской. Обязательства по заявкам прописываем в договоре — говори именно так, без корня «гарант». Не обещай системы, которая работает сама, и того, что что-то «станет вашим», — это другой продукт.',
    offer:
      'главное в письме, идёт первым: наша команда ведёт поиск клиентов за получателя — выбирает сегменты, собирает базу и выходит на тех, кто принимает решения. Предложение отвечает на {{связка}}: повод → зачем сейчас новые клиенты → как мы их находим.',
    goals: [
      'суть одной-двумя фразами; позвать на созвон, чтобы прикинуть сегменты и сколько заявок можно ждать',
      'письма не массовые: у каждого сегмента свой повод и свой текст; обязательства по заявкам прописываем в договоре; созвон на 15 минут — прикинуть сегменты и прогноз заявок',
      'показать на примере, как это выглядит: в варианте с кейсом — кейс, в варианте без кейса — гипотеза сегментов ({{гипотеза}}) и механика первого теста; предложить прислать короткий план первого теста',
      `${LETTER4}; вопрос — актуальны ли сейчас новые клиенты`,
    ],
  },
  classic_abroad: {
    essence:
      'Поиск клиентов за рубежом: то же, что классический поиск по России, но на зарубежных рынках. Наша команда выбирает страны и сегменты, собирает базу, находит тех, кто принимает решения, и выходит на них по почте и в LinkedIn от имени получателя; ответы с интересом передаёт его менеджеру. Подходит компаниям, которые продают или хотят продавать за рубеж. Обязательств по заявкам и обещаний результата в договоре здесь нет — не упоминай их. Не обещай системы, которая работает сама, — это другой продукт.',
    offer:
      'главное в письме, идёт первым: наша команда находит клиентов на зарубежных рынках — собирает базу и пишет тем, кто принимает решения, по почте и в LinkedIn от имени получателя. Предложение отвечает на {{связка}}.',
    goals: [
      'суть одной-двумя фразами; позвать на созвон, чтобы прикинуть страны и сегменты',
      'страны и сегменты проверяем небольшими тестами, ответы с интересом передаём менеджеру получателя с перепиской; созвон на 15 минут — какие рынки и сегменты проверить первыми',
      'как это выглядит: в варианте с кейсом — кейс, в варианте без кейса — {{гипотеза}} и механика первого теста на одном рынке (2–3 сегмента, почта и LinkedIn, по ответам видно, где есть спрос); предложить прислать короткий план теста',
      `${LETTER4}; вопрос — актуальны ли сейчас продажи за рубежом`,
    ],
  },
  auto: {
    essence:
      'Автоматический поиск клиентов: мы настраиваем систему, которая каждый день сама находит подходящие компании по свежим поводам, пишет им от имени получателя и передаёт ответы с интересом его менеджеру. Настройка, инфраструктура и ведение включены; со временем система переходит к получателю. Выгода — заявки каждый месяц без найма своей команды продаж. Не обещай ручной работы команды с каждым контактом и обязательств по заявкам в договоре — это другие продукты.',
    offer:
      'главное в письме, идёт первым: выгода — заявки каждый месяц без найма команды; как — система сама каждый день находит подходящие компании и пишет им от имени получателя, ответы с интересом получает его менеджер; ведение включено. Цифр заявок не придумывай. Предложение отвечает на {{связка}}: повод → зачем сейчас новые клиенты → как мы их даём.',
    goals: [
      'выгода и суть одной-двумя фразами; позвать на созвон, чтобы прикинуть базу и темп',
      'настройку и ведение берём на себя: система ищет компании по поводам, ответы с интересом получает менеджер получателя; созвон на 15 минут — прикинуть, сколько подходящих компаний в базе и какой темп реален',
      'как это выглядит: в варианте с кейсом — кейс, в варианте без кейса — {{гипотеза}} и как работает система; предложить прислать короткий план запуска',
      `${LETTER4}; вопрос — актуален ли сейчас постоянный поток заявок`,
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
  'стеллажи для складов',
  'Когда стройка замедляется',
];

/**
 * Поводы в примерах шаблона продукта: шаблон один на продукт и идёт компаниям
 * с любым поводом — вернувшейся компании следующий продукт достаётся при
 * прежнем поводе.
 */
const PRODUCT_EXAMPLE_CHAINS: ChainType[] = ['hiring', 'ad_budget', 'event', 'growth_event', 'icp_only', 'reactivation'];

/** Как выглядит {{повод}} у этого оффера — из того же openingSentence, что подставит его компаниям. */
function openingExamples(key: TemplateKey): string[] {
  const signal = (type: Signal['type'], source: Signal['source'], title: string, extra: Partial<Signal> = {}): Signal => ({
    type, source, title, date: null, url: null, quote: null, level: 'B', ...extra,
  });
  const ad = signal('ad_running', 'direct', 'оборудование для складов', { meta: { keyword: 'оборудование для складов' } });
  const news = signal('new_office', 'news', 'Альфа открыла филиал в Казани', { quote: 'Альфа открыла филиал в Казани', level: 'A' });
  const of = (chain: ChainType): ChainInput[] => {
    const base: ChainInput = { chain, signal: null, priorContact: false, marketQuote: null, productSummary: null };
    const byChain: Record<ChainType, ChainInput[]> = {
      reactivation: [{ ...base, priorContact: true }],
      hiring: [{ ...base, signal: signal('sales_hiring', 'hh', 'Менеджер по активным продажам', { quote: 'поиск и привлечение новых B2B-клиентов', level: 'A' }) }],
      ad_budget: [{ ...base, signal: ad }],
      event: [{ ...base, signal: signal('trade_show_exhibitor', 'exhibitors', 'Металлообработка') }],
      growth_event: [{ ...base, signal: news }, { ...base, signal: signal('tender_won', 'tenders', 'поставка складского оборудования') }],
      icp_only: [{ ...base, marketQuote: 'поставляем оборудование для пищевых производств по всей России' }],
      automation: [{ ...base, baseChain: 'ad_budget', signal: ad }, { ...base, baseChain: 'reactivation', priorContact: true }],
    };
    return byChain[chain];
  };
  const inputs = isProduct(key) ? PRODUCT_EXAMPLE_CHAINS.flatMap(of) : of(key);
  return inputs.map((input) => openingSentence(input, EXAMPLE_BRAND)).filter((s): s is string => Boolean(s));
}

/**
 * Образец писателя — цепочка продукта (fixedTemplates.ts) под отправителя
 * запуска: так он представляется в письмах 2–3, а это одинаково для всех
 * компаний запуска. Образец сам проходит runTemplateQa — писатель не учится на
 * нём тому, за что его потом завернёт проверка. Письма 3 «с кейсом» нет у
 * офферов без кейса.
 */
export function sampleTemplate(key: TemplateKey, sender: SenderProfile): ChainTemplateLetters {
  const doc = fixedTemplate(templateProduct(key), sender);
  return { ...doc, bodyWithCase: chainUsesCase(key) ? doc.bodyWithCase : null };
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
  'Ты пишешь холодные письма для Polza Agency — агентства, которое находит B2B-компаниям новых клиентов: подбираем компании под продукт клиента, находим в них ЛПР, выходим на них от лица клиента и передаём заинтересованные ответы его менеджеру вместе с перепиской. У агентства несколько продуктов; цепочка продаёт ровно один — ОФФЕР из задания — и не обещает того, что есть только у других.',
  'Нужен ШАБЛОН цепочки из четырёх писем для одного оффера. Шаблон один на все компании оффера: под каждую компанию код заменит только плейсхолдеры, весь остальной текст уйдёт как есть. Поэтому в тексте нет ничего о конкретной компании, кроме плейсхолдеров.',
  '',
  'ПЛЕЙСХОЛДЕРЫ — ровно в таком написании, других {{…}} не бывает:',
  '{{бренд}} — название компании-получателя. Пиши его в кавычках-ёлочках: «{{бренд}}». Название в кавычках не склоняется, поэтому перед ним всегда родовое слово: «в компании «{{бренд}}»», «для компании «{{бренд}}»», — или фраза, где оно в именительном падеже. «Кто в «{{бренд}}» отвечает» — ошибка. Не больше двух упоминаний в письме; чаще пиши «вы», «у вас».',
  '{{повод}} — готовая фраза-повод из проверенных фактов о компании: одно-два законченных предложения с точкой. Только в письме 1. Бывает пустой, тогда её абзац удаляется. Ставь её отдельным абзацем (пустая строка до и после, без другого текста), письмо должно читаться и без неё; её смысл своими словами не повторяй.',
  '{{связка}} — готовая фраза, своя у каждой компании: связывает повод с тем, что компании нужны новые клиенты (например «Когда стройка замедляется, поставщикам приходится самим искать новых заказчиков.»). Только в письме 1, отдельным абзацем сразу после {{повод}}. Бывает пустой, тогда абзац удаляется — письмо должно читаться и без неё. Следующий абзац начинается с предложения, которое отвечает на связку; не повторяй и не пересказывай её.',
  '{{кейс}} — утверждённый текст кейса клиента Polza со строчной буквы, вставляется дословно. Пиши: «Для примера: {{кейс}}».',
  '{{гипотеза}} — два-четыре предложения гипотезы первых сегментов для компании. Бывает пустой — ставь отдельным абзацем без другого текста.',
  '{{предмет}} — что предлагаем обсудить именно этой компании, своё у каждой («поиск корпоративных клиентов на поставки автозапчастей»). Стоит внутри предложения: «Хочу обсудить {{предмет}}.» Не больше одного раза в письме.',
  '{{должность}} — должность из вакансии компании в ёлочках («Менеджер по продажам»). Только в оффере «найм», внутри предложения: «открыта вакансия {{должность}}».',
  '{{подпись}} — подпись отправителя в несколько строк.',
  '',
  'ПРАВИЛА:',
  '1. Каждое письмо начинается строкой «Добрый день!» и заканчивается ровно так: «С уважением,», перевод строки, «{{подпись}}».',
  '2. Абзацы разделяй пустой строкой.',
  '3. В каждом письме ровно один вопросительный знак — один призыв к действию.',
  '4. У письма 1 есть тема: коротко, со строчной буквы, без «!» и «?», без слов «резюме», «кандидат», «отклик». Письма 2–4 — ответы в той же ветке, без темы.',
  '5. Цифры — только «15 минут», «2–3» перед словом «сегмент» («2–3 сегмента», «2–3 узких сегмента») и цифры внутри утверждённых формулировок (их вставляй только дословно). Числа словами тоже нельзя: «десятки», «сотни», «тысячи», «вдвое», «втрое», «в N раз». Не обещай сроков и результатов: никаких «неделя», «квартал», «процент»; «месяц» — только в «каждый месяц» или «ежемесячно» про то, что заявки приходят регулярно. Не выдумывай результаты, объёмы, число клиентов.',
  '6. О компании-получателе — ничего сверх {{повод}}: не додумывай её рынок, клиентов, планы и проблемы. Боль — общее наблюдение о канале, а не диагноз получателю.',
  '7. Никаких намёков на прошлый контакт — «мы с вами уже общались», «ранее обсуждали», «переписывались», «созванивались», «наш разговор», «наша встреча» — кроме оффера «Возврат». Если разговор был, о нём скажет {{повод}}.',
  '8. Нельзя слов с корнями «срочн» и «гарант» — даже с отрицанием («не срочно», «без гарантий» тоже нельзя). Нельзя давить дефицитом («последний шанс», «осталось N мест»), писать «уникальный», «мы лучшие», «революционный», эмодзи, восклицательные знаки (кроме «Добрый день!»), разметку markdown и служебные слова (score, pipeline, ICP, LLM, evidence, JSON, null, TODO, скоринг).',
  '9. Тон: письмо должно читаться так, будто его написал один человек одной компании, а не рассылка. Коротко, живым деловым языком, от первого лица отправителя; предложения разной длины; конкретика вместо общих слов. Без канцелярита и штампов: «в рамках», «данный», «осуществлять», «является», «на сегодняшний день», «хотел бы предложить», «позвольте представить», «рады предложить», «взаимовыгодное сотрудничество», «надоедать». Каждое следующее письмо добавляет новое, а не пересказывает предыдущее. Вопрос — в конце письма, не в начале. Письмо 4 — самое короткое; не называй его последним и не обещай больше не писать: позже мы можем написать с другим предложением.',
  `10. Примеры из задания (компания «${EXAMPLE_BRAND}», её поводы и пример {{связка}}) — только чтобы понять, что подставит код; в шаблон их не переносить.`,
  '11. Получатель не знает слов «аутрич», «outreach», «лидогенерация», «СДР»: говори простыми словами, как в СУТИ оффера, — «новые клиенты», «заявки», «пишем тем, кто принимает решения».',
  '12. ЖЁСТКИЙ ЛИМИТ ДЛИНЫ — важнее всех остальных правил и образца: считай только свой текст письма (без плейсхолдеров, приветствия и {{подпись}}). Цель — 80–100 символов, нормально до 150, абсолютный максимум — 200 символов, больше нельзя ни в одном письме и ни в одном варианте. Одно-два коротких предложения; всё, что не суть и не вопрос, — убирай.',
  '',
  'Ответ — строгий JSON-объект по формату из сообщения, без markdown и пояснений.',
].join('\n');

function contractText(key: TemplateKey): string {
  const letter3 = chainUsesCase(key)
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

function writerUserPrompt(key: TemplateKey, sender: SenderProfile, claims: OfferClaim[], retry: RetryNote | null): string {
  const product = templateProduct(key);
  const brief = OFFER_BRIEFS[product];
  const keyClaims = claimsForChain(claims, key);
  const places = [
    `${P.opening} — в письме 1, в обоих вариантах, и больше нигде`,
    `${P.bridge} — в письме 1, в обоих вариантах, отдельным абзацем сразу после ${P.opening}, и больше нигде`,
    ...(chainUsesCase(key) ? [`${P.case} — только в письме 3 «с кейсом»`] : []),
    ...(chainUsesHypothesis(key) ? [`${P.hypothesis} — только в письме 3 «без кейса», отдельным абзацем`] : []),
    `${P.signature} — в конце каждого письма`,
  ];
  const lines = [
    `ОФФЕР: ${PRODUCT_LABELS[product]}`,
    // Шаблон продукта — на компании с любым поводом; у старого запуска — на компании одного повода.
    isProduct(key)
      ? `ПОВОД у компаний этого оффера разный (вакансия, реклама, выставка, рост, профиль, прошлый разговор) — его приносит ${P.opening}; текст шаблона от повода не зависит.`
      : `ПОВОД у компаний этого оффера — «${CHAIN_LABELS[key]}», его приносит ${P.opening}.`,
    `СУТЬ: ${brief.essence}`,
    'ЦЕЛИ ПИСЕМ:',
    ...brief.goals.map((goal, i) => `${i + 1} — ${goal}`),
    `ПРЕДЛОЖЕНИЕ В ПИСЬМЕ 1 (оба варианта, сразу после ${P.bridge}) — ${brief.offer}`,
    'body_routing — для общей почты (info@, office@): письмо читает не ЛПР — после повода, связки и предложения в конце спроси, кто отвечает за продажи и привлечение клиентов, и попроси переслать письмо ему.',
    '',
    `ПЛЕЙСХОЛДЕРЫ ЭТОГО ОФФЕРА: ${templatePlaceholdersFor(key).join(', ')}.`,
    ...(!chainUsesCase(key) ? [`${P.case} этому офферу не подбирается: плейсхолдера нет, и письма 3 «с кейсом» тоже.`] : []),
    ...(!chainUsesHypothesis(key) ? [`${P.hypothesis} в этом оффере не используется.`] : []),
    `ОБЯЗАТЕЛЬНО: ${places.join('; ')}.`,
    `${P.opening} у этого оффера выглядит так (пример для компании «${EXAMPLE_BRAND}» — в шаблон не переносить):`,
    ...openingExamples(key).map((example) => `— ${example}`),
    '',
    `ОТПРАВИТЕЛЬ: ${intro(sender)} — так он представляется в письмах 2–3, как в образце; другого имени не пиши.`,
    'УТВЕРЖДЁННЫЕ ФОРМУЛИРОВКИ (вставлять только дословно; цифры — только из них):',
    ...(keyClaims.length ? keyClaims.map((c) => `— ${c.claim_text}`) : ['— нет: пиши без цифр.']),
    '',
    'ОБРАЗЕЦ цепочки этого оффера — ориентир по смыслу каждого письма, тону и длине (он укладывается в лимит правила 12). Пиши своими словами, лимит не превышай; где стоят плейсхолдеры, решает список ОБЯЗАТЕЛЬНО выше:',
    sampleText(sampleTemplate(key, sender)),
    '',
    'ФОРМАТ ОТВЕТА — JSON:',
    contractText(key),
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
export function parseTemplateLetters(raw: unknown, key: TemplateKey): ChainTemplateLetters | null {
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
  const routingSubjects = byN.get(1)?.subjects_routing;
  return {
    subject: field(1, 'subject').replace(/\s+/g, ' '),
    subjectsRouting: Array.isArray(routingSubjects)
      ? routingSubjects.map((s) => normalizeBody(s).replace(/\s+/g, ' ')).filter(Boolean)
      : undefined,
    bodyDirect: field(1, 'body_direct'),
    bodyRouting: field(1, 'body_routing'),
    letter2: field(2, 'body'),
    // Пустой вариант с кейсом — шаблон без него (у SDR-цепочки до 09.10.2026).
    bodyWithCase: chainUsesCase(key) ? field(3, 'body_with_case') || null : null,
    bodyWithoutCase: field(3, 'body_without_case'),
    letter4: field(4, 'body'),
  };
}

/** Письма шаблона в контракт писателя — так они лежат в polza_chain_templates.letters. */
export function templateLettersToJson(t: ChainTemplateLetters): Array<Record<string, unknown>> {
  return [
    {
      n: 1, subject: t.subject, body_direct: t.bodyDirect, body_routing: t.bodyRouting,
      ...(t.subjectsRouting?.length ? { subjects_routing: t.subjectsRouting } : {}),
    },
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

function templateFromRow(row: TemplateRow, key: TemplateKey): ChainTemplate {
  const letters = row.letters ? parseTemplateLetters({ letters: row.letters }, key) : null;
  const ok = row.status === 'ok' && letters !== null;
  return {
    id: row.id,
    key,
    status: ok ? 'ok' : 'failed',
    letters,
    qaFlags: row.qa_flags ?? [],
    error: row.error ?? (row.status === 'ok' && !letters ? 'письма шаблона в базе не разбираются' : null),
    model: row.model,
    costUsd: Number(row.cost_usd ?? 0) || 0,
    attempt: Number(row.attempt ?? 0) || 0,
  };
}

async function readRow(db: SupabaseClient, jobId: string, key: TemplateKey): Promise<TemplateRow | null> {
  const { data, error } = await db.from(TABLE).select(ROW_COLUMNS).eq('job_id', jobId).eq('lang', LANG).eq('offer_key', key).maybeSingle();
  if (error) throw new Error(`Не удалось прочитать цепочку оффера «${key}»: ${error.message}`);
  return (data as TemplateRow | null) ?? null;
}

/**
 * Первая генерация оффера в запуске: строка сразу вставляется pending — она
 * наша. Уже есть (её занял другой процесс) — null: insert … on conflict do
 * nothing возвращает только вставленное.
 */
async function claimNew(db: SupabaseClient, jobId: string, key: TemplateKey): Promise<TemplateRow | null> {
  const { data, error } = await db
    .from(TABLE)
    .upsert(
      {
        job_id: jobId, lang: LANG, offer_key: key, status: 'pending', letters: null, qa_flags: [],
        cost_usd: 0, attempt: 1, error: null, updated_at: new Date().toISOString(),
      },
      { onConflict: 'job_id,lang,offer_key', ignoreDuplicates: true },
    )
    .select(ROW_COLUMNS);
  if (error) throw new Error(`Не удалось занять цепочку оффера «${key}»: ${error.message}`);
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
export function templateQaInput(key: TemplateKey, sender: SenderProfile, claims: OfferClaim[]): Omit<TemplateQaInput, 'letters'> {
  return {
    key,
    claimTexts: claimsForChain(claims, key).map((c) => c.claim_text),
    senderTexts: senderTexts(sender),
    exampleTexts: [...EXAMPLE_FRAGMENTS, ...openingExamples(key)],
  };
}

/** Утверждённые тексты в занятую строку: без ИИ и без проверки шаблона — текст утверждён людьми. */
async function writeFixedTemplate(deps: TemplateWriterDeps, key: TemplateKey, claimed: TemplateRow): Promise<ChainTemplate> {
  const letters = sampleTemplate(key, deps.sender);
  const template: ChainTemplate = {
    id: claimed.id,
    key,
    status: 'ok',
    letters,
    qaFlags: [],
    error: null,
    model: FIXED_TEMPLATES_MODEL,
    costUsd: Number(claimed.cost_usd ?? 0) || 0,
    attempt: Number(claimed.attempt ?? 1) || 1,
  };
  const saved = await finishRow(deps.db, claimed, {
    status: 'ok',
    letters: templateLettersToJson(letters),
    qa_flags: [],
    model: FIXED_TEMPLATES_MODEL,
    cost_usd: template.costUsd,
    attempt: template.attempt,
    error: null,
  });
  if (!saved) log('warn', `job ${deps.jobId}: chain ${key} fixed template not saved (row ${claimed.id} was taken over or the DB failed)`);
  return template;
}

async function writeTemplate(deps: TemplateWriterDeps, key: TemplateKey, claimed: TemplateRow): Promise<ChainTemplate> {
  if (USE_FIXED_TEMPLATES) return writeFixedTemplate(deps, key, claimed);
  const qaInput = templateQaInput(key, deps.sender, deps.claims);
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
        log('warn', `job ${deps.jobId}: chain ${key} retry skipped — ${Math.round(left / 1000)} s left before the deadline`);
        break;
      }
      calls += 1;
      const raw = await callOutreachJson({
        role: 'writer',
        system: WRITER_SYSTEM,
        user: writerUserPrompt(key, deps.sender, deps.claims, retry),
        title: `chain-${key}`,
        maxTokens: WRITER_MAX_TOKENS,
        lang: LANG,
        onUsage,
        timeoutMs: Math.min(deps.writerTimeoutMs, Math.max(1, left)),
        signal: deps.signal,
      });
      letters = parseTemplateLetters(raw, key);
      flags = letters ? runTemplateQa({ ...qaInput, letters }).flags : ['letters_missing'];
      if (!flags.length) break;
      log('warn', `job ${deps.jobId}: chain ${key} attempt ${attempt} failed QA: ${flags.join(', ')}`);
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
    key,
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
  if (!saved) log('warn', `job ${deps.jobId}: chain ${key} result not saved (row ${claimed.id} was taken over or the DB failed)`);
  log('info', `job ${deps.jobId}: chain ${key} ${template.status} after ${calls} writer call(s), $${cost.toFixed(4)}${error ? ` — ${error}` : ''}`);
  if (fatal) throw fatal;
  return template;
}

/**
 * Шаблон оффера для воркера: своя строка или готовая чужая. Чужую pending
 * (её пишет другой процесс) ждём, пока допишет; умер — занимаем заново.
 * retryFailed — повтор после «ИИ не ответил»: failed-строку занимаем заново
 * (со сравнением, как «Переписать цепочку»), а не отдаём как есть.
 */
async function obtainTemplate(deps: TemplateWriterDeps, key: TemplateKey, retryFailed = false): Promise<ChainTemplate> {
  const deadline = Date.now() + PENDING_STALE_MS + 2 * POLL_MS;
  for (;;) {
    // Запуск остановили, пока ждали чужую запись, — не ждём дальше.
    deps.signal?.throwIfAborted();
    const claimed = await claimNew(deps.db, deps.jobId, key);
    if (claimed) return writeTemplate(deps, key, claimed);
    const row = await readRow(deps.db, deps.jobId, key);
    if (row && row.status === 'failed' && retryFailed) {
      const taken = await claimExisting(deps.db, row);
      if (taken) return writeTemplate(deps, key, taken);
      // Занял кто-то другой — дождёмся его итога на следующем круге.
      await sleep(POLL_MS);
      continue;
    }
    if (row && row.status !== 'pending') return templateFromRow(row, key);
    if (row && isStale(row)) {
      const taken = await claimExisting(deps.db, row);
      if (taken) return writeTemplate(deps, key, taken);
    }
    if (Date.now() > deadline) {
      throw new Error(`Цепочка оффера «${key}» не дописана другим процессом за ${Math.round(PENDING_STALE_MS / 60_000)} мин`);
    }
    await sleep(POLL_MS);
  }
}

export interface ChainTemplates {
  /** Шаблон продукта: раннер пишет только шаблоны продуктов (запуски с каскадом). */
  get(product: Product): Promise<ChainTemplate>;
  /**
   * Продукты, чей шаблон не написан из-за молчания модели (ошибка, а не
   * замечания проверки), — забыть и занять заново. Один раз на продукт за
   * запуск: раннер зовёт это на шаге писем следующей волны, и следующий get()
   * по продукту снова зовёт писателя. Возвращает продукты, которым дан повтор.
   */
  retryFailed(): Product[];
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
  const byProduct = new Map<Product, Promise<ChainTemplate>>();
  const settled = new Map<Product, ChainTemplate>();
  const retried = new Set<Product>();
  const retrying = new Set<Product>();
  return {
    get(product) {
      const known = byProduct.get(product);
      if (known) return known;
      const promise = obtainTemplate(deps, product, retrying.has(product));
      byProduct.set(product, promise);
      promise.then(
        (template) => {
          settled.set(product, template);
          retrying.delete(product);
        },
        (err: unknown) => {
          // Сбой базы — не ответ писателя: следующая компания продукта
          // попробует снова. Лимит на ИИ и ключ — про весь запуск, их запоминаем.
          if (!(err instanceof BudgetExceededError) && !(err instanceof LlmAuthError)) byProduct.delete(product);
        },
      );
      return promise;
    },
    retryFailed() {
      const products: Product[] = [];
      for (const [product, template] of settled) {
        if (template.status !== 'failed' || !template.error || retried.has(product)) continue;
        retried.add(product);
        retrying.add(product);
        settled.delete(product);
        byProduct.delete(product);
        products.push(product);
      }
      return products;
    },
    settled(timeoutMs) {
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), Math.max(0, timeoutMs));
        timer.unref?.();
        void Promise.allSettled([...byProduct.values()]).then(() => {
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
export async function templateBeingWritten(db: SupabaseClient, jobId: string): Promise<TemplateKey | null> {
  const { data, error } = await db.from(TABLE).select(ROW_COLUMNS).eq('job_id', jobId).eq('lang', LANG).eq('status', 'pending');
  if (error) throw new Error(`Не удалось прочитать цепочки запуска: ${error.message}`);
  const busy = ((data ?? []) as TemplateRow[]).find((row) => !isStale(row));
  return busy ? (busy.offer_key as TemplateKey) : null;
}

/**
 * Статус шаблона оффера в запуске (ok, failed, pending) или null — строки нет:
 * у оффера не было компаний, дошедших до писем.
 */
export async function templateStatus(db: SupabaseClient, jobId: string, key: TemplateKey): Promise<string | null> {
  return (await readRow(db, jobId, key))?.status ?? null;
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
export async function regenerateChainTemplate(deps: TemplateWriterDeps, key: TemplateKey): Promise<RegenerateTemplateResult> {
  const row = await readRow(deps.db, deps.jobId, key);
  if (!row) return { kind: 'missing' };
  if (row.status === 'ok') {
    const current = templateFromRow(row, key);
    if (current.status === 'ok') return { kind: 'done', template: current, wrote: false };
  }
  if (row.status === 'pending' && !isStale(row)) return { kind: 'busy' };
  const claimed = await claimExisting(deps.db, row);
  if (!claimed) return { kind: 'busy' };
  return { kind: 'done', template: await writeTemplate(deps, key, claimed), wrote: true };
}
