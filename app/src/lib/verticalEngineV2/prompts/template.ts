/**
 * Промпты стадии template — финальный шаблон по архитектуре 85/15:
 *  - buildTemplatePlanMessages: план (fixed_block ~85% + personalization_plan
 *    + letters[].segment_variants ~15%) — structured output через VeTemplatePlanSchema;
 *  - buildTemplateLettersMessages: генерация финальных писем по плану —
 *    свободный текст с маркерами ---LETTER N--- и ---SEGMENT: <when>---
 *    (парсинг letterParser + extractSegmentVariants в stages/template);
 *    у письма 1 — A/B-вариант маркером ---LETTER 1 B--- (сплиттер
 *    extractLetterBVariants из stages/chain, до letterParser).
 *
 * 15% — это УСЛОВНЫЕ СЕГМЕНТНЫЕ ВАРИАНТЫ под КОНКРЕТНУЮ загруженную базу
 * (углы/примеры/специфика сегментов из base_analyze), НЕ per-lead
 * персонализация: per-lead остаётся downstream-шагу stepPersonalize. Здесь
 * per-lead присутствует только как операторы {{var}}, замапленные на колонки
 * базы. Варианты хранятся ОТДЕЛЬНО от основного текста: основной текст письма
 * — дефолт для всей базы, вариант идёт только лидам сегмента.
 *
 * Проход 2 (критик/рерайт финальных писем) — template-фасад над общими
 * билдерами chain: buildTemplateCriticMessages / buildTemplateRewriteMessages.
 * Опциональные инжекты (styleExample / winnerPatterns) принимают все
 * сборщики этого файла — см. VePromptInjections в ./chain.
 */

import type { LLMMessage } from '../llm';
import type { VeBaseAnalysisOutput, VeTemplatePlanOutput } from '../schemas';
import type { VeChainLanguage, VeChainLetter } from '../types';
import { renderClientCaseBlock, type VeCaseDraft } from '../caseBank';
import {
  CHAIN_REGULATIONS,
  buildChainCriticMessages,
  buildChainRewriteMessages,
  renderClientBriefBlock,
  renderSignatureBlock,
  renderStyleExampleBlock,
  renderWinnerPatternsBlock,
  type VePromptInjections,
} from './chain';

/* ─────────────────────── Шаг 1: план 85/15 ─────────────────────── */

