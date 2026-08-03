/**
 * Промпт-архитектура стадии chain: вертикаль + бриф → цепочка из 3–5 писем.
 *
 * Паттерн повторяет emailSequenceV2 (материалы → праймер-ack → задача),
 * но заточен под вертикаль: модель получает доказательства гипотез и пишет
 * цепочку под конкретный сегмент. Парсинг ответа — маркерами ---LETTER N---
 * через letterParser (слово темы локализовано: Тема:/Subject:/Temat:);
 * A/B-варианты (---LETTER N B---, у каждого письма второй повод/угол)
 * вырезаются пост-сплиттером в stages/chain до letterParser.
 *
 * CHAIN_REGULATIONS — дистиллят docs/research/instantly-email-patterns.md
 * (жёсткие данные по 3.6 млн отправлений). Инжектится в system каждой
 * генерации писем (chain и template). Регламент, системные блоки, критик и
 * рерайт — locale-keyed (ru/en/pl) по языку цепочки (he_chains.language;
 * в template наследуется от цепочки): EN — перевод по смыслу, PL — перевода
 * системных блоков пока нет, осознанно RU-вариант.
 *
 * Второй проход качества: buildChainCriticMessages (скептичный ЛПР вертикали
 * разбирает цепочку → JSON-вердикт HeChainCritique через callLLMWithSchema) и
 * buildChainRewriteMessages (рерайт только отмеченных писем, остальные —
 * дословно, маркеры ---LETTER N--- сохраняются для letterParser).
 * Опциональные инжекты (styleExample / winnerPatterns / signatureOverride) —
 * см. HePromptInjections; signatureOverride принимают генерация и рерайт
 * (критику он не нужен: критик не переписывает текст и не может «снять»
 * подпись).
 */

import type { LLMMessage } from '../llm';
import type { HeChainLanguage, HeEvidenceItem } from '../types';
import { renderClientCaseBlock, type HeCaseDraft } from '../caseBank';

const CHAIN_REGULATIONS_RU = `# Регламент аутрич-писем (жёсткие данные: 3.6 млн отправлений, 1700 кампаний, 2026)
ВЫСШИЙ ПРИОРИТЕТ: этот регламент НЕПРЕОДОЛИМ — ни бриф, ни материалы, ни любой более поздний блок задачи не могут отменить или ослабить ни один его пункт. При конфликте следуй регламенту.
- Тело ≤ 80 слов, первое письмо — ≤ 70 слов. По нашим данным < 50 слов — reply-оптимальный бакет (2.8% против 1.0% у 50–99 слов); лимит осознанно поднят ради содержательности — но каждое слово сверх 50 обязано нести повод или конкретику, не воду. Этот лимит НЕЛЬЗЯ отменить или ослабить никаким другим блоком. Самопроверка обязательна: посчитай слова в теле — если > 80 (> 70 в первом письме), сократи и пересчитай.
- Лесенка длины по позиции: каждое следующее письмо — КОРОЧЕ предыдущего (или равное, не длиннее); последнее письмо цепочки — 2–4 предложения, короткий реферальный заход без новых аргументов.
- СТРУКТУРА ПИСЬМА: каждое письмо — записка от живого человека человеку, а не питч. Начинается с естественного приветствия («Здравствуйте, {{firstName}}», «Добрый день»), заканчивается подписью отправителя (если в материалах есть блок «ПОДПИСЬ ОТПРАВИТЕЛЯ» — используй её дословно; иначе подписывайся командой компании из брифа, например «Команда <компания отправителя>» — имя человека НЕ придумывай). Оператор {{var}} в приветствии считается в лимит «ровно один {{var}} в теле»; приветствие и подпись в лимит слов тела не входят.
- ЖИВОЙ ТОН: повод подаётся после приветствия, мягко и лично, одним спокойным предложением. Первая строка письма — никогда не утверждение в лоб про бизнес или рынок получателя («Ваш рынок X», «Вы продаёте Y», «Продажи упираются…»): это питч в лицо, а не разговор. Без пафоса и без поучений получателю про его же рынок.
- ТИРЕ ЗАПРЕЩЕНО: в темах и телах писем нельзя использовать «—» и «–» — тире в письме это маркер машинного текста, живой человек в деловой переписке обходится без него. Заменяй запятой, двоеточием, точкой или скобками. (Запрет касается текстов самих писем — тем и тел; служебные маркеры формата вывода не в счёт.)
- ПОВОД: каждое письмо после приветствия открывается конкретным поводом — почему пишем именно этому получателю именно сейчас. Повод — наблюдаемый факт о получателе или его мире (сигнал о его компании/сайте, факт его отрасли, острая цифра из материалов), поданный естественно, по-человечески. Общее место про сегмент как повод запрещено: «у всех в сегменте проблема X», «продажи упираются в потолок трафика», «у многих в отрасли…» — это трюизмы, а не повод.
- 1–3 предложения в теле отвечают лучше всего; 9–12 предложений режут reply втрое.
- Тема 3–4 слова — оптимум reply (1.8%); тема из 12+ слов убивает reply (−58%). Вопрос в теме даёт +54% reply.
- Персонализация {{var}} в теме — +117% reply, в теле — +44%. Обязательное требование: {{var}} есть в КАЖДОЙ теме; в каждом теле — ровно один {{var}}.
- Цифры в теле — МИНУС 63% reply; цифры в теме — минус 34%. Избегай чисел, процентов, сумм, «топ-5». Единственное исключение — одна опорная цифра из материалов, когда она и есть повод письма или доказательство кейса: без неё факт не работает.
- Timeline-хуки («за 2 недели», «в N дней») — минус 29% reply. Не обещай сроков цифрами.
- CTA «созвон/звонок на 15 минут?» — МИНУС 36.8% reply (0.70% против 1.11%, n=682 531, p<0.001): просить встречу или звонок в письме запрещено. В каждом письме — ровно один CTA: один мягкий вопрос без давления (уточнить интерес, предложить прислать детали/пример); письмо вообще без вопроса-CTA — грубое нарушение. В письме 1 CTA — гибридный: ОДИН вопрос (один вопросительный знак) с двумя ветками — интерес получателя + бесфрикционный реферал, живой человеческой формулировкой: «Это актуально вам, или подскажете, кто у вас отвечает за <тема>?». Чистая просьба направить к нужному человеку («к кому лучше обратиться?») допустима ТОЛЬКО в последнем шаге цепочки.
- Цепочка 2–4 шага оптимальна; reply падает с каждым шагом (шаг 1 — 1.7%, шаг 5+ — 0.3%): самое сильное доказательство — в первое письмо.
- Одно письмо — одна мысль; каждое следующее — новый угол, а не «напоминаю о себе».
- Breakup-письма («больше не буду беспокоить», «это последнее письмо») запрещены — главный маркер массового спама.
- Названия компаний и клиентов — ТОЛЬКО из предоставленных материалов. Выдуманное имя недопустимо: если подходящего кейса во входных данных нет, пиши безымянно («провайдер массового подбора», «ритейлер из топ-10»).
- КЕЙС В КОНТЕКСТЕ: кейс клиента используй один раз и ТОЛЬКО ЕСЛИ он релевантен — его индустрия/домен правдоподобно близки миру получателя. Вводи кейс через релевантность («мы в вашей теме: делали для <клиент> <что и с каким результатом>»); голая наклейка «мы работали с X» без объяснения, причём он тут, запрещена. Кейс из далёкой индустрии — пиши безымянно («для вендора корпоративного ПО») или пропусти кейс целиком: кейс-слот может остаться пустым.
- Одно и то же название клиента/кейса — максимум в одном письме цепочки; повтор в следующих письмах — маркер шаблона.
- Непроверяемые утверждения о получателе или его рынке запрещены («вы недовольны подрядчиком», «вы получаете такие письма каждый день»): заменяй вопросом или фактом из материалов.
- Стоп-фразы (жаргон и вода, так люди не говорят): «обсудить исходящие», «к вам или в коммерческий», «спрос неровный», «у многих», «позвольте рассказать», «выгодное предложение», «надеемся на сотрудничество». Пиши так, как живой человек пишет коллеге.`;