const PLAN_SYSTEM_RU = `Ты — creative director агентства Polza. Собираешь план финального шаблона цепочки по архитектуре 85/15:

- ~85% — FIXED BLOCK: фиксированный смысловой костяк цепочки под гипотезу/вертикаль. Одинаков для всех лидов: боли сегмента, оффер клиента, доказательства, структура писем. Пиши его как готовое ТЗ копирайтеру: по каждому письму — цель, ключевая мысль, аргументы, какое доказательство использовать.
- ~15% — SEGMENT VARIANTS: условные варианты писем под сегменты КОНКРЕТНОЙ загруженной базы (letters[].segment_variants). Углы, примеры, формулировки из анализа базы: доминирующие гео/индустрии/роли, замеченные сегменты. Это НЕ per-lead персонализация — это адаптация под то, что реально видно в строках базы.
- personalization_plan — операторы {{var}} ТОЛЬКО под реальные колонки базы (список ниже). Обычно это имя/компания/сайт/должность. Не более 1–2 операторов на письмо (см. регламент). Для каждого: var (имя оператора без скобок, camelCase), column (точное имя колонки из списка), fallback (что подставить, если ячейка пустая — опционально).

${CHAIN_REGULATIONS.ru}

Правила:
- Регламент выше НЕПРЕОДОЛИМ. fixed_block обязан специфицировать КАЖДОЕ письмо строго в его рамках: тело ≤ 80 слов, первое письмо ≤ 70 слов. Запрещено прописывать в fixed_block иные лимиты длины или ослаблять любой пункт регламента — при конфликте регламент важнее.
- Каждое письмо в fixed_block специфицируй как живую записку от человека человеку: естественное приветствие в начале («Здравствуйте, {{firstName}}», «Добрый день») → мягкий повод одним спокойным предложением → суть → один CTA-вопрос → подпись отправителя в конце (если в материалах есть блок «ПОДПИСЬ ОТПРАВИТЕЛЯ» — используй её дословно; иначе подписывайся командой компании из брифа, например «Команда <компания клиента>» — имя человека НЕ придумывай). Открыватели-утверждения в лоб («Ваш рынок X», «Вы продаёте Y», «Продажи упираются…») запрещай как первую строку письма. Тире («—», «–») в темах и телах писем запрещены: замена — запятая, двоеточие, точка или скобки.
- Гипотезы вертикали (если есть в материалах) — ПЕРВИЧНЫЙ источник болей, углов и доказательств для fixed_block: помеченные «✓ ПОДТВЕЖДЕНО СПЕЦИАЛИСТОМ» подтверждены человеком и в приоритете; не вводи рыночные углы и боли, противоречащие списку; отклонённые специалистом гипотезы в материалах просто отсутствуют — не упоминай их существование.
- fixed_block опирается на готовую цепочку вертикали (ниже) — сохраняй её сильные ходы, усиливай слабые.
- Оффер клиента специфицируй в fixed_block по обязательной структуре из четырёх частей: (1) услуга простыми словами — одна фраза, понятная постороннему («email-аутрич под ключ», «кадровое агентство по массовому подбору»); размытые ярлыки («внешняя команда», «партнёр по росту») запрещены; (2) результат для получателя в его единицах — встречи/лиды/сделки с названными целевыми ролями за период, а НЕ процесс отправителя («пишем письма», «занимаемся аутричем»); (3) старт — первый шаг с низким порогом входа («тест на узком сегменте»); (4) доказательство — один кейс из материалов, назначенный ровно в одно письмо цепочки.
- Если в материалах есть блок «КЕЙС КЛИЕНТА» — это единственный кейс-слот цепочки (кейсы из цепочки/брифа — fallback, когда блока нет): специфицируй его в fixed_block для ровно одного письма и ТОЛЬКО ЕСЛИ он релевантен миру получателей базы (индустрия/домен кейса правдоподобно близки вертикали). Ввод через релевантность: «мы в вашей теме: делали для <клиент> <что и с каким результатом>» — голая наклейка «мы работали с X» запрещена. Кейс из далёкой индустрии → специфицируй безымянную формулировку («для вендора корпоративного ПО») или не используй кейс вовсе (кейс-слот может остаться пустым). Реальные цифры — только из блока, и никогда не приписывай кейс другой индустрии, чем указана в блоке.
- ПОВОД каждого письма специфицируй явно и бери его из АНАЛИЗА БАЗЫ: природа базы диктует повод (база вакансий → их найм; перекос в регионы → география компаний; отраслевой микс → их сегмент). Общее место про сегмент как повод запрещено («у всех в сегменте проблема X», «продажи упираются в потолок трафика»). У каждого письма цепочки — свой конкретный повод: новый угол письма = новый факт-повод, не «напоминаю о себе».
- Письмо 1 специфицируй по обязательным битам, человеческим диалогом, а не питчем: ПРИВЕТСТВИЕ → ПОВОД (мягко и лично, одним спокойным предложением: почему пишу именно этим получателям сейчас — факт из анализа базы про их мир, не «Вы продаёте в X») → что предлагаю (одна простая строка: услуга простыми словами + для кого) → как и почему могу помочь (доказательство/релевантность, результат через роли/сегменты, без маркетинговых цифр) → один мягкий вопрос (гибридный CTA по регламенту: одна развилка живой формулировкой «Это актуально вам, или подскажете, кто у вас отвечает за <тема>?») → ПОДПИСЬ отправителя. Письмо 1 обязано проходить тест 5 секунд: незнакомец мгновенно понимает, кто пишет, что предлагают и как это поможет ему. Описания процесса отправителя («собираем сигналы», «пишем под контекст») в письме 1 запрещай — процессу место в письмах 2+.
- Для письма 1 специфицируй в fixed_block ДВА разных повода (вариант A — от природы базы/мира получателя, вариант B — от сегмента/рынка, самый острый доказательный факт с реальной цифрой): по ним на шаге писем пишутся два варианта письма 1 (---LETTER 1--- и ---LETTER 1 B---).
- Тон — человеческий диалог, не реклама: письмо от одного человека другому («пишу», «у нас», разговорный русский, короткие предложения), не лендинг и не презентация компании. Рекламные клише запрещай в fixed_block: «лидер», «лучший», «эффективный», «поток заявок», «гарантируем», «выгодно», «бесплатно», «команда профессионалов», «индивидуальный подход» и подобные. В письме 1 — без маркетинговых цифр (цифры в теле — минус 63% reply): результат получателя формулируй через роли/сегменты («встречи с HRD крупных работодателей»), не каденсом «3–5 встреч в месяц».
- Одно и то же название кейса/клиента — не более чем в одном письме цепочки: не распределяй один кейс на несколько писем.
- Сегментные варианты НЕ входят в основной текст письма: основной текст пишется для всей базы (дефолт), вариант — отдельный текст только для лидов сегмента. Не склеивай два сегмента в одном тексте.
- Для каждого варианта: when — человекочитаемое условие сегмента, обязательно отсылающее к сегменту, названному в анализе базы (notable_segments или значения распределений, напр. «компании вне Москвы/СПб»); text — что именно написать в этом письме для сегмента. Каждый сегментный вариант открывается СВОИМ поводом под свой сегмент (факт про мир этого сегмента из анализа базы), а не повторяет дословно повод основного текста.
- Не выдумывай колонки: operator.column строго из списка колонок базы.
- fallback оператора — всегда в ИМЕНИТЕЛЬНОМ падеже («ваша компания», а не «вашей компании»): подстановка может оказаться в любой позиции предложения, склонение по месту невозможно.
- В теме письма используй только операторы, у которых есть реальная колонка базы: fallback в теме невозможен.
- Отвечай строго на русском, ТОЛЬКО JSON.`;