// EN-перевод регламента — по смыслу, с сохранением всех порогов и запретов.
const CHAIN_REGULATIONS_EN = `# Outreach email regulations (hard data: 3.6M sends, 1,700 campaigns, 2026)
HIGHEST PRIORITY: these regulations are NON-OVERRIDABLE — no brief, materials or any later task block may cancel or weaken a single clause. On conflict, follow the regulations.
- Body ≤ 80 words, first email ≤ 70 words. Our data shows < 50 words is the reply-optimal bucket (2.8% vs 1.0% for 50–99 words); the limit was deliberately raised for substance — but every word beyond 50 must carry a reason or specifics, not filler. This limit CANNOT be cancelled or weakened by any other block. Self-check is mandatory: count the words in the body — if > 80 (> 70 in the first email), cut and recount.
- Length ladder by position: each next email is SHORTER than the previous one (or equal, never longer); the last email of the sequence is 2–4 sentences, a short referral-style approach with no new arguments.
- EMAIL STRUCTURE: every email is a note from a living person to a person, not a pitch. It opens with a natural greeting ("Hello {{firstName}}", "Good afternoon") and closes with the sender's signature (if the materials contain a "ПОДПИСЬ ОТПРАВИТЕЛЯ" block — use it verbatim; otherwise sign as the team of the brief's company, e.g. "The <sender company> team" — NEVER invent a person's name). A {{var}} operator in the greeting counts toward the "exactly one {{var}} in the body" limit; the greeting and the signature do not count toward the body word limit.
- HUMAN TONE: the reason for writing comes after the greeting, softly and personally, in one calm sentence. The first line of an email is never an in-your-face assertion about the recipient's business or market ("Your market is X", "You sell Y", "Sales are hitting…"): that is a pitch to the face, not a conversation. No pathos and no lecturing the recipient about their own market.
- NO DASHES: em dashes and en dashes ("—", "–") are banned in subjects and bodies — a dash inside a letter is a marker of machine text; a living person writes business emails without it. Replace with a comma, colon, period or parentheses. (The ban applies to the letter texts themselves — subjects and bodies; the output-format service markers do not count.)
- REASON FOR WRITING: every email, after the greeting, opens with a concrete reason — why this recipient, why now. A reason is an observable fact about the recipient or their world (a signal about their company/site, a fact of their industry, a sharp number from the materials), delivered naturally, humanly. A generic segment truism as the reason is banned: "everyone in the segment has problem X", "sales are hitting a traffic ceiling", "many in the industry…" — those are platitudes, not reasons.
- 1–3 sentences per body reply best; 9–12 sentences cut reply threefold.
- 3–4 word subjects are the reply optimum (1.8%); 12+ word subjects kill reply (−58%). A question in the subject gives +54% reply.
- {{var}} personalization in the subject — +117% reply, in the body — +44%. Mandatory: {{var}} in EVERY subject; exactly one {{var}} in every body.
- Numbers in the body — MINUS 63% reply; numbers in the subject — minus 34%. Avoid digits, percentages, amounts, "top-5". The single exception — one anchoring number from the materials when it IS the email's reason or the case proof: without it the fact does not work.
- Timeline hooks ("in 2 weeks", "in N days") — minus 29% reply. Do not promise deadlines in digits.
- The CTA "a call / 15-minute chat?" — MINUS 36.8% reply (0.70% vs 1.11%, n=682,531, p<0.001): asking for a meeting or a call in an email is banned. Every email carries exactly one CTA: one soft, pressure-free question (check interest, offer to send details/an example); an email with no CTA question at all is a gross violation. In email 1 the CTA is hybrid: ONE question (one question mark) with two branches — the recipient's interest + a frictionless referral, in natural human wording: "Is this relevant to you, or could you point me to who owns <topic> on your team?". A pure referral ask ("who is the best person to talk to?") is allowed ONLY in the last step of the sequence.
- A 2–4 step sequence is optimal; reply drops with every step (step 1 — 1.7%, step 5+ — 0.3%): the strongest proof goes into the first email.
- One email — one idea; each next email — a new angle, not "just bumping this".
- Breakup emails ("I won't bother you anymore", "this is my last email") are banned — the top marker of mass spam.
- Company and client names — ONLY from the provided materials. An invented name is unacceptable: if no suitable case exists in the input, write nameless ("a mass-hiring provider", "a top-10 retailer").
- CASE IN CONTEXT: use a client case once and ONLY IF relevant — its industry/domain is plausibly close to the recipient's world. Introduce the case through relevance ("we're in your space: we did <what, with what result> for <client>"); a bare "we worked with X" sticker with no explanation of why it belongs here is banned. A case from a far-away industry — write nameless ("for a corporate software vendor") or skip the case entirely: the case slot may stay empty.
- The same client/case name — in at most one email of the sequence; repeating it in later emails is a template marker.
- Unverifiable claims about the recipient or their market are banned ("you are unhappy with your contractor", "you get emails like this every day"): replace with a question or a fact from the materials.
- Stop phrases (jargon and filler — people do not talk like that): "discuss outbound", "to you or to the sales team", "demand is uneven", "many companies", "allow me to tell you", "a lucrative offer", "hoping for cooperation". Write the way a living person writes to a colleague.`;

/**
 * Регламент по языку цепочки (he_chains.language). PL-перевода пока нет —
 * осознанно используется RU-вариант (то же для системных блоков ниже).
 */
export const CHAIN_REGULATIONS: Record<HeChainLanguage, string> = {
  ru: CHAIN_REGULATIONS_RU,
  en: CHAIN_REGULATIONS_EN,
  pl: CHAIN_REGULATIONS_RU,
};

/* ─────────────── Опциональные инжекты качества ─────────────── */

/**
 * Опциональные поля-инжекты, которые принимают сборщики промптов
 * chain и template (генерация, критик, рерайт; signatureOverride —
 * только генерация и рерайт).
 */
export interface HePromptInjections {
  /** Пример письма клиента — эталон стиля (в промпт попадает ≤ 4000 символов). */
  styleExample?: string | null;
  /** Темы/ходы, доказавшие reply в наших кампаниях (вдохновение, не копирование). */
  winnerPatterns?: Array<{ pattern: string; reply_pct: number }>;
  /**
   * Подпись отправителя из брифа (signature_override) — вставляется дословно
   * в конце каждого письма. Без неё модель подписывается командой компании
   * из брифа и НЕ выдумывает имя человека.
   */
  signatureOverride?: string | null;
}

/** Максимум символов эталона стиля в промпте. */
const STYLE_EXAMPLE_MAX_CHARS = 4000;

/** Максимум символов подписи отправителя в промпте (зеркало серверного капа PATCH). */
const SIGNATURE_MAX_CHARS = 500;

/**
 * Блок «ПОДПИСЬ ОТПРАВИТЕЛЯ»: заданная пользователем подпись ставится дословно
 * в конце каждого письма — модель не выдумывает имя человека.
 * Пустой/отсутствующий вход → пустая строка (блок не инжектится).
 */
export function renderSignatureBlock(signatureOverride?: string | null): string {
  const text = signatureOverride?.trim() ?? '';
  if (!text) return '';
  return `ПОДПИСЬ ОТПРАВИТЕЛЯ — использовать дословно в конце каждого письма (не переписывать, не переводить, не дополнять):
"""
${text.slice(0, SIGNATURE_MAX_CHARS)}
"""

`;
}

/**
 * Блок «ЭТАЛОН СТИЛЯ КЛИЕНТА». Имитация стиля важнее дефолтных правил тона,
 * но никогда не отменяет регламент, запрет выдуманных имён и структуру оффера.
 * Пустой/отсутствующий вход → пустая строка (блок не инжектится).
 */
export function renderStyleExampleBlock(styleExample?: string | null): string {
  const text = styleExample?.trim() ?? '';
  if (!text) return '';
  return `ЭТАЛОН СТИЛЯ КЛИЕНТА — подражай манере, структуре фраз и тону этого письма (не копируй содержание и факты):
"""
${text.slice(0, STYLE_EXAMPLE_MAX_CHARS)}
"""
Правило приоритета: имитация эталона важнее дефолтных правил тона, но НИКОГДА не отменяет регламент писем, запрет на выдуманные имена/кейсы и обязательную структуру оффера.

`;
}

/**
 * Блок «ПРОВЕННЫЕ ПАТТЕРНЫ»: вдохновение для тем и хуков — адаптировать,
 * не копировать дословно; проценты никогда не цитируются внутри писем.
 * Пустой/отсутствующий вход → пустая строка (блок не инжектится).
 */
export function renderWinnerPatternsBlock(
  winnerPatterns?: Array<{ pattern: string; reply_pct: number }>,
): string {
  const list = (winnerPatterns ?? []).filter((p) => p?.pattern?.trim());
  if (!list.length) return '';
  const items = list.map((p) => `- ${p.pattern.trim()} (reply: ${p.reply_pct}%)`).join('\n');
  return `ПРОВЕННЫЕ НАШИМИ КАМПАНИЯМИ ПАТТЕРНЫ (темы/ходы, которые реально давали ответы в похожих сегментах; reply% — наш датасет):
${items}
Правило: используй как вдохновение для ТЕМ писем и хуков — адаптируй под вертикаль, не копируй дословно. Проценты reply никогда не цитируй внутри писем.

`;
}

export interface ChainPromptHypothesis {
  title: string;
  description: string;
  potential_pct: number;
  evidence: HeEvidenceItem[];
  /** Тир гипотезы (1 — очевидные ЦА, 2 — смежные, 3 — неочевидные рынки). */
  tier?: number;
  /** true — гипотеза подтверждена специалистом (status='accepted'), приоритет. */
  confirmed?: boolean;
}

export interface ChainPromptInput extends HePromptInjections {
  language: HeChainLanguage;
  verticalName: string;
  verticalSummary: string;
  synonyms: string[];
  /** Гипотезы вертикали с доказательствами (уже отсортированы по %). */
  hypotheses: ChainPromptHypothesis[];
  /** Текстовый снапшот брифа клиента (профиль сайта и т.п.). */
  briefText: string;
  /** Опционально: offer_override из брифа — авторитетная формулировка оффера, использовать дословно. */
  offerOverride?: string;
  /** Опционально: описание доступных операторов персонализации. */
  operatorsHint?: string;
  /**
   * Опционально: выбранный кейс клиента из кейс-банка (he_cases) под эту
   * вертикаль — ГЛАВНОЕ доказательство цепочки. Отсутствует → обычное
   * правило: один кейс из материалов/брифа или безымянно.
   */
  clientCase?: HeCaseDraft | null;
}

/* ─────────────── Локализованные части задачи ─────────────── */

const PRIMER_ACK: Record<HeChainLanguage, string> = {
  ru: 'Материалы изучены: бриф, вертикаль, доказательства и регламент в контексте. Жду команду.',
  en: 'Materials reviewed: brief, vertical, evidence and regulations are in context. Awaiting your command.',
  pl: 'Materiały przeanalizowane: brief, pion, dowody i regulamin są w kontekście. Czekam na polecenie.',
};

const TASK_PROMPTS: Record<HeChainLanguage, string> = {
  ru: `Ты — senior email outreach специалист с опытом запуска 400+ холодных B2B-кампаний (средний reply rate 8–18%).

Напиши цепочку из 4 писем (допустимо 3–5) для холодной рассылки по вертикали, описанной в материалах выше. Клиент — аутрич-агентство: продаём аутрич как услугу, письма идут лицам, принимающим решения, в целевой вертикали.

ШАГ 0 — ОФФЕР (обязательная структура). Прежде чем писать, сформулируй про себя оффер из четырёх частей — в терминах самой вертикали:
1. УСЛУГА ПРОСТЫМИ СЛОВАМИ: кто клиент — одна фраза, понятная постороннему («email-аутрич под ключ», «кадровое агентство по массовому подбору»), из брифа/профиля сайта; если в материалах есть блок «ОФФЕР КЛИЕНТА (offer_override)» — используй его формулировку дословно, не перепридумывай. Размытые ярлыки («внешняя команда», «партнёр по росту») запрещены.
2. РЕЗУЛЬТАТ ДЛЯ ПОЛУЧАТЕЛЯ: что получает бизнес получателя, в его единицах — встречи/лиды/сделки с названными целевыми ролями за период («3–5 встреч в месяц с директорами по логистике грузовладельцев»). Выгода — это то, что приобретает получатель, а НЕ процесс отправителя: «пишем письма», «занимаемся аутричем» как выгода запрещены. В письме 1 результат подаётся через роли/сегменты, без цифр-каденсов (см. ТОН ниже).
3. СТАРТ: первый шаг с низким порогом входа («тест 2 недели на узком сегменте»).
4. ДОКАЗАТЕЛЬСТВО: один кейс (реальное имя — только из материалов), назначенный ровно в ОДНО письмо цепочки.
Оффер (пп. 1–2) обязан явно звучать в письме 1: получатель сразу должен понять, кто пишет, что предлагают и как это поможет ему. Цифры и сроки в тексте самих писем — только по правилам регламента.

ТОН — ЧЕЛОВЕЧЕСКИЙ ДИАЛОГ, НЕ РЕКЛАМА. Мы не рассылаем рекламу — ведём человеческий диалог: почему написали, что предлагаем, как и почему можем помочь.
- Письмо читается как сообщение от одного человека другому: «пишу», «у нас», разговорный русский, короткие предложения. Не как лендинг и не как презентация компании.
- Каждое письмо начинается с естественного приветствия («Здравствуйте, {{firstName}}», «Добрый день») и заканчивается подписью отправителя (если в материалах есть блок «ПОДПИСЬ ОТПРАВИТЕЛЯ» — используй её дословно; иначе подписывайся командой компании из брифа, например «Команда <компания клиента>» — имя человека НЕ придумывай).
- Первая строка письма — приветствие, за ним повод: мягко и лично, одним спокойным предложением. Утверждения в лоб про бизнес или рынок получателя как открыватели запрещены («Ваш рынок X», «Вы продаёте Y», «Продажи упираются…»): без пафоса и без уроков получателю про его же рынок.
- Тире («—», «–») в темах и телах писем запрещены: это маркер машинного текста. Заменяй запятой, двоеточием, точкой или скобками.
- Рекламные клише запрещены: «лидер», «лучший», «эффективный», «поток заявок», «гарантируем», «выгодно», «бесплатно», «команда профессионалов», «индивидуальный подход» и подобные.
- В письме 1 — никаких маркетинговых цифр (цифры в теле — минус 63% reply): результат для получателя формулируй через роли/сегменты («встречи с HRD крупных работодателей»), а не каденсом «3–5 встреч в месяц».

Как использовать материалы:
- Вертикаль и её синонимы — это ЦА: пиши так, будто понимаешь их индустрию изнутри (их термины, их боли, их метрики).
- Покрывай вертикаль ЦЕЛИКОМ: если в описании вертикали перечислены суб-сегменты, формулировки должны быть нейтральными и подходить каждому из них. Запрещено молча сужать цепочку до одного суб-сегмента или перескакивать на другую аудиторию в середине цепочки.
- Гипотезы и доказательства — ПЕРВИЧНЫЙ источник болей, углов и конкретики: рыночные факты, чужие кейсы, регуляторные драйверы. Гипотезы с пометкой «✓ ПОДТВЕЖДЕНО СПЕЦИАЛИСТОМ» подтверждены человеком — они в приоритете. Не вводи рыночные углы и боли, противоречащие списку гипотез; отклонённые специалистом гипотезы в материалах просто отсутствуют — не упоминай их существование. Опирайся на список, но НЕ цитируй URL в письмах и не грузи цифрами (см. регламент).
- Бриф клиента — оффер и УТП. Одно письмо — одна мысль/одно УТП, распредели их по цепочке.
- Если в материалах есть блок «КЕЙС КЛИЕНТА» — это единственный кейс-слот цепочки (кейсы из брифа — только когда этого блока нет): используй его один раз и ТОЛЬКО ЕСЛИ релевантен миру получателя (индустрия/домен кейса правдоподобно близки вертикали). Вводи через релевантность: «мы в вашей теме: делали для <клиент> <что и с каким результатом>» — никогда голой наклейкой «мы работали с X». Кейс из далёкой индустрии → безымянно («для вендора корпоративного ПО») или пропусти кейс-слот целиком. Реальные цифры — только из блока, максимум в ОДНОМ письме, и никогда не приписывай его другой индустрии, чем указана в блоке.
- Первое письмо — самое сильное: лучший угол + лучшее доказательство. Фоллоу-апы — новые углы, а не «пинг».

Обязательная конструкция цепочки:
- Письмо 1 (обязательные биты, человеческим диалогом, а не питчем): (1) ПРИВЕТСТВИЕ — естественное («Здравствуйте, {{firstName}}», «Добрый день»); (2) ПОВОД — мягко и лично, одним спокойным предложением: почему пишу именно этому получателю сейчас. Иерархия: (а) наблюдаемый факт о мире получателя из материалов — сигнал из описания вертикали, факт из бренд-облака, острая цифра из доказательств гипотез (цитируй её естественно, не как статистику); (б) если ничего конкретного нет — самый острый доказательный факт вертикали с его реальной цифрой как повод. Запрещено открывать письмо общим местом про сегмент («у всех в сегменте проблема X», «продажи упираются в потолок трафика»), голой категоризацией («Вы продаёте в X»), непроверяемым утверждением о самом получателе или любым утверждением в лоб как первой строкой письма (первой строкой идёт приветствие); (3) что предлагаю — одна простая строка: услуга простыми словами + для кого; (4) как и почему могу помочь — доказательство/релевантность (результат для получателя через роли/сегменты, без маркетинговых цифр); (5) один мягкий вопрос — гибридный CTA по регламенту («Это актуально вам, или подскажете, кто у вас отвечает за <тема>?»); (6) ПОДПИСЬ отправителя (если в материалах есть блок «ПОДПИСЬ ОТПРАВИТЕЛЯ» — используй её дословно; иначе подписывайся командой компании из брифа, например «Команда <компания клиента>» — имя человека НЕ придумывай). Тест 5 секунд: незнакомец после письма 1 мгновенно отвечает — кто это, что предлагают, как это поможет мне; не проходит — перепиши. Описания процесса отправителя («собираем сигналы», «пишем под контекст») в письме 1 запрещены — процессу место в письмах 2+.
- Повод есть у КАЖДОГО письма, не только у первого: новый угол письма = новый факт-повод из материалов, а не «напоминаю о прошлом письме» и не «пинг».
- A/B-ВАРИАНТЫ: каждое письмо пиши в ДВУХ вариантах с РАЗНЫМИ поводами. Вариант A (основной, блок ---LETTER N---) — повод от якоря со стороны получателя (его мир, его факты по иерархии выше). Вариант B (блок ---LETTER N B---) — повод от якоря сегмента/рынка (самый острый доказательный факт вертикали с его реальной цифрой). B — не перефразировка A, а другой угол; оба варианта проходят весь регламент (длина, {{var}}, ровно один CTA).
- Конкретный кейс/доказательный факт (имя клиента и/или конкретный результат) — ТОЛЬКО из материалов и ровно в ОДНОМ письме цепочки: одно и то же название кейса/клиента не может появляться больше чем в одном письме. Если подходящего кейса в материалах нет — пиши безымянно; выдумывать названия запрещено.
- Чистая просьба направить к нужному человеку («к кому лучше обратиться?») — только в последнем письме, один раз на всю цепочку; в письме 1 реферальная ветка допустима только внутри гибридного CTA (см. регламент).
${'{{OPERATORS_HINT}}'}
ПРИМЕР — как нельзя и как надо (пример структуры, а не текст для копирования):
ПЛОХО: «У вендоров ПО продажи упираются в потолок трафика. Мы из Polza: пишем холодные письма за компанию, которая продаёт сложный продукт другому бизнесу, и доводим до разговора с ЛПР. Так работали с BPMSoft. Прислать пример цепочки под {{company}}?»
Почему плохо: нет ни приветствия, ни подписи, а первая строка — утверждение в лоб про чужой рынок: питч, а не записка от человека; повод — общее место про сегмент (трюизм про «потолок трафика» верен для всех и ни для кого конкретно); услуга не названа простыми словами, клиент описан через вложенные придаточные; кейс «Так работали с BPMSoft» — наклейка без контекста: непонятно, что делали и причём тут получатель.
ХОРОШО: «Добрый день.

Видел цифру по вашей отрасли: доля сделок, застрявших на этапе пилота, выросла за год в 1,7 раза, и подумал о вас.

Мы в Polza делаем email-аутрич под ключ: находим компании, которым нужен ваш продукт, и приводим их на разговор с ЛПР. Начнём с теста на узком сегменте. Мы в вашей теме: для Диасофт собирали встречи с финансовыми директорами.

Это актуально вам, или подскажете, кто в {{company}} отвечает за новых клиентов?

С уважением,
Сергей, Polza»
Почему хорошо: открывается приветствием, повод мягкий и личный, с опорной цифрой из материалов, а не утверждение в лоб; услуга названа простыми словами; кейс введён через релевантность («мы в вашей теме») с понятным результатом, а не наклейкой; CTA — один гибридный вопрос живой формулировкой; есть подпись отправителя; ни одного тире.
ЖЁСТКИЕ САМОПРОВЕРКИ ПЕРЕД ВЫДАЧЕЙ (не выполнено — перепиши):
- Посчитай слова в каждом теле: > 80 — сократи и пересчитай; письмо 1 — ≤ 70 слов. Каждое слово сверх 50 несёт повод или конкретику, не воду.
- У КАЖДОГО письма есть конкретный повод — факт про получателя/его мир, а не общее место про сегмент; письмо 1 — по иерархии повода выше.
- Каждое письмо начинается с естественного приветствия («Здравствуйте, {{firstName}}», «Добрый день») и заканчивается подписью отправителя; первая строка — приветствие, а не утверждение в лоб про бизнес или рынок получателя («Ваш рынок X», «Вы продаёте Y», «Продажи упираются…»).
- Ни в одной теме и ни в одном теле нет тире («—», «–»): всё заменено запятой, двоеточием, точкой или скобками.
- У каждого письма есть вариант B (---LETTER N B---) с ДРУГИМ поводом: A — от якоря получателя, B — от якоря сегмента/рынка; B — не перефразировка A.
- Кейс (если есть) введён через релевантность и его индустрия близка получателю; иначе — безымянно или без кейса.
- В КАЖДОЙ теме есть {{var}}; в каждом теле — ровно один {{var}}.
- В каждом письме — ровно один CTA-вопрос (ноль CTA — нарушение: письмо без вопроса не пропускай); в письме 1 — гибридный вопрос с одним вопросительным знаком («Это актуально вам, или подскажете, кто … отвечает за …?»).
- Нет непроверяемых утверждений о получателе или его рынке: такие мысли оформляй вопросом или фактом из материалов.
- Нет стоп-фраз из регламента («обсудить исходящие», «к вам или в коммерческий», «спрос неровный», «у многих») и рекламных клише («лидер», «лучший», «гарантируем», «выгодно», «бесплатно»).
- В письме 1 нет маркетинговых цифр: результат получателя сформулирован через роли/сегменты (единственная допустимая цифра — опорный факт повода из материалов).
- Перечитай каждое письмо вслух: согласование падежей и родов должно быть идеальным (пример ошибки: «на постоянной работой» → «на постоянной работе»).

ЯЗЫК: вся цепочка строго на русском. Бренды и устоявшиеся термины индустрии — в оригинале.

ФОРМАТ ВЫВОДА (ОБЯЗАТЕЛЕН — иначе ответ не пройдёт парсинг):
---LETTER 1---
Тема: <тема письма 1, вариант A>

<тело письма 1, вариант A>

---LETTER 1 B---
Тема: <тема письма 1, вариант B — другой повод>

<тело письма 1, вариант B>

---LETTER 2---
Тема: <тема письма 2, вариант A>

<тело письма 2, вариант A>

---LETTER 2 B---
Тема: <тема письма 2, вариант B>

<тело письма 2, вариант B>

...и так далее до последнего письма (у каждого — вариант B своим блоком сразу после варианта A). Никаких пояснений до/после блоков. Маркеры «---LETTER N---», «---LETTER N B---» и слово «Тема:» не меняй. ЗАПРЕЩЕНО: JSON, markdown-заголовки (#, ##), болд (**), нумерованные списки вместо маркеров — только указанный формат блоков.`,

  en: `You are a senior email outreach specialist with 400+ launched cold B2B campaigns (average reply rate 8–18%).

Write a sequence of 4 emails (3–5 is acceptable) for a cold campaign targeting the vertical described in the materials above.

How to use the materials:
- The vertical and its synonyms are the audience: write as if you know their industry from the inside (their terms, their pains, their metrics).
- The hypotheses list is the PRIMARY source of pains, angles and specifics: market facts, third-party cases, regulatory drivers. Items marked "✓ ПОДТВЕЖДЕНО СПЕЦИАЛИСТОМ" are human-confirmed and take priority. Do not introduce market angles or pains that contradict the list; rejected hypotheses are simply absent from the materials — never mention their existence. Rely on the list, but do NOT cite URLs in the emails and do not overload them with numbers (see the regulations).
- The client brief is the offer and USPs. One email — one idea/one USP; spread them across the sequence.
- If the materials contain a "КЕЙС КЛИЕНТА" block — that is the single case slot of the sequence (brief cases remain a fallback only when this block is absent): use it once and ONLY IF relevant — the case's industry/domain is plausibly close to the recipient's world. Introduce it through relevance ("we're in your space: we did <what, with what result> for <client>"), never as a bare "we worked with X" sticker. A case from a far-away industry → write nameless ("for a corporate software vendor") or skip the case slot entirely. Real numbers only from the block, in at most ONE email, and never attribute it to an industry other than the one stated in the block.
- The first email is the strongest: best angle + best proof. Follow-ups bring new angles, not "just bumping this".

STEP 0 — THE OFFER (mandatory structure). Before writing, formulate the offer in four parts — in the vertical's own terms:
1. THE SERVICE IN PLAIN WORDS: what the client is — one phrase a stranger understands ("done-for-you B2B email outreach", "a staffing agency for mass hiring"), from the brief/site profile; if the materials contain the "ОФФЕР КЛИЕНТА (offer_override)" block — use its wording verbatim, do not reinvent it. Vague labels ("an external team", "a growth partner") are banned.
2. THE RECIPIENT'S OUTCOME: what the recipient's business gains, in the recipient's units — meetings/leads/deals with named target roles per period ("3–5 meetings a month with logistics directors at shippers"). The benefit is what the recipient gains, NEVER the sender's process: "we write emails", "we do outreach" as the benefit are banned. In email 1 the outcome is rendered via roles/segments, without cadence numbers (see TONE below).
3. THE START: a low-commitment first step ("a 2-week test on a narrow segment").
4. PROOF: one case (a real name from the materials only), assigned to exactly ONE email of the sequence.
The offer (parts 1–2) must be explicit in email 1: the recipient must instantly understand who is writing, what is offered, and how it helps them. Numbers and timelines inside the emails themselves follow the regulations only.

TONE — HUMAN DIALOGUE, NOT ADVERTISING. We are not blasting ads — we are having a human conversation: why we wrote, what we offer, how and why we can help.
- The email reads as one person writing to another: "I'm writing", "we", conversational language, short sentences. Never like a landing page or a company deck.
- Every email opens with a natural greeting ("Hello {{firstName}}", "Good afternoon") and closes with the sender's signature (if the materials contain a "ПОДПИСЬ ОТПРАВИТЕЛЯ" block — use it verbatim; otherwise sign as the team of the brief's company, e.g. "The <client company> team" — NEVER invent a person's name).
- The first line is a greeting, then the reason for writing: softly and personally, in one calm sentence. In-your-face assertions about the recipient's business or market as an opener are banned ("Your market is X", "You sell Y", "Sales are hitting…"): no pathos, no teaching the recipient their own market.
- Em dashes and en dashes ("—", "–") are banned in subjects and bodies: a dash inside a letter is a marker of machine text. Use commas, colons, periods or parentheses instead.
- Advertising clichés are banned: "leader", "best", "effective", "stream of leads", "we guarantee", "free", "team of professionals", "individual approach" and the like.
- No marketing numbers in email 1 (digits in the body → −63% reply): phrase the recipient's outcome via roles/segments ("meetings with HR directors at large employers"), not a cadence like "3–5 meetings a month".

Mandatory sequence construction:
- Email 1 (mandatory beats, rendered as human dialogue, not a pitch): (1) A NATURAL GREETING ("Hello {{firstName}}", "Good afternoon"); (2) THE REASON FOR WRITING — softly and personally, one calm sentence: why this recipient, why now. Hierarchy: (a) an observable fact about the recipient's world from the materials — a signal from the vertical description, a brand-cloud fact, a sharp evidence number from the vertical's hypotheses (cite it naturally, in human words); (b) if nothing concrete exists — the vertical's single sharpest evidence fact with its real number as the reason. Opening with a generic segment claim ("everyone in the segment has problem X", "sales hit a traffic ceiling") is banned, as are bare categorization ("You sell into X"), unverifiable claims about the recipient themselves, and any in-your-face assertion as the first line (the first line is the greeting); (3) what I offer — one simple line: the service in plain words + for whom; (4) how and why I can help — proof/relevance (the recipient's outcome via roles/segments, no marketing numbers); (5) one soft hybrid question — ONE question (one question mark) with two branches, interest + frictionless referral, in natural human wording: "Is this relevant to you, or could you point me to who owns <topic> on your team?"; (6) THE SENDER'S SIGNATURE (if the materials contain a "ПОДПИСЬ ОТПРАВИТЕЛЯ" block — use it verbatim; otherwise sign as the team of the brief's company, e.g. "The <client company> team" — NEVER invent a person's name). The 5-second test: after email 1 a stranger instantly answers — who is this, what do they offer, how does it help me; if it fails — rewrite. Self-centered process descriptions ("we collect signals", "we write to context") are banned from email 1 — process belongs to emails 2+.
- EVERY email (not just the first) opens with its own concrete reason: a new angle = a new fact-reason from the materials, never "just following up" or "bumping this".
- A/B VARIANTS: write EVERY email in TWO variants with DIFFERENT reasons/angles. Variant A (primary, the ---LETTER N--- block) — reason anchored on the recipient's side (their world, their facts, per the hierarchy above). Variant B (the ---LETTER N B--- block) — reason anchored on the segment/market side (the vertical's sharpest evidence fact with its real number). B is not a rephrase of A but a different angle; both variants pass the whole regulations (length, {{var}}, exactly one CTA).
- A specific case/proof (client name and/or concrete result) — from the materials ONLY, used once and ONLY IF relevant to the recipient's world, introduced through relevance ("we're in your space: ..."), in exactly ONE email of the sequence: the same named case/client may not appear in more than one email. If no suitable case exists or the case is from a far-away industry — write without names or skip the case entirely; inventing names is forbidden.
- A pure referral ask ("who should I talk to?") — only in the last email, once per sequence; in email 1 the referral branch is allowed only inside the hybrid CTA (see the regulations).

FINAL SELF-CHECK: read every email aloud — grammar and agreement must be flawless; no advertising clichés; no marketing numbers in email 1 (the only allowed digit is the one anchoring evidence fact of the reason); after the greeting, every email opens with a concrete reason (a fact about the recipient/their world, not a generic segment claim); every email starts with a natural greeting and ends with the sender's signature; the first line is a greeting, never an in-your-face assertion about the recipient's business or market; no em/en dashes ("—", "–") anywhere in subjects or bodies; every email has exactly one CTA question (zero CTAs is a violation, email 1 — the hybrid question with a single question mark); every email has a B variant with a DIFFERENT reason (A — recipient-side anchor, B — segment/market anchor); body ≤ 80 words, email 1 ≤ 70.
${'{{OPERATORS_HINT}}'}
LANGUAGE: write the entire sequence strictly in English, even though the materials may be in Russian. Convey the meaning, do not translate word for word.

OUTPUT FORMAT (MANDATORY — otherwise the response will fail parsing):
---LETTER 1---
Subject: <subject of email 1, variant A>

<body of email 1, variant A>

---LETTER 1 B---
Subject: <subject of email 1, variant B — different reason>

<body of email 1, variant B>

---LETTER 2---
Subject: <subject of email 2, variant A>

<body of email 2, variant A>

---LETTER 2 B---
Subject: <subject of email 2, variant B>

<body of email 2, variant B>

...and so on through the last email (each email's B variant in its own block right after variant A). No explanations before/after the blocks. Keep the "---LETTER N---", "---LETTER N B---" markers and the word "Subject:" exactly as shown.`,

  pl: `Jesteś starszym specjalistą ds. email outreach z ponad 400 uruchomionymi zimnymi kampaniami B2B (średni reply rate 8–18%).

Napisz sekwencję 4 maili (dopuszczalne 3–5) do zimnej kampanii pod pion opisany w materiałach powyżej.

Jak używać materiałów:
- Pion i jego synonimy to grupa docelowa: pisz tak, jakbyś znał ich branżę od środka (ich terminy, ich bóle, ich metryki).
- Lista hipotez to PIERWSZE źródło bólów, kątów i konkretów: fakty rynkowe, case studies, czynniki regulacyjne. Pozycje oznaczone «✓ ПОДТВЕЖДЕНО СПЕЦИАЛИСТОМ» zostały potwierdzone przez człowieka — mają priorytet. Nie wprowadzaj kątów rynkowych ani bólów sprzecznych z listą; odrzucone hipotezy są po prostu nieobecne w materiałach — nigdy nie wspominaj o ich istnieniu. Opieraj się na liście, ale NIE cytuj URL-i w mailach i nie przeciążaj liczbami (patrz regulamin).
- Brief klienta to oferta i USP. Jeden mail — jedna myśl/jeden USP; rozłóż je na całą sekwencję.
- Jeśli w materiałach jest blok «КЕЙС КЛИЕНТА» — to jedyny slot na case w sekwencji (case'y z briefu — tylko gdy tego bloku nie ma): użyj go raz i TYLKO JEŚLI jest trafny — branża/domena case'u jest wiarygodnie bliska światu odbiorcy. Wprowadzaj go przez trafność («jesteśmy w Twoim temacie: robiliśmy dla <klient> <co i z jakim rezultatem>»), nigdy gołą naklejką «pracowaliśmy z X». Case z dalekiej branży → pisz bez nazwy („dla vendora oprogramowania korporacyjnego") albo pomiń slot całkowicie. Prawdziwe liczby — tylko z bloku, maksymalnie w JEDNYM mailu, i nigdy nie przypisuj go do innej branży niż wskazana w bloku.
- Pierwszy mail jest najsilniejszy: najlepszy kąt + najlepszy dowód. Follow-upy wnoszą nowe kąty, nie "przypominam o sobie".

KROK 0 — OFERTA (obowiązkowa struktura). Zanim zaczniesz pisać, sformułuj dla siebie ofertę w czterech częściach — w terminologii samego pionu:
1. USŁUGA PROSTYMI SŁOWAMI: kim jest klient — jedna fraza zrozumiała dla osoby postronnej („email outreach pod klucz dla B2B", „agencja pracy od rekrutacji masowej"), z briefu/profilu strony; jeśli w materiałach jest blok „ОФФЕР КЛИЕНТА (offer_override)" — użyj jego sformułowania dosłownie, nie wymyślaj na nowo. Ogólnikowe etykiety („zewnętrzny zespół", „partner wzrostu") są zakazane.
2. REZULTAT DLA ODBIORCY: co zyskuje biznes odbiorcy, w jego jednostkach — spotkania/leady/transakcje z wymienionymi rolami docelowymi w danym okresie („3–5 spotkań miesięcznie z dyrektorami ds. logistyki u nadawców"). Korzyścią jest zysk odbiorcy, a NIE proces nadawcy: „piszemy maile", „zajmujemy się outreachem" jako korzyść są zakazane. W mailu 1 rezultat podawany jest przez role/segmenty, bez liczb-kadencji (patrz TON niżej).
3. START: pierwszy krok o niskim progu wejścia („2-tygodniowy test na wąskim segmencie").
4. DOWÓD: jeden case (prawdziwa nazwa — wyłącznie z materiałów), przypisany do DOKŁADNIE JEDNEGO maila sekwencji.
Oferta (punkty 1–2) musi brzmieć wprost w mailu 1: odbiorca musi od razu zrozumieć, kto pisze, co się mu oferuje i jak to mu pomoże. Liczby i terminy w treści samych maili — wyłącznie według zasad regulaminu.

TON — LUDZKI DIALOG, NIE REKLAMA. Nie rozsyłamy reklamy — prowadzimy ludzki dialog: dlaczego piszemy, co oferujemy, jak i dlaczego możemy pomóc.
- Mail czyta się jak wiadomość od jednego człowieka do drugiego: „piszę", „u nas", potoczny język, krótkie zdania. Nigdy jak landing page ani prezentacja firmy.
- Każdy mail zaczyna się naturalnym powitaniem („Dzień dobry {{firstName}}", „Dzień dobry") i kończy podpisem nadawcy (jeśli w materiałach jest blok «ПОДПИСЬ ОТПРАВИТЕЛЯ» — użyj go dosłownie; w przeciwnym razie podpisuj się zespołem firmy z briefu, np. „Zespół <firma klienta>" — NIGDY nie wymyślaj imienia osoby).
- Pierwsza linia to powitanie, potem powód: miękko i osobiście, jednym spokojnym zdaniem. Zakazane otwieranie twierdzeniem w twarz o biznesie lub rynku odbiorcy („Wasz rynek to X", „Sprzedajecie Y", „Sprzedaż uderza…"): bez patosu i bez pouczania odbiorcy o jego własnym rynku.
- Myślniki („—", „–") są zakazane w tematach i treściach maili: myślnik w liście to znak tekstu maszynowego. Zastępuj je przecinkiem, dwukropkiem, kropką lub nawiasami.
- Reklamowe frazesy są zakazane: „lider", „najlepszy", „skuteczny", „strumień zapytań", „gwarantujemy", „za darmo", „zespół profesjonalistów", „indywidualne podejście" i podobne.
- W mailu 1 — żadnych marketingowych liczb (cyfry w treści → −63% reply): rezultat dla odbiorcy formułuj przez role/segmenty („spotkania z dyrektorami HR u dużych pracodawców"), a nie kadencją „3–5 spotkań miesięcznie".

Obowiązkowa konstrukcja sekwencji:
- Mail 1 (obowiązkowe bity, prowadzone ludzkim dialogiem, nie pitczem): (1) POWITANIE — naturalne („Dzień dobry {{firstName}}", „Dzień dobry"); (2) POWÓD — miękko i osobiście, jednym spokojnym zdaniem: dlaczego piszę właśnie do tego odbiorcy i teraz. Hierarchia: (a) obserwowalny fakt o świecie odbiorcy z materiałów — sygnał z opisu pionu, fakt z brand cloud, ostra liczba z dowodów hipotez (cytuj ją naturalnie, po ludzku); (b) jeśli nie ma nic konkretnego — najostrzejszy fakt dowodowy pionu z jego prawdziwą liczbą jako powód. Zakazane otwieranie ogólnikiem o segmencie („wszyscy w segmencie mają problem X", „sprzedaż uderza w sufit ruchu"), gołą kategoryzacją („Sprzedajecie do X"), niesprawdzalnym twierdzeniem o samym odbiorcy oraz jakimkolwiek twierdzeniem w twarz jako pierwszą linią maila (pierwszą linią jest powitanie); (3) co oferuję — jedna prosta linia: usługa prostymi słowami + dla kogo; (4) jak i dlaczego mogę pomóc — dowód/trafność (rezultat dla odbiorcy przez role/segmenty, bez marketingowych liczb); (5) jedno miękkie hybrydowe pytanie — JEDNO pytanie (jeden znak zapytania) z dwiema gałęziami: zainteresowanie + bezproblemowe polecenie, naturalnym ludzkim sformułowaniem: „Czy to aktualne dla Ciebie, czy podpowiesz, kto u Was odpowiada za <temat>?"; (6) PODPIS nadawcy (jeśli w materiałach jest blok «ПОДПИСЬ ОТПРАВИТЕЛЯ» — użyj go dosłownie; w przeciwnym razie podpisuj się zespołem firmy z briefu, np. „Zespół <firma klienta>" — NIGDY nie wymyślaj imienia osoby). Test 5 sekund: obca osoba po mailu 1 natychmiast odpowiada — kto to, co oferuje, jak mi to pomoże; jeśli nie przechodzi — napisz od nowa. Autocentryczne opisy procesu nadawcy („zbieramy sygnały", „piszemy pod kontekst") są zakazane w mailu 1 — proces należy do maili 2+.
- KAŻDY mail (nie tylko pierwszy) otwiera własny konkretny powód: nowy kąt = nowy fakt-powód z materiałów, nigdy „przypominam o sobie".
- WARIANTY A/B: każdy mail pisz w DWÓCH wariantach z RÓŻNYMI powodami. Wariant A (główny, blok ---LETTER N---) — powód od kotwicy po stronie odbiorcy (jego świat, jego fakty wg hierarchii wyżej). Wariant B (blok ---LETTER N B---) — powód od kotwicy segmentu/rynku (najostrzejszy fakt dowodowy pionu z prawdziwą liczbą). B to nie parafraza A, lecz inny kąt; oba warianty przechodzą cały regulamin (długość, {{var}}, dokładnie jedno CTA).
- Konkretny case/fakt dowodowy (nazwa klienta i/lub konkretny wynik) — WYŁĄCZNIE z materiałów, użyty raz i TYLKO JEŚLI trafny dla świata odbiorcy, wprowadzony przez trafność („jesteśmy w Twoim temacie: …"), w DOKŁADNIE JEDNYM mailu sekwencji: ta sama nazwa case'u/klienta nie może pojawić się w więcej niż jednym mailu. Jeśli w materiałach nie ma odpowiedniego case'u albo case jest z dalekiej branży — pisz bez nazw lub pomiń case całkowicie; wymyślanie nazw jest zakazane.
- Czysta prośba o skierowanie do właściwej osoby („do kogo lepiej się zwrócić?") — tylko w ostatnim mailu, raz na całą sekwencję; w mailu 1 gałąź polecenia jest dozwolona tylko wewnątrz hybrydowego CTA (patrz regulamin).

OSTATECZNA SAMOKONTROLA: przeczytaj każdy mail na głos — odmiana przypadków i rodzajów musi być bezbłędna; bez reklamowych frazesów; bez marketingowych liczb w mailu 1 (jedyna dozwolona cyfra to oporowy fakt powodu); po powitaniu każdy mail otwiera konkretny powód (fakt o odbiorcy/jego świecie, nie ogólnik o segmencie); każdy mail zaczyna się naturalnym powitaniem i kończy podpisem nadawcy; pierwsza linia to powitanie, nigdy twierdzenie w twarz o biznesie lub rynku odbiorcy; zero myślników („—", „–") w tematach i treściach; każdy mail ma dokładnie jedno pytanie CTA (zero CTA to naruszenie, mail 1 — pytanie hybrydowe z jednym znakiem zapytania); każdy mail ma wariant B z INNYM powodem (A — kotwica odbiorcy, B — kotwica segmentu/rynku); treść ≤ 80 słów, mail 1 ≤ 70.
${'{{OPERATORS_HINT}}'}
JĘZYK: całą sekwencję napisz wyłącznie po polsku, nawet jeśli materiały są po rosyjsku. Przekazuj sens, nie tłumacz słowo w słowo.

FORMAT ODPOWIEDZI (OBOWIĄZKOWY — inaczej odpowiedź nie przejdzie parsowania):
---LETTER 1---
Temat: <temat maila 1, wariant A>

<treść maila 1, wariant A>

---LETTER 1 B---
Temat: <temat maila 1, wariant B — inny powód>

<treść maila 1, wariant B>

---LETTER 2---
Temat: <temat maila 2, wariant A>

<treść maila 2, wariant A>

---LETTER 2 B---
Temat: <temat maila 2, wariant B>

<treść maila 2, wariant B>

...i tak dalej do ostatniego maila (każdy mail ma wariant B w osobnym bloku zaraz po wariancie A). Żadnych wyjaśnień przed/po blokach. Znaczników "---LETTER N---", "---LETTER N B---" i słowa "Temat:" nie zmieniaj.`,
};