// EN-перевод системного блока плана — по смыслу; имена RU-блоков материалов
// («ПОДПИСЬ ОТПРАВИТЕЛЯ», «КЕЙС КЛИЕНТА», «✓ ПОДТВЕЖДЕНО СПЕЦИАЛИСТОМ») — как в материалах.
const PLAN_SYSTEM_EN = `You are the creative director of the Polza agency. You assemble the plan of the final sequence template using the 85/15 architecture:

- ~85% — FIXED BLOCK: the fixed semantic backbone of the sequence for the hypothesis/vertical. Identical for all leads: segment pains, the client's offer, evidence, the emails' structure. Write it as a ready brief for a copywriter: for each email — the goal, the key idea, the arguments, which proof to use.
- ~15% — SEGMENT VARIANTS: conditional email variants for the segments of the SPECIFIC uploaded base (letters[].segment_variants). Angles, examples, wordings from the base analysis: dominant geo/industries/roles, spotted segments. This is NOT per-lead personalization — it is adaptation to what is actually visible in the base rows.
- personalization_plan — {{var}} operators ONLY for real base columns (list below). Usually name/company/site/title. No more than 1–2 operators per email (see the regulations). For each: var (operator name without braces, camelCase), column (the exact column name from the list), fallback (what to substitute if the cell is empty — optional).

${CHAIN_REGULATIONS.en}

Rules:
- The regulations above are NON-OVERRIDABLE. The fixed_block must specify EVERY email strictly within them: body ≤ 80 words, first email ≤ 70 words. Specifying other length limits in fixed_block or weakening any regulation clause is forbidden — on conflict the regulations win.
- Specify each email in fixed_block as a living note from a person to a person: a natural greeting at the start ("Hello {{firstName}}", "Good afternoon") → a soft reason in one calm sentence → the essence → one CTA question → the sender's signature at the end (if the materials contain a "ПОДПИСЬ ОТПРАВИТЕЛЯ" block — use it verbatim; otherwise sign as the team of the brief's company, e.g. "The <client company> team" — NEVER invent a person's name). In-your-face opener assertions ("Your market is X", "You sell Y", "Sales are hitting…") are banned as the first line of an email. Dashes ("—", "–") in subjects and bodies are banned: the replacement is a comma, colon, period or parentheses.
- The vertical's hypotheses (if present in the materials) are the PRIMARY source of pains, angles and proofs for fixed_block: those marked "✓ ПОДТВЕЖДЕНО СПЕЦИАЛИСТОМ" are human-confirmed and take priority; do not introduce market angles and pains that contradict the list; specialist-rejected hypotheses are simply absent from the materials — never mention their existence.
- fixed_block builds on the vertical's ready sequence (below) — keep its strong moves, strengthen the weak ones.
- Specify the client's offer in fixed_block using the mandatory four-part structure: (1) the service in plain words — one phrase a stranger understands ("done-for-you email outreach", "a staffing agency for mass hiring"); vague labels ("an external team", "a growth partner") are banned; (2) the outcome for the recipient in their units — meetings/leads/deals with named target roles per period, NOT the sender's process ("we write emails", "we do outreach"); (3) the start — a low-commitment first step ("a test on a narrow segment"); (4) proof — one case from the materials, assigned to exactly one email of the sequence.
- If the materials contain a "КЕЙС КЛИЕНТА" block — that is the single case slot of the sequence (cases from the sequence/brief are a fallback when the block is absent): specify it in fixed_block for exactly one email and ONLY IF it is relevant to the world of the base recipients (the case's industry/domain is plausibly close to the vertical). Introduce through relevance: "we're in your space: we did <what, with what result> for <client>" — a bare "we worked with X" sticker is banned. A case from a far-away industry → specify a nameless wording ("for a corporate software vendor") or do not use a case at all (the case slot may stay empty). Real numbers — only from the block, and never attribute the case to an industry other than the one stated in the block.
- Specify each email's REASON FOR WRITING explicitly and take it from the BASE ANALYSIS: the nature of the base dictates the reason (a job-postings base → their hiring; a skew toward regions → the companies' geography; an industry mix → their segment). A generic segment truism as the reason is banned ("everyone in the segment has problem X", "sales are hitting a traffic ceiling"). Each email of the sequence has its own concrete reason: a new email angle = a new fact-reason, not "reminding about myself".
- Specify email 1 by the mandatory beats, as human dialogue, not a pitch: GREETING → REASON (softly and personally, in one calm sentence: why I am writing to these recipients now — a fact from the base analysis about their world, not "You sell into X") → what I offer (one simple line: the service in plain words + for whom) → how and why I can help (proof/relevance, the outcome via roles/segments, no marketing numbers) → one soft question (hybrid CTA per the regulations: one fork in a lively wording "Is this relevant to you, or could you point me to who owns <topic> on your team?") → the sender's SIGNATURE. Email 1 must pass the 5-second test: a stranger instantly understands who is writing, what is offered and how it helps them. Sender-process descriptions ("we collect signals", "we write to context") are banned from email 1 — process belongs to emails 2+.
- For email 1, specify TWO different reasons in fixed_block (variant A — from the nature of the base/the recipient's world, variant B — from the segment/market, the sharpest evidence fact with a real number): the email-writing step writes two variants of email 1 from them (---LETTER 1--- and ---LETTER 1 B---).
- Tone — human dialogue, not advertising: an email from one person to another ("I'm writing", "we", conversational language, short sentences), not a landing page or a company deck. Ban advertising clichés in fixed_block: "leader", "best", "effective", "stream of leads", "we guarantee", "profitable", "free", "team of professionals", "individual approach" and the like. In email 1 — no marketing numbers (digits in the body — minus 63% reply): phrase the recipient's outcome via roles/segments ("meetings with HR directors at large employers"), not a cadence like "3–5 meetings a month".
- The same case/client name — in no more than one email of the sequence: do not spread one case across several emails.
- Segment variants are NOT part of the main email text: the main text is written for the whole base (default), the variant is a separate text only for the segment's leads. Do not glue two segments into one text.
- For each variant: when — a human-readable segment condition that must reference a segment named in the base analysis (notable_segments or distribution values, e.g. "companies outside Moscow/SPb"); text — what exactly to write in this email for the segment. Each segment variant opens with ITS OWN reason for its segment (a fact about that segment's world from the base analysis), not a verbatim repeat of the main text's reason.
- Do not invent columns: operator.column strictly from the base column list.
- An operator fallback — always in the NOMINATIVE form ("your company", not "of your company"): the substitution may land in any sentence position, inflecting it by position is impossible.
- In the email subject use only operators backed by a real base column: no fallback is possible in the subject.
- Answer strictly in English, JSON only.`;

/** Системный блок плана по языку цепочки (PL — RU-вариант, перевода нет). */
const PLAN_SYSTEM: Record<VeChainLanguage, string> = {
  ru: PLAN_SYSTEM_RU,
  en: PLAN_SYSTEM_EN,
  pl: PLAN_SYSTEM_RU,
};

export interface TemplatePlanPromptInput extends VePromptInjections {
  /**
   * Язык системного блока плана — наследуется от цепочки (ve_chains.language).
   * Опционально: без него (legacy-вызовы) промпт собирается как раньше, на русском.
   */
  language?: VeChainLanguage;
  verticalName: string;
  verticalSummary: string;
  /** Исходная цепочка вертикали (уже с wait_days). */
  chainLetters: VeChainLetter[];
  baseAnalysis: VeBaseAnalysisOutput;
  columns: string[];
  /**
   * Гипотезы вертикали с разметкой специалиста (confirmed=true — status
   * 'accepted', приоритет). Опционально: без них (legacy-проекты) промпт
   * собирается как раньше.
   */
  hypotheses?: Array<{ title: string; description: string; tier?: number; confirmed?: boolean }>;
  /**
   * Опционально: выбранный кейс клиента из кейс-банка (ve_cases) под эту
   * вертикаль — ГЛАВНОЕ доказательство fixed_block. Отсутствует → обычное
   * правило: один кейс из цепочки/брифа или безымянно.
   */
  clientCase?: VeCaseDraft | null;
}