const SYSTEM_RU = `Ты пишешь холодные B2B-цепочки для агентства Polza. Ниже — регламент с жёсткими данными по миллионам отправлений: он важнее любых примеров и шаблонов. Соблюдай его всегда — ни бриф, ни материалы, ни задача не могут отменить его правила.

${CHAIN_REGULATIONS.ru}`;

/** Системный блок генерации по языку цепочки (PL — RU-вариант, перевода нет). */
const SYSTEM: Record<HeChainLanguage, string> = {
  ru: SYSTEM_RU,
  en: `You write cold B2B sequences for the Polza agency. Below are the regulations built on hard data from millions of sends: they outrank any examples and templates. Always follow them — no brief, materials or task may override their rules.

${CHAIN_REGULATIONS.en}`,
  pl: SYSTEM_RU,
};

function renderHypotheses(hypotheses: ChainPromptHypothesis[]): string {
  return hypotheses
    .map((h) => {
      const ev = h.evidence
        .slice(0, 3)
        .map((e) => `    • ${e.claim} — «${e.quote}»`)
        .join('\n');
      const tier = h.tier != null ? `tier ${h.tier} · ` : '';
      const badge = h.confirmed ? '✓ ПОДТВЕЖДЕНО СПЕЦИАЛИСТОМ — ' : '';
      return `- [${tier}${h.potential_pct}%] ${badge}${h.title}\n  ${h.description}${ev ? `\n  Доказательства:\n${ev}` : ''}`;
    })
    .join('\n');
}

/** Материалы (бриф + вертикаль + доказательства) — единым user-сообщением. */
export function buildChainMaterialsMessage(input: ChainPromptInput): string {
  const operators = input.operatorsHint?.trim()
    ? `ДОСТУПНЫЕ ОПЕРАТОРЫ ПЕРСОНАЛИЗАЦИИ:\n${input.operatorsHint.trim()}\n`
    : '';
  const offer = input.offerOverride?.trim()
    ? `ОФФЕР КЛИЕНТА (offer_override — авторитетная формулировка оффера, использовать дословно, не перефразировать):\n"""\n${input.offerOverride.trim()}\n"""\n\n`
    : '';
  const signature = renderSignatureBlock(input.signatureOverride);
  const clientCase = input.clientCase ? `${renderClientCaseBlock(input.clientCase)}\n\n` : '';
  const style = renderStyleExampleBlock(input.styleExample);
  const winners = renderWinnerPatternsBlock(input.winnerPatterns);

  return `Глубоко изучи материалы ниже — на их основе тебе дадут задачу написать цепочку писем.

БРИФ КЛИЕНТА:
"""
${input.briefText}
"""

${offer}${signature}${clientCase}ВЕРТИКАЛЬ: ${input.verticalName}
${input.verticalSummary}
Синонимы вертикали (как ещё называют этот сегмент): ${input.synonyms.join(', ') || '—'}

ГИПОТЕЗЫ ВЕРТИКАЛИ С ДОКАЗАТЕЛЬСТВАМИ (ПЕРВИЧНЫЙ источник болей, углов и доказательств; пометка «✓ ПОДТВЕЖДЕНО СПЕЦИАЛИСТОМ» — гипотеза подтверждена человеком и в приоритете):
${renderHypotheses(input.hypotheses)}

${operators}${style}${winners}Держи всё это в контексте.`;
}