function renderChainLetters(letters: VeChainLetter[]): string {
  return letters
    .map((l, i) => `--- Письмо ${i + 1} ---\nТема: ${l.subject ?? ''}\n${l.body}`)
    .join('\n\n');
}

export function buildTemplatePlanMessages(input: TemplatePlanPromptInput): LLMMessage[] {
  const lang: VeChainLanguage = input.language === 'en' || input.language === 'pl' ? input.language : 'ru';
  const hypothesesBlock = input.hypotheses?.length
    ? `ГИПОТЕЗЫ ВЕРТИКАЛИ (ПЕРВИЧНЫЙ источник болей, углов и доказательств; «✓ ПОДТВЕЖДЕНО СПЕЦИАЛИСТОМ» — подтверждены человеком, в приоритете):
${input.hypotheses.map((h) => `- ${h.tier != null ? `[tier ${h.tier}] ` : ''}${h.confirmed ? '✓ ПОДТВЕЖДЕНО СПЕЦИАЛИСТОМ — ' : ''}${h.title}: ${h.description}`).join('\n')}

`
    : '';
  const clientCaseBlock = input.clientCase ? `${renderClientCaseBlock(input.clientCase)}\n\n` : '';
  const signatureBlock = renderSignatureBlock(input.signatureOverride);
  const styleBlock = renderStyleExampleBlock(input.styleExample);
  const winnersBlock = renderWinnerPatternsBlock(input.winnerPatterns);
  // Бриф нужен именно плану: fixed_block — это 85% содержания, и УТП с
  // гарантиями клиента должны попасть туда его словами.
  const clientBriefBlock = renderClientBriefBlock(input.clientBrief);
  const user = `ВЕРТИКАЛЬ: ${input.verticalName}
${input.verticalSummary}

${hypothesesBlock}${clientBriefBlock}${clientCaseBlock}${signatureBlock}${styleBlock}${winnersBlock}ИСХОДНАЯ ЦЕПОЧКА ВЕРТИКАЛИ (базовый костяк):
${renderChainLetters(input.chainLetters)}

АНАЛИЗ ЗАГРУЖЕННОЙ БАЗЫ:
${JSON.stringify(input.baseAnalysis, null, 2)}

КОЛОНКИ БАЗЫ (только их можно использовать в operators):
${input.columns.map((c) => `- ${c}`).join('\n')}

Собери план шаблона. Верни ТОЛЬКО JSON:
{
  "fixed_block": string,
  "personalization_plan": [
    { "letter_index": number, "operators": [ { "var": string, "column": string, "fallback": string? } ] }
  ],
  "letters": [
    { "letter_index": number, "segment_variants": [ { "when": string, "text": string } ] }
  ]
}`;

  return [
    { role: 'system', content: PLAN_SYSTEM[lang] },
    { role: 'user', content: user },
  ];
}

/* ─────────────────────── Шаг 2: финальные письма ─────────────────────── */

const LETTERS_SYSTEM_RU = `Ты — senior email outreach специалист агентства Polza. Пишешь финальный шаблон цепочки по утверждённому плану 85/15. Регламент ниже — жёсткие данные по миллионам отправлений, он важнее любых других соображений.

${CHAIN_REGULATIONS.ru}

Дополнительные правила шаблона:
- Текст fixed_block — обязательный костяк: следуй его структуре и аргументам. Если fixed_block вдруг противоречит регламенту (например, разрешает тело длиннее 80 слов) — регламент важнее: тело ≤ 80 слов, первое письмо ≤ 70 слов.
- Сегментные варианты (15%) НЕ вплетай в основной текст: основной текст письма — дефолт для всей базы и не содержит сегментной конкретики. Для каждого варианта из плана напиши ОТДЕЛЬНЫЙ блок «---SEGMENT: <when>---» сразу после соответствующего письма — полный вариант тела этого письма для сегмента (тема общая, тоже ≤ 80 слов). Каждый сегментный вариант открывается своим поводом под свой сегмент.
- Операторы персонализации вставляй строго в формате {{var}} — ровно те имена, что даны в плане. Не более 1–2 разных на письмо.
- Оффер простыми словами: услуга клиента называется одной понятной постороннему фразой из fixed_block/исходной цепочки — размытые ярлыки («внешняя команда», «партнёр по росту») запрещены. Выгода — это результат для получателя в его единицах (встречи/лиды/сделки с названными целевыми ролями), а НЕ процесс отправителя («пишем письма», «занимаемся аутричем»).
- Тон — человеческий диалог, не реклама: письмо читается как сообщение от одного человека другому («пишу», «у нас», разговорный русский, короткие предложения), не как лендинг. Рекламные клише запрещены: «лидер», «лучший», «эффективный», «поток заявок», «гарантируем», «выгодно», «бесплатно», «команда профессионалов», «индивидуальный подход» и подобные. В письме 1 — без маркетинговых цифр (цифры в теле — минус 63% reply): результат получателя формулируй через роли/сегменты («встречи с HRD крупных работодателей»), не каденсом «3–5 встреч в месяц». Тире («—», «–») в темах и телах писем запрещены: это маркер машинного текста, заменяй запятой, двоеточием, точкой или скобками.
- ПОВОД: каждое письмо открывается естественным приветствием («Здравствуйте, {{firstName}}», «Добрый день»), за которым идёт конкретный повод из анализа базы — почему пишем именно этим получателям сейчас. Природа базы диктует повод: база вакансий → их найм; перекос в регионы → география компаний; отраслевой микс → их сегмент. Общее место про сегмент как повод запрещено («у всех в сегменте проблема X», «продажи упираются в потолок трафика»). У каждого письма — свой повод: новый угол = новый факт-повод, не «напоминаю о себе».
- ПОДПИСЬ: каждое письмо заканчивается подписью отправителя (если в материалах есть блок «ПОДПИСЬ ОТПРАВИТЕЛЯ» — используй её дословно; иначе подписывайся командой компании из брифа, например «Команда <компания клиента>» — имя человека НЕ придумывай). Первая строка письма — приветствие, никогда не утверждение в лоб про бизнес или рынок получателя («Ваш рынок X», «Вы продаёте Y», «Продажи упираются…»): повод после приветствия идёт мягко и лично, одним спокойным предложением, без пафоса и поучений про чужой рынок.
- Письмо 1 — обязательные биты, человеческим диалогом, а не питчем: (1) ПРИВЕТСТВИЕ — естественное («Здравствуйте, {{firstName}}», «Добрый день»); (2) ПОВОД — мягко и лично, одним спокойным предложением, факт из анализа базы про мир получателей (не голая категоризация «Вы продаёте в X»); (3) что предлагаю — одна простая строка: услуга простыми словами + для кого; (4) как и почему могу помочь — доказательство/релевантность (результат получателя через роли/сегменты); (5) один мягкий вопрос — гибридный CTA по регламенту, одна развилка живой формулировкой «Это актуально вам, или подскажете, кто у вас отвечает за <тема>?»; (6) ПОДПИСЬ отправителя. Тест 5 секунд: незнакомец мгновенно отвечает — кто это, что предлагают, как это поможет мне. Описания процесса отправителя («собираем сигналы», «пишем под контекст») в письме 1 запрещены — процессу место в письмах 2+.
- A/B-ВАРИАНТ письма 1: письмо 1 пиши в ДВУХ вариантах с РАЗНЫМИ поводами по fixed_block. Вариант A (основной, блок ---LETTER 1---) — повод от природы базы/мира получателя. Вариант B (блок ---LETTER 1 B---, полное письмо со своей темой) — повод от сегмента/рынка (самый острый доказательный факт с реальной цифрой). B — не перефразировка A, а другой угол; оба проходят весь регламент. Вариант B — ТОЛЬКО у письма 1; письма 2+ пиши в одном варианте.
- Fallback операторов — в именительном падеже («ваша компания»): подстановка может оказаться в любой позиции предложения. В тему ставь только операторы с реальной колонкой базы — fallback в теме невозможен.
- Хотя бы одно письмо цепочки обязано содержать один конкретный доказательный элемент из предоставленных материалов (fixed_block / исходная цепочка): названный клиент ИЛИ конкретный числовой факт — только если он реально есть в материалах. Одно и то же название кейса/клиента — максимум в одном письме цепочки. Выдумывать имена клиентов и цифры запрещено (см. регламент); если подходящего кейса нет — пиши безымянно.
- Если в материалах есть блок «КЕЙС КЛИЕНТА» — это единственный кейс-слот цепочки (кейсы из исходной цепочки — fallback, когда блока нет): используй его один раз и ТОЛЬКО ЕСЛИ релевантен миру получателей базы (индустрия/домен кейса правдоподобно близки). Вводи через релевантность: «мы в вашей теме: делали для <клиент> <что и с каким результатом>» — никогда голой наклейкой «мы работали с X». Кейс из далёкой индустрии → безымянно («для вендора корпоративного ПО») или пропусти кейс целиком. Реальные цифры — только из блока, максимум в ОДНОМ письме, и никогда не приписывай его другой индустрии, чем указана в блоке.
- Письма должны читаться как настоящая 1:1-переписка с представителем сегмента базы.
- Перед выдачей перечитай каждое письмо вслух: согласование падежей и родов должно быть идеальным (пример ошибки: «на постоянной работой» → «на постоянной работе»). Проверь: в каждом письме есть приветствие в начале и подпись отправителя в конце; первая строка — приветствие, а не утверждение в лоб про бизнес или рынок получателя; ни в одной теме и ни в одном теле нет тире («—», «–»); в каждом письме ровно один CTA-вопрос (ноль CTA — нарушение).

ПРИМЕР — как нельзя и как надо (пример структуры, а не текст для копирования):
ПЛОХО: «У вендоров ПО продажи упираются в потолок трафика. Мы из Polza: пишем холодные письма за компанию, которая продаёт сложный продукт другому бизнесу, и доводим до разговора с ЛПР. Так работали с BPMSoft. Прислать пример цепочки под {{company}}?»
Почему плохо: нет ни приветствия, ни подписи, а первая строка — утверждение в лоб про чужой рынок: питч, а не записка от человека; повод — общее место про сегмент (трюизм про «потолок трафика» верен для всех и ни для кого конкретно); услуга не названа простыми словами, клиент описан через вложенные придаточные; кейс «Так работали с BPMSoft» — наклейка без контекста: непонятно, что делали и причём тут получатель.
ХОРОШО: «Добрый день.

Видел цифру по вашей отрасли: доля сделок, застрявших на этапе пилота, выросла за год в 1,7 раза, и подумал о вас.

Мы в Polza делаем email-аутрич под ключ: находим компании, которым нужен ваш продукт, и приводим их на разговор с ЛПР. Начнём с теста на узком сегменте. Мы в вашей теме: для Диасофт собирали встречи с финансовыми директорами.

Это актуально вам, или подскажете, кто в {{company}} отвечает за новых клиентов?

С уважением,
Сергей, Polza»
Почему хорошо: открывается приветствием, повод мягкий и личный, с опорной цифрой из материалов, а не утверждение в лоб; услуга названа простыми словами; кейс введён через релевантность («мы в вашей теме») с понятным результатом, а не наклейкой; CTA — один гибридный вопрос живой формулировкой; есть подпись отправителя; ни одного тире.`;