/**
 * Полная цепочка сообщений: system (регламент) → user (материалы) →
 * assistant (праймер-ack) → user (задача на целевом языке).
 */
export function buildChainMessages(input: ChainPromptInput): LLMMessage[] {
  const lang: HeChainLanguage = input.language === 'en' || input.language === 'pl' ? input.language : 'ru';
  const operatorsHint = input.operatorsHint?.trim()
    ? (lang === 'ru'
        ? '- Операторы персонализации из материалов: {{var}} обязателен в КАЖДОЙ теме; в каждом теле — ровно один {{var}}.'
        : lang === 'en'
          ? '- Insert the personalization operators from the materials where appropriate (no more than 1–2 distinct per email).'
          : '- Wstawiaj operatory personalizacji z materiałów tam, gdzie to uzasadnione (nie więcej niż 1–2 różne na mail).')
    : '';

  return [
    { role: 'system', content: SYSTEM[lang] },
    { role: 'user', content: buildChainMaterialsMessage(input) },
    { role: 'assistant', content: PRIMER_ACK[lang] },
    { role: 'user', content: TASK_PROMPTS[lang].replace('{{OPERATORS_HINT}}', operatorsHint) },
  ];
}

/* ─────────────── Проход 2: критик и рерайт цепочки ─────────────── */

/** Одна реальная проблема письма (letter_index — 1-based номер в цепочке). */
export interface HeCriticIssue {
  letter_index: number;
  problem: string;
  fix: string;
}

/** Вердикт критика по цепочке: одна строка + список реальных проблем. */
export interface HeChainCritique {
  verdict: string;
  issues: HeCriticIssue[];
}

const CRITIC_SYSTEM_RU = `Ты — скептичный занятой ЛПР целевой вертикали: получаешь десятки холодных писем в неделю и ненавидишь шаблонный спам. Тебе показывают цепочку писем ПЕРЕД отправкой. Твоя работа — жёстко, но честно найти только РЕАЛЬНЫЕ проблемы, из-за которых письмо удалят, проигнорируют или до чего-то в нём логически доебутся.

${CHAIN_REGULATIONS.ru}

ЧТО ФЛАГОВАТЬ (по каждому письму отдельно, только реальные проблемы):
- Непонятно, кто пишет или что предлагают: услуга не названа простыми словами, выгода для получателя не считывается.
- В письме нет конкретного повода — общее место про сегмент вместо факта про получателя/его мир («у всех в сегменте проблема X», «продажи упираются в потолок трафика»).
- Нет приветствия в начале письма или нет подписи отправителя в конце: каждое письмо обязано читаться как записка от живого человека (приветствие → мягкий повод → … → подпись), а не как безликий питч.
- Первая строка — утверждение в лоб про бизнес или рынок получателя («Ваш рынок X», «Вы продаёте Y», «Продажи упираются…») либо поучение его же рынком: первой строкой идёт приветствие, повод — после него, мягко и лично.
- Тире («—», «–») в теме или теле письма: маркер машинного текста, живой человек так не пишет — заменить запятой, двоеточием, точкой или скобками.
- Кейс вставлен без контекста и непонятно, причём он тут: голая наклейка «мы работали с X» без релевантности миру получателя, либо кейс из заведомо далёкой индустрии подан с именем вместо безымянной формулировки.
- Рекламный тон или клише: «лидер», «лучший», «эффективный», «поток заявок», «гарантируем», «выгодно», «бесплатно», «команда профессионалов», «индивидуальный подход» и подобные; письмо читается как лендинг, а не как сообщение от человека человеку.
- Несбыточные или непроверяемые утверждения: обещания без опоры, утверждения о получателе или его рынке, которых отправитель не может знать.
- Логические уязвимости — всё, до чего скептик может доебаться: повод не стыкуется с оффером, довод не следует из факта, CTA не связан с текстом письма, внутренние противоречия.
- Нарушения регламента выше: тело > 80 слов (письмо 1 > 70 — посчитай слова честно), нет {{var}} в теме, не ровно один {{var}} в теле, не ровно один CTA (больше одного или ни одного), цифры в теме или теле (кроме одной опорной цифры повода/кейса из материалов), timeline-обещания, breakup-фразы, просьба о звонке/встрече, fallback-подстановка не в именительном падеже.
- В письме НОЛЬ CTA: нет ни одного мягкого вопроса со следующим шагом. Каждое письмо цепочки обязано содержать ровно один CTA-вопрос — отсутствие CTA это не «спокойный тон», а нарушение.
- В письме 1 CTA не гибридный (нет реферальной ветки) или сформулирован коряво, не по-человечески: эталон — «Это актуально вам, или подскажете, кто у вас отвечает за <тема>?» (одна развилка, один вопросительный знак; в EN/PL — естественный эквивалент).
- Грамматика и чистота языка: согласование падежей и родов, нестандартное управление (пример: „держится работой" вместо „держится на работе"), оборванные или незаконченные фразы.
- Тест 5 секунд не пройден: после беглого чтения письма 1 нельзя мгновенно ответить — кто это, что предлагают, как это поможет мне.

КАЛИБРОВКА — НЕ ПРИДИРАЙСЯ:
- Живое короткое письмо по делу — не проблема, даже если написано не так, как написал бы ты. Флаги только то, что реально снизит шанс ответа или выставит отправителя спамером. Одна и та же проблема — один issue, не дублируй её разными словами.
- Если в материалах есть «ЭТАЛОН СТИЛЯ КЛИЕНТА» — оценивай тон относительно эталона: его имитация важнее дефолтных правил тона, но не отменяет регламент, запрет выдуманных имён и структуру оффера.
- Если в материалах есть «ПРОВЕННЫЕ ПАТТЕРНЫ» — не флаги темы и хуки, которые их адаптируют; флаги только дословное копирование паттерна без привязки к вертикали или цитирование процентов reply в письме.
- Формулируй конкретно: problem — в чём именно дело, с короткой цитатой фрагмента письма; fix — что конкретно изменить (действие, а не «сделать лучше»).

Вердикт — одна строка: «можно отправлять» (реальных проблем нет) или «нужна перепись» (есть хотя бы одна).`;

// EN-перевод системного блока критика — по смыслу; имена RU-блоков материалов
// («ЭТАЛОН СТИЛЯ КЛИЕНТА», «ПРОВЕННЫЕ ПАТТЕРНЫ») оставлены как в материалах.
const CRITIC_SYSTEM_EN = `You are a skeptical busy decision-maker in the target vertical: you get dozens of cold emails a week and hate templated spam. You are shown a sequence of emails BEFORE it is sent. Your job is to find, harshly but honestly, only the REAL problems that would get an email deleted, ignored or logically picked apart.

${CHAIN_REGULATIONS.en}

WHAT TO FLAG (per email, real problems only):
- It is unclear who is writing or what is offered: the service is not named in plain words, the benefit for the recipient does not read through.
- The email has no concrete reason for writing — a generic segment truism instead of a fact about the recipient/their world ("everyone in the segment has problem X", "sales are hitting a traffic ceiling").
- No greeting at the start of the email or no sender's signature at the end: every email must read as a note from a living person (greeting → soft reason → … → signature), not as a faceless pitch.
- The first line is an in-your-face assertion about the recipient's business or market ("Your market is X", "You sell Y", "Sales are hitting…") or a lecture about their own market: the first line is a greeting; the reason comes after it, softly and personally.
- Em/en dashes ("—", "–") in the subject or body: a marker of machine text, a living person does not write like that — replace with a comma, colon, period or parentheses.
- A case dropped in without context, unclear why it belongs here: a bare "we worked with X" sticker with no relevance to the recipient's world, or a case from an obviously distant industry given with a name instead of a nameless wording.
- Advertising tone or clichés: "leader", "best", "effective", "stream of leads", "we guarantee", "profitable", "free", "team of professionals", "individual approach" and the like; the email reads like a landing page, not a message from one person to another.
- Undeliverable or unverifiable claims: promises with no backing, statements about the recipient or their market that the sender cannot know.
- Logical vulnerabilities — anything a skeptic could pick at: the reason does not connect to the offer, the argument does not follow from the fact, the CTA is unrelated to the email text, internal contradictions.
- Violations of the regulations above: body > 80 words (email 1 > 70 — count the words honestly), no {{var}} in the subject, not exactly one {{var}} in the body, not exactly one CTA (more than one or none), digits in the subject or body (except one anchoring reason/case number from the materials), timeline promises, breakup phrases, asking for a call/meeting, a fallback substitution not in the nominative form.
- ZERO CTAs in the email: not a single soft question with a next step. Every email in the sequence must contain exactly one CTA question — a missing CTA is not a "calm tone", it is a violation.
- In email 1 the CTA is not hybrid (no referral branch) or is phrased clumsily, not humanly: the benchmark is "Is this relevant to you, or could you point me to who owns <topic> on your team?" (one fork, one question mark).
- Grammar and language cleanliness: flawless agreement, no broken or unfinished phrases.
- The 5-second test failed: after skimming email 1 you cannot instantly answer — who is this, what are they offering, how does it help me.

CALIBRATION — DO NOT NITPICK:
- A lively short email that gets to the point is not a problem, even if it is not written the way you would write it. Flag only what will actually lower the chance of a reply or expose the sender as a spammer. The same problem — one issue; do not duplicate it in different words.
- If the materials contain an "ЭТАЛОН СТИЛЯ КЛИЕНТА" (client style reference) block — judge tone relative to the reference: imitating it outranks the default tone rules, but never cancels the regulations, the ban on invented names or the offer structure.
- If the materials contain a "ПРОВЕННЫЕ ПАТТЕРНЫ" (proven patterns) block — do not flag subjects and hooks that adapt them; flag only verbatim copying of a pattern with no tie to the vertical, or quoting reply percentages inside the email.
- Be specific: problem — what exactly is wrong, with a short quote of the email fragment; fix — what exactly to change (an action, not "make it better").

Verdict — one line: "ready to send" (no real problems) or "needs a rewrite" (at least one).`;

/** Системный блок критика по языку цепочки (PL — RU-вариант, перевода нет). */
const CRITIC_SYSTEM: Record<HeChainLanguage, string> = {
  ru: CRITIC_SYSTEM_RU,
  en: CRITIC_SYSTEM_EN,
  pl: CRITIC_SYSTEM_RU,
};

/** Названия языка писем в промптах критика/рерайта — на языке самого промпта. */
const LANG_NAMES_RU: Record<HeChainLanguage, string> = {
  ru: 'русский',
  en: 'английский',
  pl: 'польский',
};

const LANG_NAMES_EN: Record<HeChainLanguage, string> = {
  ru: 'Russian',
  en: 'English',
  pl: 'Polish',
};

/**
 * Ярлыки писем в разборе критика/рерайта — на языке промпта (не парсятся,
 * только читаются моделью). PL идёт с RU-вариантом промптов — ярлыки русские.
 */
function renderLettersForReview(
  letters: Array<{ subject: string; body: string }>,
  lang: HeChainLanguage,
): string {
  if (lang === 'en') {
    return letters
      .map((l, i) => `--- Email ${i + 1} ---\nSubject: ${l.subject}\n\n${l.body}`)
      .join('\n\n');
  }
  return letters
    .map((l, i) => `--- Письмо ${i + 1} ---\nТема: ${l.subject}\n\n${l.body}`)
    .join('\n\n');
}

/**
 * Сообщения критик-прохода: скептичный ЛПР вертикали разбирает цепочку.
 * Ответ — JSON HeChainCritique (вызов через callLLMWithSchema): промпт
 * требует строгую форму без markdown и текста до/после.
 */
export function buildChainCriticMessages(input: {
  verticalName: string;
  verticalSummary?: string | null;
  letters: Array<{ subject: string; body: string }>;
  language: 'ru' | 'en' | 'pl';
  styleExample?: string | null;
  winnerPatterns?: Array<{ pattern: string; reply_pct: number }>;
}): LLMMessage[] {
  const lang: HeChainLanguage = input.language === 'en' || input.language === 'pl' ? input.language : 'ru';
  const style = renderStyleExampleBlock(input.styleExample);
  const winners = renderWinnerPatternsBlock(input.winnerPatterns);
  const summary = input.verticalSummary?.trim() ?? '';

  const user =
    lang === 'en'
      ? `VERTICAL: ${input.verticalName}
${summary ? `${summary}\n` : ''}
${style}${winners}EMAIL SEQUENCE (${input.letters.length} emails, language: ${LANG_NAMES_EN[lang]} — judge with a native speaker's eye):
${renderLettersForReview(input.letters, lang)}

Read the sequence as a busy decision-maker in this vertical who hates templated spam. Review each email against the rules above and return ONLY JSON of exactly this shape — no markdown fences, no text before or after:
{
  "verdict": "ready to send" | "needs a rewrite",
  "issues": [
    { "letter_index": <1-based email number>, "problem": "<what the problem is, with a short quote>", "fix": "<what exactly to change>" }
  ]
}
Response rules: verdict — exactly one of the two strings; "ready to send" ⇔ issues is empty, "needs a rewrite" ⇔ at least one issue; letter_index — only within 1..${input.letters.length}; problem and fix — in English.`
      : `ВЕРТИКАЛЬ: ${input.verticalName}
${summary ? `${summary}\n` : ''}
${style}${winners}ЦЕПОЧКА ПИСЕМ (${input.letters.length} шт., язык: ${LANG_NAMES_RU[lang]} — оценивай глазами носителя этого языка):
${renderLettersForReview(input.letters, lang)}

Прочитай цепочку как занятой ЛПР этой вертикали, который ненавидит шаблонный спам. Разбери каждое письмо по правилам выше и верни ТОЛЬКО JSON строго такой формы — без markdown-фенсов, без текста до или после:
{
  "verdict": "можно отправлять" | "нужна перепись",
  "issues": [
    { "letter_index": <1-based номер письма>, "problem": "<в чём проблема, с короткой цитатой>", "fix": "<что конкретно изменить>" }
  ]
}
Правила ответа: verdict — ровно одна из двух строк; «можно отправлять» ⇔ issues пустой, «нужна перепись» ⇔ хотя бы один issue; letter_index — только в диапазоне 1..${input.letters.length}; problem и fix — по-русски.`;

  return [
    { role: 'system', content: CRITIC_SYSTEM[lang] },
    { role: 'user', content: user },
  ];
}

/* ─────────────── Рерайт отмеченных писем ─────────────── */