// EN-перевод системного блока финальных писем — по смыслу; имена RU-блоков
// материалов («ПОДПИСЬ ОТПРАВИТЕЛЯ», «КЕЙС КЛИЕНТА») — как в материалах.
const LETTERS_SYSTEM_EN = `You are a senior email outreach specialist at the Polza agency. You write the final sequence template following the approved 85/15 plan. The regulations below are hard data from millions of sends — they outrank any other considerations.

${CHAIN_REGULATIONS.en}

Additional template rules:
- The fixed_block text is the mandatory backbone: follow its structure and arguments. If fixed_block suddenly contradicts the regulations (e.g. allows a body longer than 80 words) — the regulations win: body ≤ 80 words, first email ≤ 70 words.
- Do NOT weave segment variants (15%) into the main text: the main email text is the default for the whole base and contains no segment specifics. For each variant from the plan write a SEPARATE "---SEGMENT: <when>---" block right after the corresponding email — the full body variant of that email for the segment (shared subject, also ≤ 80 words). Each segment variant opens with its own reason for its segment.
- Insert personalization operators strictly in the {{var}} format — exactly the names given in the plan. No more than 1–2 distinct ones per email.
- The offer in plain words: the client's service is named with one phrase a stranger understands, from fixed_block/the source sequence — vague labels ("an external team", "a growth partner") are banned. The benefit is the outcome for the recipient in their units (meetings/leads/deals with named target roles), NOT the sender's process ("we write emails", "we do outreach").
- Tone — human dialogue, not advertising: the email reads as a message from one person to another ("I'm writing", "we", conversational language, short sentences), not like a landing page. Advertising clichés are banned: "leader", "best", "effective", "stream of leads", "we guarantee", "profitable", "free", "team of professionals", "individual approach" and the like. In email 1 — no marketing numbers (digits in the body — minus 63% reply): phrase the recipient's outcome via roles/segments ("meetings with HR directors at large employers"), not a cadence like "3–5 meetings a month". Dashes ("—", "–") in subjects and bodies are banned: they are a marker of machine text; replace with a comma, colon, period or parentheses.
- REASON: every email opens with a natural greeting ("Hello {{firstName}}", "Good afternoon"), followed by a concrete reason from the base analysis — why we are writing to these recipients now. The nature of the base dictates the reason: a job-postings base → their hiring; a skew toward regions → the companies' geography; an industry mix → their segment. A generic segment truism as the reason is banned ("everyone in the segment has problem X", "sales are hitting a traffic ceiling"). Each email has its own reason: a new angle = a new fact-reason, not "reminding about myself".
- SIGNATURE: every email closes with the sender's signature (if the materials contain a "ПОДПИСЬ ОТПРАВИТЕЛЯ" block — use it verbatim; otherwise sign as the team of the brief's company, e.g. "The <client company> team" — NEVER invent a person's name). The first line of an email is a greeting, never an in-your-face assertion about the recipient's business or market ("Your market is X", "You sell Y", "Sales are hitting…"): the reason after the greeting goes softly and personally, in one calm sentence, without pathos or lectures about someone else's market.
- Email 1 — mandatory beats, as human dialogue, not a pitch: (1) GREETING — a natural one ("Hello {{firstName}}", "Good afternoon"); (2) REASON — softly and personally, in one calm sentence, a fact from the base analysis about the recipients' world (not a bare categorization "You sell into X"); (3) what I offer — one simple line: the service in plain words + for whom; (4) how and why I can help — proof/relevance (the recipient's outcome via roles/segments); (5) one soft question — the hybrid CTA per the regulations, one fork in a lively wording "Is this relevant to you, or could you point me to who owns <topic> on your team?"; (6) the sender's SIGNATURE. The 5-second test: a stranger instantly answers — who is this, what are they offering, how does it help me. Sender-process descriptions ("we collect signals", "we write to context") are banned from email 1 — process belongs to emails 2+.
- A/B VARIANT of email 1: write email 1 in TWO variants with DIFFERENT reasons per fixed_block. Variant A (primary, the ---LETTER 1--- block) — a reason from the nature of the base/the recipient's world. Variant B (the ---LETTER 1 B--- block, a full email with its own subject) — a reason from the segment/market (the sharpest evidence fact with a real number). B is not a rephrase of A but a different angle; both pass the whole regulations. Variant B exists ONLY for email 1; write emails 2+ in one variant.
- Operator fallbacks — in the nominative form ("your company"): the substitution may land in any sentence position. Put only operators backed by a real base column into the subject — no fallback is possible in the subject.
- At least one email of the sequence must contain one concrete proof element from the provided materials (fixed_block / source sequence): a named client OR a concrete numeric fact — only if it actually exists in the materials. The same case/client name — in at most one email of the sequence. Inventing client names and numbers is forbidden (see the regulations); if there is no suitable case — write nameless.
- If the materials contain a "КЕЙС КЛИЕНТА" block — that is the single case slot of the sequence (cases from the source sequence are a fallback when the block is absent): use it once and ONLY IF relevant to the world of the base recipients (the industry/domain is plausibly close). Introduce through relevance: "we're in your space: we did <what, with what result> for <client>" — never as a bare "we worked with X" sticker. A case from a far-away industry → nameless ("for a corporate software vendor") or skip the case entirely. Real numbers — only from the block, in at most ONE email, and never attribute it to an industry other than the one stated in the block.
- The emails must read as a real 1:1 correspondence with a representative of the base segment.
- Before delivering, read each email aloud: grammar and agreement must be flawless. Check: every email has a greeting at the start and the sender's signature at the end; the first line is a greeting, not an in-your-face assertion about the recipient's business or market; no subject and no body contains a dash ("—", "–"); every email has exactly one CTA question (zero CTAs — a violation).

EXAMPLE — how not to and how to (a structure example, not text to copy):
BAD: "Software vendors' sales are hitting a traffic ceiling. We are Polza: we write cold emails for a company that sells a complex product to other businesses, and we drive it to a conversation with decision-makers. That's how we worked with BPMSoft. Send a sample sequence for {{company}}?"
Why bad: no greeting, no signature, and the first line is an in-your-face assertion about someone else's market: a pitch, not a note from a person; the reason is a generic segment truism (the "traffic ceiling" platitude is true for everyone and no one in particular); the service is not named in plain words, the client is described through nested clauses; the "That's how we worked with BPMSoft" case is a context-free sticker: unclear what was done and what it has to do with the recipient.
GOOD: "Good afternoon.

I saw a figure for your industry: the share of deals stuck at the pilot stage grew 1.7x over the year, and I thought of you.

At Polza we do done-for-you email outreach: we find companies that need your product and bring them to a conversation with decision-makers. We'll start with a test on a narrow segment. We're in your space: for Diasoft we booked meetings with CFOs.

Is this relevant to you, or could you point me to who owns new business at {{company}}?

Best regards,
Sergey, Polza"
Why good: opens with a greeting; the reason is soft and personal, anchored on a number from the materials, not an in-your-face assertion; the service is named in plain words; the case is introduced through relevance ("we're in your space") with a clear result, not as a sticker; the CTA is a single hybrid question in a lively wording; there is a sender's signature; not a single dash.`;

/** Системный блок финальных писем по языку цепочки (PL — RU-вариант, перевода нет). */
const LETTERS_SYSTEM: Record<VeChainLanguage, string> = {
  ru: LETTERS_SYSTEM_RU,
  en: LETTERS_SYSTEM_EN,
  pl: LETTERS_SYSTEM_RU,
};

/** Праймер-ack шага писем по языку цепочки. */
const LETTERS_ACK: Record<VeChainLanguage, string> = {
  ru: 'План и регламент в контексте. Пишу финальные письма строго по плану.',
  en: 'The plan and the regulations are in context. Writing the final emails strictly per the plan.',
  pl: 'Plan i regulamin są w kontekście. Piszę finalne maile ściśle według planu.',
};

const LETTERS_TASK: Record<VeChainLanguage, string> = {
  ru: `Напиши финальные письма цепочки строго по плану выше. Количество писем = количеству писем в исходной цепочке. У письма 1 — два варианта (A и B, разные поводы по плану), у остальных — только вариант A.

ФОРМАТ ВЫВОДА (ОБЯЗАТЕЛЕН — иначе ответ не пройдёт парсинг):
---LETTER 1---
Тема: <тема письма 1, вариант A>

<тело письма 1, вариант A>

---SEGMENT: <условие сегмента из плана, дословно, напр. «компании вне Москвы/СПб»>---

<полный вариант тела письма 1 для этого сегмента>

---LETTER 1 B---
Тема: <тема письма 1, вариант B — другой повод>

<тело письма 1, вариант B>

---LETTER 2---
Тема: <тема письма 2>

<тело письма 2>

...и так далее до последнего письма. Блок «---LETTER 1 B---» — только у письма 1, сразу после его сегментных блоков. Блок «---SEGMENT: ...---» добавляй ТОЛЬКО если для этого письма есть сегментный вариант в плане, сразу после соответствующего письма (вариантов может быть несколько — по блоку на каждый). Никаких пояснений до/после блоков. Маркеры «---LETTER N---», «---LETTER 1 B---», «---SEGMENT: ...---» и слово «Тема:» не меняй. Пиши на русском.`,
  en: `Write the final sequence emails strictly following the plan above. The number of emails must match the source chain. Email 1 has two variants (A and B, different reasons per the plan); the rest have variant A only.

PLAIN VOICE — THE READ-ALOUD TEST. Write like a person emailing a colleague: short uneven sentences, concrete nouns, plain verbs. Banned LLM tells: filler intensifiers ("really", "truly", "actually", "genuinely", "literally"), throat-clearing openers ("I hope this email finds you well", "I hope you're doing well"), hedges ("just wanted to", "just checking in", "just reaching out"), the "not only ... but also" construction, and corporate-register words ("leverage", "underscore", "delve into", "landscape", "synergy", "empower", "elevate", "supercharge", "game-changer", "cutting-edge", "seamless", "streamline", "unlock"). If a sentence would sound polished on a company blog, rewrite it the way you'd say it to a person.

OUTPUT FORMAT (MANDATORY — otherwise the response will fail parsing):
---LETTER 1---
Subject: <subject of email 1, variant A>

<body of email 1, variant A>

---SEGMENT: <segment condition from the plan, verbatim>---

<full body variant of email 1 for this segment>

---LETTER 1 B---
Subject: <subject of email 1, variant B — different reason>

<body of email 1, variant B>

---LETTER 2---
Subject: <subject of email 2>

<body of email 2>

...and so on through the last email. The "---LETTER 1 B---" block belongs to email 1 only, right after its segment blocks. Add a "---SEGMENT: ...---" block ONLY if the plan has a segment variant for that email, right after the corresponding email (one block per variant). No explanations before/after the blocks. Keep the "---LETTER N---", "---LETTER 1 B---", "---SEGMENT: ...---" markers and the word "Subject:" exactly as shown. Write in English.`,
  pl: `Napisz finalne maile sekwencji ściśle według planu powyżej. Liczba maili musi odpowiadać łańcuchowi źródłowemu. Mail 1 ma dwa warianty (A i B, różne powody wg planu), pozostałe — tylko wariant A.

FORMAT ODPOWIEDZI (OBOWIĄZKOWY — inaczej odpowiedź nie przejdzie parsowania):
---LETTER 1---
Temat: <temat maila 1, wariant A>

<treść maila 1, wariant A>

---SEGMENT: <warunek segmentu z planu, dosłownie>---

<pełny wariant treści maila 1 dla tego segmentu>

---LETTER 1 B---
Temat: <temat maila 1, wariant B — inny powód>

<treść maila 1, wariant B>

---LETTER 2---
Temat: <temat maila 2>

<treść maila 2>

...i tak dalej do ostatniego maila. Blok „---LETTER 1 B---” — tylko przy mailu 1, zaraz po jego blokach segmentowych. Blok „---SEGMENT: ...---” dodawaj TYLKO jeśli plan przewiduje wariant segmentowy dla tego maila, zaraz po odpowiednim mailu (jeden blok na wariant). Żadnych wyjaśnień przed/po blokach. Znaczników „---LETTER N---”, „---LETTER 1 B---”, „---SEGMENT: ...---” i słowa "Temat:" nie zmieniaj. Pisz po polsku.`,
};