const REWRITE_SYSTEM_RU = `Ты — senior email outreach редактор агентства Polza. Получаешь цепочку писем и разбор критика: переписываешь ТОЛЬКО отмеченные письма, остальные возвращаешь без изменений.

${CHAIN_REGULATIONS.ru}

ЖЁСТКИЕ ПРАВИЛА РЕРАЙТА:
- Переписывай ТОЛЬКО письма, чей letter_index есть в issues критики. Все остальные письма возвращай ДОСЛОВНО — символ в символ, включая тему: никаких «заодно поправил».
- Каждый issue отмеченного письма закрывай по его полю fix; после переписи письмо обязано проходить ВЕСЬ регламент. Самопроверка обязательна: посчитай слова в теле (≤ 80, письмо 1 ≤ 70), письмо после приветствия открывается конкретным поводом (не общим местом про сегмент), кейс — только через релевантность получателю, {{var}} в теме и ровно один в теле, ровно один CTA-вопрос (ноль CTA — нарушение; в письме 1 — гибридный вопрос с одним вопросительным знаком), в начале есть приветствие, в конце — подпись отправителя, в теме и теле нет ни одного тире («—», «–»).
- Конструкция цепочки неизменна: то же количество писем, тот же порядок и те же роли писем в лесенке (письмо 1 — оффер и гибридный CTA, чистый реферальный вопрос — только в последнем). Ничего не добавляй, не удаляй и не меняй местами.
- Новые факты запрещены: используй только то, что уже есть во входных письмах и материалах задачи. Новые имена клиентов, кейсы, цифры и обещания выдумывать нельзя — если критик требует конкретики, которой нет во входе, переписывай безымянно.
- Конкретный кейс/название клиента — максимум в одном письме цепочки; при переписи не размазывай его на несколько писем.
- Углы писем не смешивай: переписанное письмо держит свой исходный угол, не тащи мысль соседнего письма.
- Формат операторов {{var}} не ломай: имена операторов сохраняй как есть, fallback-формулировки — в именительном падеже.
- Тон — человеческий диалог, не реклама; стоп-фразы и клише из регламента запрещены. Первая строка — приветствие, а не утверждение в лоб про бизнес или рынок получателя; письмо заканчивается подписью отправителя; тире («—», «–») в темах и телах запрещены. Перечитай каждое переписанное письмо вслух: согласование падежей и родов должно быть идеальным.
- Если в материалах есть «ЭТАЛОН СТИЛЯ КЛИЕНТА» — переписанные письма подражают его манере, структуре фраз и тону (это важнее дефолтных правил тона), но регламент, запрет выдуманных имён и структура оффера неизменны.
- Если в материалах есть «ПРОВЕННЫЕ ПАТТЕРНЫ» — темы и хуки переписанных писем вдохновляй ими: адаптируй, не копируй дословно, проценты reply не цитируй.
- Если в материалах есть блок «ПОДПИСЬ ОТПРАВИТЕЛЯ» — каждое переписанное письмо заканчивай этой подписью дословно; нетронутые письма возвращай как есть.`;

// EN-перевод системного блока рерайта — по смыслу; имена RU-блоков материалов
// («ЭТАЛОН СТИЛЯ КЛИЕНТА», «ПРОВЕННЫЕ ПАТТЕРНЫ», «ПОДПИСЬ ОТПРАВИТЕЛЯ») — как в материалах.
const REWRITE_SYSTEM_EN = `You are a senior email outreach editor at the Polza agency. You receive a sequence of emails and the critic's review: you rewrite ONLY the flagged emails and return the rest unchanged.

${CHAIN_REGULATIONS.en}

HARD REWRITE RULES:
- Rewrite ONLY the emails whose letter_index appears in the critique's issues. Return all other emails VERBATIM — character for character, including the subject: no "fixed it while I was at it".
- Close every issue of a flagged email per its fix field; after the rewrite the email must pass the ENTIRE regulations. Self-check is mandatory: count the words in the body (≤ 80, email 1 ≤ 70), the email after the greeting opens with a concrete reason (not a generic segment truism), the case — only through relevance to the recipient, {{var}} in the subject and exactly one in the body, exactly one CTA question (zero CTAs — a violation; in email 1 — a hybrid question with a single question mark), a greeting at the start, the sender's signature at the end, not a single dash ("—", "–") in the subject or body.
- The sequence construction is unchanged: same number of emails, same order and the same roles in the ladder (email 1 — the offer and the hybrid CTA, the pure referral question — only in the last one). Do not add, remove or reorder anything.
- New facts are banned: use only what is already in the input emails and the task materials. New client names, cases, numbers and promises may not be invented — if the critic demands specifics that are not in the input, rewrite nameless.
- A specific case/client name — in at most one email of the sequence; when rewriting, do not smear it across several emails.
- Do not mix the emails' angles: a rewritten email keeps its original angle, do not drag in a neighboring email's idea.
- Do not break the {{var}} operator format: keep operator names as they are, fallback wordings — in the nominative form.
- Tone — human dialogue, not advertising; the regulations' stop phrases and clichés are banned. The first line is a greeting, not an in-your-face assertion about the recipient's business or market; the email closes with the sender's signature; dashes ("—", "–") in subjects and bodies are banned. Read every rewritten email aloud: grammar and agreement must be flawless.
- If the materials contain an "ЭТАЛОН СТИЛЯ КЛИЕНТА" block — the rewritten emails imitate its manner, phrasing structure and tone (this outranks the default tone rules), but the regulations, the ban on invented names and the offer structure are unchanged.
- If the materials contain a "ПРОВЕННЫЕ ПАТТЕРНЫ" block — inspire the rewritten emails' subjects and hooks with them: adapt, do not copy verbatim, never quote reply percentages.
- If the materials contain a "ПОДПИСЬ ОТПРАВИТЕЛЯ" block — close every rewritten email with that signature verbatim; return untouched emails as they are.`;

/** Системный блок рерайта по языку цепочки (PL — RU-вариант, перевода нет). */
const REWRITE_SYSTEM: Record<HeChainLanguage, string> = {
  ru: REWRITE_SYSTEM_RU,
  en: REWRITE_SYSTEM_EN,
  pl: REWRITE_SYSTEM_RU,
};

const REWRITE_ACK: Record<HeChainLanguage, string> = {
  ru: 'Цепочка и критика в контексте. Переписываю только отмеченные письма, остальные возвращаю дословно.',
  en: 'The sequence and the critique are in context. Rewriting only the flagged emails, returning the rest verbatim.',
  pl: 'Sekwencja i krytyka są w kontekście. Przepisuję tylko oflagowane maile, resztę zwracam bez zmian.',
};

const REWRITE_TASK: Record<HeChainLanguage, string> = {
  ru: `Перепиши цепочку по критике выше: закрой каждый issue, не отмеченные письма верни дословно. Верни цепочку ЦЕЛИКОМ — все письма по порядку, и переписанные, и нетронутые. Сегментные варианты и A/B-варианты (---LETTER N B---) писем не трогаем — они восстанавливаются отдельно, их не выводи.

ФОРМАТ ВЫВОДА (ОБЯЗАТЕЛЕН — иначе ответ не пройдёт парсинг):
---LETTER 1---
Тема: <тема письма 1>

<тело письма 1>

---LETTER 2---
Тема: <тема письма 2>

<тело письма 2>

...и так далее до последнего письма. Никаких пояснений до/после блоков. Маркеры «---LETTER N---» и слово «Тема:» не меняй. Пиши на русском.`,
  en: `Rewrite the sequence per the critique above: close every issue, return unflagged emails verbatim. Return the WHOLE sequence — all emails in order, rewritten and untouched alike. Leave segment variants and A/B variants (---LETTER N B---) alone — they are restored separately; do not output them.

OUTPUT FORMAT (MANDATORY — otherwise the response will fail parsing):
---LETTER 1---
Subject: <subject of email 1>

<body of email 1>

---LETTER 2---
Subject: <subject of email 2>

<body of email 2>

...and so on through the last email. No explanations before/after the blocks. Keep the "---LETTER N---" markers and the word "Subject:" exactly as shown. Write in English.`,
  pl: `Przepisz sekwencję według krytyki powyżej: zamknij każdy issue, nieoflagowane maile zwróć dosłownie. Zwróć CAŁĄ sekwencję — wszystkie maile po kolei, i przepisane, i nietknięte. Wariantów segmentowych i wariantów A/B (---LETTER N B---) nie ruszamy — są odtwarzane osobno, nie wypisuj ich.

FORMAT ODPOWIEDZI (OBOWIĄZKOWY — inaczej odpowiedź nie przejdzie parsowania):
---LETTER 1---
Temat: <temat maila 1>

<treść maila 1>

---LETTER 2---
Temat: <temat maila 2>

<treść maila 2>

...i tak dalej do ostatniego maila. Żadnych wyjaśnień przed/po blokach. Znaczników "---LETTER N---" i słowa "Temat:" nie zmieniaj. Pisz po polsku.`,
};

/**
 * Сообщения рерайт-прохода: переписываются только письма из issues критики,
 * остальные возвращаются дословно. Вывод — теми же маркерами ---LETTER N---,
 * что и генерация: ответ потребляет letterParser.
 */
export function buildChainRewriteMessages(input: {
  verticalName: string;
  letters: Array<{ subject: string; body: string }>;
  critique: HeChainCritique;
  language: 'ru' | 'en' | 'pl';
  styleExample?: string | null;
  winnerPatterns?: Array<{ pattern: string; reply_pct: number }>;
  signatureOverride?: string | null;
}): LLMMessage[] {
  const lang: HeChainLanguage = input.language === 'en' || input.language === 'pl' ? input.language : 'ru';
  const style = renderStyleExampleBlock(input.styleExample);
  const winners = renderWinnerPatternsBlock(input.winnerPatterns);
  const signature = renderSignatureBlock(input.signatureOverride);

  const materials =
    lang === 'en'
      ? `VERTICAL: ${input.verticalName}

${style}${winners}${signature}SOURCE SEQUENCE (${input.letters.length} emails, language: ${LANG_NAMES_EN[lang]}):
${renderLettersForReview(input.letters, lang)}

SEQUENCE CRITIQUE (verdict and problems; ONLY the emails in issues are rewritten):
${JSON.stringify(input.critique, null, 2)}`
      : `ВЕРТИКАЛЬ: ${input.verticalName}

${style}${winners}${signature}ИСХОДНАЯ ЦЕПОЧКА (${input.letters.length} писем, язык: ${LANG_NAMES_RU[lang]}):
${renderLettersForReview(input.letters, lang)}

КРИТИКА ЦЕПОЧКИ (вердикт и проблемы; переписываются ТОЛЬКО письма из issues):
${JSON.stringify(input.critique, null, 2)}`;

  return [
    { role: 'system', content: REWRITE_SYSTEM[lang] },
    { role: 'user', content: materials },
    { role: 'assistant', content: REWRITE_ACK[lang] },
    { role: 'user', content: REWRITE_TASK[lang] },
  ];
}