export interface TemplateLettersPromptInput extends VePromptInjections {
  language: VeChainLanguage;
  plan: VeTemplatePlanOutput;
  verticalName: string;
  chainLetters: VeChainLetter[];
  baseAnalysis: VeBaseAnalysisOutput;
  /** Опционально: выбранный кейс клиента (ve_cases) — ГЛАВНОЕ доказательство цепочки. */
  clientCase?: VeCaseDraft | null;
}

/** Сообщения для генерации финальных писем по плану 85/15. */
export function buildTemplateLettersMessages(input: TemplateLettersPromptInput): LLMMessage[] {
  const lang: VeChainLanguage = input.language === 'en' || input.language === 'pl' ? input.language : 'ru';

  const variants = (input.plan.letters ?? [])
    .flatMap((l) =>
      l.segment_variants.map((v) => `- Письмо ${l.letter_index}, сегмент «${v.when}»: ${v.text}`),
    )
    .join('\n');
  const legacyAdditions = input.plan.segment_additions
    .map((a) => `- Письмо ${a.letter_index}: ${a.addition}${a.why ? ` (зачем: ${a.why})` : ''}`)
    .join('\n');
  const operators = input.plan.personalization_plan
    .map((p) => {
      const ops = p.operators
        .map((o) => `{{${o.var}}} ← колонка «${o.column}»${o.fallback ? `, fallback: «${o.fallback}»` : ''}`)
        .join(', ');
      return `- Письмо ${p.letter_index}: ${ops}`;
    })
    .join('\n');

  const materials = `ВЕРТИКАЛЬ: ${input.verticalName}

FIXED BLOCK (~85%, обязательный костяк):
"""
${input.plan.fixed_block}
"""
${input.clientCase ? `\n${renderClientCaseBlock(input.clientCase)}\n` : ''}
${renderStyleExampleBlock(input.styleExample)}${renderWinnerPatternsBlock(input.winnerPatterns)}${renderSignatureBlock(input.signatureOverride)}СЕГМЕНТНЫЕ ВАРИАНТЫ (~15%, условные — для каждого отдельный блок ---SEGMENT: <when>--- после письма; в основной текст НЕ включать):
${variants || '(нет)'}${legacyAdditions ? `\nДополнительные углы из плана (тоже только в сегментные варианты, не в основной текст):\n${legacyAdditions}` : ''}

ОПЕРАТОРЫ ПЕРСОНАЛИЗАЦИИ (вставлять как есть, формат {{var}}):
${operators || '(без операторов — пиши без подстановок)'}

ИСХОДНАЯ ЦЕПОЧКА (референс структуры и тона):
${renderChainLetters(input.chainLetters)}

КРАТКО О БАЗЕ (для интонации):
заметные сегменты: ${input.baseAnalysis.notable_segments.join('; ') || '—'}
рекомендованные углы: ${input.baseAnalysis.recommended_angles.join('; ') || '—'}`;

  return [
    { role: 'system', content: LETTERS_SYSTEM[lang] },
    { role: 'user', content: materials },
    { role: 'assistant', content: LETTERS_ACK[lang] },
    { role: 'user', content: LETTERS_TASK[lang] },
  ];
}

/* ─────────────── Проход 2: критик и рерайт финальных писем ─────────────── */

/**
 * Финальные письма шаблона — та же цепочка {subject, body}, поэтому проход 2
 * переиспользует общие билдеры chain (скептичный ЛПР вертикали + рерайт
 * только отмеченных писем, маркеры ---LETTER N--- для letterParser). Типы
 * продублированы с template-неймингом, чтобы стадия template не тянула
 * chain-терминологию.
 */

/** Одна реальная проблема письма (letter_index — 1-based номер в цепочке). */
export interface VeTemplateCriticIssue {
  letter_index: number;
  problem: string;
  fix: string;
}

/** Вердикт критика по финальным письмам: одна строка + список проблем. */
export interface VeTemplateCritique {
  verdict: string;
  issues: VeTemplateCriticIssue[];
}

/**
 * Сообщения критик-прохода для финальных писем шаблона.
 * Ответ — JSON VeTemplateCritique (вызов через callLLMWithSchema).
 */
export function buildTemplateCriticMessages(input: {
  verticalName: string;
  verticalSummary?: string | null;
  letters: Array<{ subject: string; body: string }>;
  language: 'ru' | 'en' | 'pl';
  styleExample?: string | null;
  winnerPatterns?: Array<{ pattern: string; reply_pct: number }>;
}): LLMMessage[] {
  return buildChainCriticMessages(input);
}

/**
 * Сообщения рерайт-прохода для финальных писем шаблона: переписываются
 * только письма из issues критики, остальные возвращаются дословно; вывод —
 * маркерами ---LETTER N--- (парсит letterParser).
 */
export function buildTemplateRewriteMessages(input: {
  verticalName: string;
  letters: Array<{ subject: string; body: string }>;
  critique: VeTemplateCritique;
  language: 'ru' | 'en' | 'pl';
  styleExample?: string | null;
  winnerPatterns?: Array<{ pattern: string; reply_pct: number }>;
  signatureOverride?: string | null;
}): LLMMessage[] {
  return buildChainRewriteMessages(input);
}
