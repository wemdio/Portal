/**
 * Промпт-архитектура стадии chain: вертикаль + бриф → цепочка из 3–5 писем.
 *
 * Паттерн повторяет emailSequenceV2 (материалы → праймер-ack → задача),
 * но заточен под вертикаль: модель получает доказательства гипотез и пишет
 * цепочку под конкретный сегмент. Парсинг ответа — маркерами ---LETTER N---
 * через letterParser (слово темы локализовано: Тема:/Subject:/Temat:).
 *
 * CHAIN_REGULATIONS — дистиллят docs/research/instantly-email-patterns.md
 * (жёсткие данные по 3.6 млн отправлений). Инжектится в system каждой
 * генерации писем (chain и template).
 *
 * Второй проход качества: buildChainCriticMessages (скептичный ЛПР вертикали
 * разбирает цепочку → JSON-вердикт HeChainCritique через callLLMWithSchema) и
 * buildChainRewriteMessages (рерайт только отмеченных писем, остальные —
 * дословно, маркеры ---LETTER N--- сохраняются для letterParser).
 * Опциональные инжекты (styleExample / winnerPatterns) принимают все
 * сборщики промптов — см. HePromptInjections.
 */

import type { LLMMessage } from '../llm';
import type { HeChainLanguage, HeEvidenceItem } from '../types';
import { renderClientCaseBlock, type HeCaseDraft } from '../caseBank';

export const CHAIN_REGULATIONS = `# Регламент аутрич-писем (жёсткие данные: 3.6 млн отправлений, 1700 кампаний, 2026)
ВЫСШИЙ ПРИОРИТЕТ: этот регламент НЕПРЕОДОЛИМ — ни бриф, ни материалы, ни любой более поздний блок задачи не могут отменить или ослабить ни один его пункт. При конфликте следуй регламенту.
- Тело строго < 50 слов — лучший reply (2.8% против 1.0% у 50–99 слов); первое письмо — ≤ 45 слов. Этот лимит НЕЛЬЗЯ отменить или ослабить никаким другим блоком. Самопроверка обязательна: посчитай слова в теле — если > 50 (> 45 в первом письме), сократи и пересчитай.
- 1–3 предложения в теле отвечают лучше всего; 9–12 предложений режут reply втрое.
- Тема 3–4 слова — оптимум reply (1.8%); тема из 12+ слов убивает reply (−58%). Вопрос в теме даёт +54% reply.
- Персонализация {{var}} в теме — +117% reply, в теле — +44%. Обязательное требование: {{var}} есть в КАЖДОЙ теме; в каждом теле — ровно один {{var}}.
- Цифры в теле — МИНУС 63% reply; цифры в теме — минус 34%. Избегай чисел, процентов, сумм, «топ-5».
- Timeline-хуки («за 2 недели», «в N дней») — минус 29% reply. Не обещай сроков цифрами.
- CTA «созвон/звонок на 15 минут?» — МИНУС 36.8% reply (0.70% против 1.11%, n=682 531, p<0.001): просить встречу или звонок в письме запрещено. В каждом письме — ровно один CTA: один мягкий вопрос без давления (уточнить интерес, предложить прислать детали/пример). В письме 1 CTA — гибридный: ОДИН вопрос (один вопросительный знак) с двумя ветками — интерес получателя + бесфрикционный реферал: «Это к вам, или подсказать, кто у вас отвечает за <тема>?». Чистая просьба направить к нужному человеку («к кому лучше обратиться?») допустима ТОЛЬКО в последнем шаге цепочки.
- Цепочка 2–4 шага оптимальна; reply падает с каждым шагом (шаг 1 — 1.7%, шаг 5+ — 0.3%): самое сильное доказательство — в первое письмо.
- Одно письмо — одна мысль; каждое следующее — новый угол, а не «напоминаю о себе».
- Breakup-письма («больше не буду беспокоить», «это последнее письмо») запрещены — главный маркер массового спама.
- Названия компаний и клиентов — ТОЛЬКО из предоставленных материалов. Выдуманное имя недопустимо: если подходящего кейса во входных данных нет, пиши безымянно («провайдер массового подбора», «ритейлер из топ-10»).
- Одно и то же название клиента/кейса — максимум в одном письме цепочки; повтор в следующих письмах — маркер шаблона.
- Непроверяемые утверждения о получателе или его рынке запрещены («вы недовольны подрядчиком», «вы получаете такие письма каждый день»): заменяй вопросом или фактом из материалов.
- Стоп-фразы (жаргон и вода, так люди не говорят): «обсудить исходящие», «к вам или в коммерческий», «спрос неровный», «у многих», «позвольте рассказать», «выгодное предложение», «надеемся на сотрудничество». Пиши так, как живой человек пишет коллеге.`;

/* ─────────────── Опциональные инжекты качества ─────────────── */

/**
 * Опциональные поля-инжекты, которые принимают все сборщики промптов
 * chain и template (генерация, критик, рерайт).
 */
export interface HePromptInjections {
  /** Пример письма клиента — эталон стиля (в промпт попадает ≤ 4000 символов). */
  styleExample?: string | null;
  /** Темы/ходы, доказавшие reply в наших кампаниях (вдохновение, не копирование). */
  winnerPatterns?: Array<{ pattern: string; reply_pct: number }>;
}

/** Максимум символов эталона стиля в промпте. */
const STYLE_EXAMPLE_MAX_CHARS = 4000;

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
- Рекламные клише запрещены: «лидер», «лучший», «эффективный», «поток заявок», «гарантируем», «выгодно», «бесплатно», «команда профессионалов», «индивидуальный подход» и подобные.
- В письме 1 — никаких маркетинговых цифр (цифры в теле — минус 63% reply): результат для получателя формулируй через роли/сегменты («встречи с HRD крупных работодателей»), а не каденсом «3–5 встреч в месяц».

Как использовать материалы:
- Вертикаль и её синонимы — это ЦА: пиши так, будто понимаешь их индустрию изнутри (их термины, их боли, их метрики).
- Покрывай вертикаль ЦЕЛИКОМ: если в описании вертикали перечислены суб-сегменты, формулировки должны быть нейтральными и подходить каждому из них. Запрещено молча сужать цепочку до одного суб-сегмента или перескакивать на другую аудиторию в середине цепочки.
- Гипотезы и доказательства — ПЕРВИЧНЫЙ источник болей, углов и конкретики: рыночные факты, чужие кейсы, регуляторные драйверы. Гипотезы с пометкой «✓ ПОДТВЕЖДЕНО СПЕЦИАЛИСТОМ» подтверждены человеком — они в приоритете. Не вводи рыночные углы и боли, противоречащие списку гипотез; отклонённые специалистом гипотезы в материалах просто отсутствуют — не упоминай их существование. Опирайся на список, но НЕ цитируй URL в письмах и не грузи цифрами (см. регламент).
- Бриф клиента — оффер и УТП. Одно письмо — одна мысль/одно УТП, распредели их по цепочке.
- Если в материалах есть блок «КЕЙС КЛИЕНТА» — это ГЛАВНОЕ доказательство цепочки и её единственный кейс-слот: он замещает общее правило «один кейс из материалов» (кейсы из брифа — только когда этого блока нет). Используй его с реальными цифрами из блока, максимум в ОДНОМ письме, и никогда не приписывай его другой индустрии, чем указана в блоке.
- Первое письмо — самое сильное: лучший угол + лучшее доказательство. Фоллоу-апы — новые углы, а не «пинг».

Обязательная конструкция цепочки:
- Письмо 1 (обязательные биты, человеческим диалогом, а не питчем): (1) почему пишу — триггер про получателя: наблюдаемый факт о его сегменте, а НЕ голая категоризация вроде «Вы продаёте в X» и НЕ непроверяемое утверждение о самом получателе; (2) что предлагаю — одна простая строка: услуга простыми словами + для кого; (3) как и почему могу помочь — доказательство/релевантность (результат для получателя через роли/сегменты, без маркетинговых цифр); (4) один мягкий вопрос — гибридный CTA по регламенту. Тест 5 секунд: незнакомец после письма 1 мгновенно отвечает — кто это, что предлагают, как это поможет мне; не проходит — перепиши. Описания процесса отправителя («собираем сигналы», «пишем под контекст») в письме 1 запрещены — процессу место в письмах 2+.
- Конкретный кейс/доказательный факт (имя клиента и/или конкретный результат) — ТОЛЬКО из материалов и ровно в ОДНОМ письме цепочки: одно и то же название кейса/клиента не может появляться больше чем в одном письме. Если подходящего кейса в материалах нет — пиши безымянно; выдумывать названия запрещено.
- Чистая просьба направить к нужному человеку («к кому лучше обратиться?») — только в последнем письме, один раз на всю цепочку; в письме 1 реферальная ветка допустима только внутри гибридного CTA (см. регламент).
${'{{OPERATORS_HINT}}'}
ПРИМЕР — как нельзя и как надо (пример структуры, а не текст для копирования):
ПЛОХО: «Polza пишет холодные письма за компанию, которая продаёт сложный продукт другому бизнесу, и доводит до разговора с ЛПР. Работаем как внешняя команда — с Диасофт, BPMSoft и Первой Формой. Прислать пример цепочки под {{company}}?»
Почему плохо: услуга не названа простыми словами, клиент описан через вложенные придаточные, выгоды получателя нет — только механика отправителя.
ХОРОШО: «Пишу, потому что у компаний со сложным B2B-продуктом продажи часто упираются в поиск ЛПР. Мы — Polza, делаем email-аутрич под ключ: находим нужные компании и приводим на разговор с ЛПР — так работали с Диасофт и BPMSoft. Начать можно с теста на узком сегменте. Это к вам, или подсказать, кто в {{company}} отвечает за новых клиентов?»
ЖЁСТКИЕ САМОПРОВЕРКИ ПЕРЕД ВЫДАЧЕЙ (не выполнено — перепиши):
- Посчитай слова в каждом теле: > 50 — сократи и пересчитай; письмо 1 — ≤ 45 слов.
- В КАЖДОЙ теме есть {{var}}; в каждом теле — ровно один {{var}}.
- В каждом письме — ровно один CTA; в письме 1 — гибридный вопрос с одним вопросительным знаком.
- Нет непроверяемых утверждений о получателе или его рынке: такие мысли оформляй вопросом или фактом из материалов.
- Нет стоп-фраз из регламента («обсудить исходящие», «к вам или в коммерческий», «спрос неровный», «у многих») и рекламных клише («лидер», «лучший», «гарантируем», «выгодно», «бесплатно»).
- В письме 1 нет маркетинговых цифр: результат получателя сформулирован через роли/сегменты.
- Перечитай каждое письмо вслух: согласование падежей и родов должно быть идеальным (пример ошибки: «на постоянной работой» → «на постоянной работе»).

ЯЗЫК: вся цепочка строго на русском. Бренды и устоявшиеся термины индустрии — в оригинале.

ФОРМАТ ВЫВОДА (ОБЯЗАТЕЛЕН — иначе ответ не пройдёт парсинг):
---LETTER 1---
Тема: <тема письма 1>

<тело письма 1>

---LETTER 2---
Тема: <тема письма 2>

<тело письма 2>

...и так далее до последнего письма. Никаких пояснений до/после блоков. Маркеры «---LETTER N---» и слово «Тема:» не меняй.`,

  en: `You are a senior email outreach specialist with 400+ launched cold B2B campaigns (average reply rate 8–18%).

Write a sequence of 4 emails (3–5 is acceptable) for a cold campaign targeting the vertical described in the materials above.

How to use the materials:
- The vertical and its synonyms are the audience: write as if you know their industry from the inside (their terms, their pains, their metrics).
- The hypotheses list is the PRIMARY source of pains, angles and specifics: market facts, third-party cases, regulatory drivers. Items marked "✓ ПОДТВЕЖДЕНО СПЕЦИАЛИСТОМ" are human-confirmed and take priority. Do not introduce market angles or pains that contradict the list; rejected hypotheses are simply absent from the materials — never mention their existence. Rely on the list, but do NOT cite URLs in the emails and do not overload them with numbers (see the regulations).
- The client brief is the offer and USPs. One email — one idea/one USP; spread them across the sequence.
- If the materials contain a "КЕЙС КЛИЕНТА" block — that is THE proof case of the sequence and its single case slot: it replaces the generic "one case from the materials" rule (brief cases remain a fallback only when this block is absent). Render it with its real numbers, in at most ONE email, and never attribute it to an industry other than the one stated in the block.
- The first email is the strongest: best angle + best proof. Follow-ups bring new angles, not "just bumping this".

STEP 0 — THE OFFER (mandatory structure). Before writing, formulate the offer in four parts — in the vertical's own terms:
1. THE SERVICE IN PLAIN WORDS: what the client is — one phrase a stranger understands ("done-for-you B2B email outreach", "a staffing agency for mass hiring"), from the brief/site profile; if the materials contain the "ОФФЕР КЛИЕНТА (offer_override)" block — use its wording verbatim, do not reinvent it. Vague labels ("an external team", "a growth partner") are banned.
2. THE RECIPIENT'S OUTCOME: what the recipient's business gains, in the recipient's units — meetings/leads/deals with named target roles per period ("3–5 meetings a month with logistics directors at shippers"). The benefit is what the recipient gains, NEVER the sender's process: "we write emails", "we do outreach" as the benefit are banned. In email 1 the outcome is rendered via roles/segments, without cadence numbers (see TONE below).
3. THE START: a low-commitment first step ("a 2-week test on a narrow segment").
4. PROOF: one case (a real name from the materials only), assigned to exactly ONE email of the sequence.
The offer (parts 1–2) must be explicit in email 1: the recipient must instantly understand who is writing, what is offered, and how it helps them. Numbers and timelines inside the emails themselves follow the regulations only.

TONE — HUMAN DIALOGUE, NOT ADVERTISING. We are not blasting ads — we are having a human conversation: why we wrote, what we offer, how and why we can help.
- The email reads as one person writing to another: "I'm writing", "we", conversational language, short sentences. Never like a landing page or a company deck.
- Advertising clichés are banned: "leader", "best", "effective", "stream of leads", "we guarantee", "free", "team of professionals", "individual approach" and the like.
- No marketing numbers in email 1 (digits in the body → −63% reply): phrase the recipient's outcome via roles/segments ("meetings with HR directors at large employers"), not a cadence like "3–5 meetings a month".

Mandatory sequence construction:
- Email 1 (mandatory beats, rendered as human dialogue, not a pitch): (1) why I'm writing — a trigger about the recipient: an observable fact about their segment, NOT bare categorization like "You sell into X" and NOT an unverifiable claim about the recipient themselves; (2) what I offer — one simple line: the service in plain words + for whom; (3) how and why I can help — proof/relevance (the recipient's outcome via roles/segments, no marketing numbers); (4) one soft hybrid question — ONE question (one question mark) with two branches, interest + frictionless referral: "Is this for you, or could you point me to who owns <topic>?" The 5-second test: after email 1 a stranger instantly answers — who is this, what do they offer, how does it help me; if it fails — rewrite. Self-centered process descriptions ("we collect signals", "we write to context") are banned from email 1 — process belongs to emails 2+.
- A specific case/proof (client name and/or concrete result) — from the materials ONLY and in exactly ONE email of the sequence: the same named case/client may not appear in more than one email. If no suitable case exists in the materials — write without names; inventing names is forbidden.
- A pure referral ask ("who should I talk to?") — only in the last email, once per sequence; in email 1 the referral branch is allowed only inside the hybrid CTA (see the regulations).

FINAL SELF-CHECK: read every email aloud — grammar and agreement must be flawless; no advertising clichés; no marketing numbers in email 1.
${'{{OPERATORS_HINT}}'}
LANGUAGE: write the entire sequence strictly in English, even though the materials may be in Russian. Convey the meaning, do not translate word for word.

OUTPUT FORMAT (MANDATORY — otherwise the response will fail parsing):
---LETTER 1---
Subject: <subject of email 1>

<body of email 1>

---LETTER 2---
Subject: <subject of email 2>

<body of email 2>

...and so on through the last email. No explanations before/after the blocks. Keep the "---LETTER N---" markers and the word "Subject:" exactly as shown.`,

  pl: `Jesteś starszym specjalistą ds. email outreach z ponad 400 uruchomionymi zimnymi kampaniami B2B (średni reply rate 8–18%).

Napisz sekwencję 4 maili (dopuszczalne 3–5) do zimnej kampanii pod pion opisany w materiałach powyżej.

Jak używać materiałów:
- Pion i jego synonimy to grupa docelowa: pisz tak, jakbyś znał ich branżę od środka (ich terminy, ich bóle, ich metryki).
- Lista hipotez to PIERWSZE źródło bólów, kątów i konkretów: fakty rynkowe, case studies, czynniki regulacyjne. Pozycje oznaczone «✓ ПОДТВЕЖДЕНО СПЕЦИАЛИСТОМ» zostały potwierdzone przez człowieka — mają priorytet. Nie wprowadzaj kątów rynkowych ani bólów sprzecznych z listą; odrzucone hipotezy są po prostu nieobecne w materiałach — nigdy nie wspominaj o ich istnieniu. Opieraj się na liście, ale NIE cytuj URL-i w mailach i nie przeciążaj liczbami (patrz regulamin).
- Brief klienta to oferta i USP. Jeden mail — jedna myśl/jeden USP; rozłóż je na całą sekwencję.
- Jeśli w materiałach jest blok «КЕЙС КЛИЕНТА» — to GŁÓWNY dowód sekwencji i jej jedyny slot na case: zastępuje ogólną zasadę «jeden case z materiałów» (case'y z briefu — tylko gdy tego bloku nie ma). Użyj go z prawdziwymi liczbami z bloku, maksymalnie w JEDNYM mailu, i nigdy nie przypisuj go do innej branży niż wskazana w bloku.
- Pierwszy mail jest najsilniejszy: najlepszy kąt + najlepszy dowód. Follow-upy wnoszą nowe kąty, nie "przypominam o sobie".

KROK 0 — OFERTA (obowiązkowa struktura). Zanim zaczniesz pisać, sformułuj dla siebie ofertę w czterech częściach — w terminologii samego pionu:
1. USŁUGA PROSTYMI SŁOWAMI: kim jest klient — jedna fraza zrozumiała dla osoby postronnej („email outreach pod klucz dla B2B", „agencja pracy od rekrutacji masowej"), z briefu/profilu strony; jeśli w materiałach jest blok „ОФФЕР КЛИЕНТА (offer_override)" — użyj jego sformułowania dosłownie, nie wymyślaj na nowo. Ogólnikowe etykiety („zewnętrzny zespół", „partner wzrostu") są zakazane.
2. REZULTAT DLA ODBIORCY: co zyskuje biznes odbiorcy, w jego jednostkach — spotkania/leady/transakcje z wymienionymi rolami docelowymi w danym okresie („3–5 spotkań miesięcznie z dyrektorami ds. logistyki u nadawców"). Korzyścią jest zysk odbiorcy, a NIE proces nadawcy: „piszemy maile", „zajmujemy się outreachem" jako korzyść są zakazane. W mailu 1 rezultat podawany jest przez role/segmenty, bez liczb-kadencji (patrz TON niżej).
3. START: pierwszy krok o niskim progu wejścia („2-tygodniowy test na wąskim segmencie").
4. DOWÓD: jeden case (prawdziwa nazwa — wyłącznie z materiałów), przypisany do DOKŁADNIE JEDNEGO maila sekwencji.
Oferta (punkty 1–2) musi brzmieć wprost w mailu 1: odbiorca musi od razu zrozumieć, kto pisze, co się mu oferuje i jak to mu pomoże. Liczby i terminy w treści samych maili — wyłącznie według zasad regulaminu.

TON — LUDZKI DIALOG, NIE REKLAMA. Nie rozsyłamy reklamy — prowadzimy ludzki dialog: dlaczego piszemy, co oferujemy, jak i dlaczego możemy pomóc.
- Mail czyta się jak wiadomość od jednego człowieka do drugiego: „piszę", „u nas", potoczny język, krótkie zdania. Nigdy jak landing page ani prezentacja firmy.
- Reklamowe frazesy są zakazane: „lider", „najlepszy", „skuteczny", „strumień zapytań", „gwarantujemy", „za darmo", „zespół profesjonalistów", „indywidualne podejście" i podobne.
- W mailu 1 — żadnych marketingowych liczb (cyfry w treści → −63% reply): rezultat dla odbiorcy formułuj przez role/segmenty („spotkania z dyrektorami HR u dużych pracodawców"), a nie kadencją „3–5 spotkań miesięcznie".

Obowiązkowa konstrukcja sekwencji:
- Mail 1 (obowiązkowe bity, prowadzone ludzkim dialogiem, nie pitczem): (1) dlaczego piszę — trigger o odbiorcy: obserwowalny fakt o jego segmencie, NIE goła kategoryzacja „Sprzedajecie do X" i NIE niesprawdzalne twierdzenie o samym odbiorcy; (2) co oferuję — jedna prosta linia: usługa prostymi słowami + dla kogo; (3) jak i dlaczego mogę pomóc — dowód/trafność (rezultat dla odbiorcy przez role/segmenty, bez marketingowych liczb); (4) jedno miękkie hybrydowe pytanie — JEDNO pytanie (jeden znak zapytania) z dwiema gałęziami: zainteresowanie + bezproblemowe polecenie: „Czy to do Ciebie, czy podpowiesz, kto u Was odpowiada za <temat>?" Test 5 sekund: obca osoba po mailu 1 natychmiast odpowiada — kto to, co oferuje, jak mi to pomoże; jeśli nie przechodzi — napisz od nowa. Autocentryczne opisy procesu nadawcy („zbieramy sygnały", „piszemy pod kontekst") są zakazane w mailu 1 — proces należy do maili 2+.
- Konkretny case/fakt dowodowy (nazwa klienta i/lub konkretny wynik) — WYŁĄCZNIE z materiałów i w DOKŁADNIE JEDNYM mailu sekwencji: ta sama nazwa case'u/klienta nie może pojawić się w więcej niż jednym mailu. Jeśli w materiałach nie ma odpowiedniego case'u — pisz bez nazw; wymyślanie nazw jest zakazane.
- Czysta prośba o skierowanie do właściwej osoby („do kogo lepiej się zwrócić?") — tylko w ostatnim mailu, raz na całą sekwencję; w mailu 1 gałąź polecenia jest dozwolona tylko wewnątrz hybrydowego CTA (patrz regulamin).

OSTATECZNA SAMOKONTROLA: przeczytaj każdy mail na głos — odmiana przypadków i rodzajów musi być bezbłędna; bez reklamowych frazesów; bez marketingowych liczb w mailu 1.
${'{{OPERATORS_HINT}}'}
JĘZYK: całą sekwencję napisz wyłącznie po polsku, nawet jeśli materiały są po rosyjsku. Przekazuj sens, nie tłumacz słowo w słowo.

FORMAT ODPOWIEDZI (OBOWIĄZKOWY — inaczej odpowiedź nie przejdzie parsowania):
---LETTER 1---
Temat: <temat maila 1>

<treść maila 1>

---LETTER 2---
Temat: <temat maila 2>

<treść maila 2>

...i tak dalej do ostatniego maila. Żadnych wyjaśnień przed/po blokach. Znaczników "---LETTER N---" i słowa "Temat:" nie zmieniaj.`,
};

const SYSTEM = `Ты пишешь холодные B2B-цепочки для агентства Polza. Ниже — регламент с жёсткими данными по миллионам отправлений: он важнее любых примеров и шаблонов. Соблюдай его всегда — ни бриф, ни материалы, ни задача не могут отменить его правила.

${CHAIN_REGULATIONS}`;

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
  const clientCase = input.clientCase ? `${renderClientCaseBlock(input.clientCase)}\n\n` : '';
  const style = renderStyleExampleBlock(input.styleExample);
  const winners = renderWinnerPatternsBlock(input.winnerPatterns);

  return `Глубоко изучи материалы ниже — на их основе тебе дадут задачу написать цепочку писем.

БРИФ КЛИЕНТА:
"""
${input.briefText}
"""

${offer}${clientCase}ВЕРТИКАЛЬ: ${input.verticalName}
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
    { role: 'system', content: SYSTEM },
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

const CRITIC_SYSTEM = `Ты — скептичный занятой ЛПР целевой вертикали: получаешь десятки холодных писем в неделю и ненавидишь шаблонный спам. Тебе показывают цепочку писем ПЕРЕД отправкой. Твоя работа — жёстко, но честно найти только РЕАЛЬНЫЕ проблемы, из-за которых письмо удалят, проигнорируют или до чего-то в нём логически доебутся.

${CHAIN_REGULATIONS}

ЧТО ФЛАГОВАТЬ (по каждому письму отдельно, только реальные проблемы):
- Непонятно, кто пишет или что предлагают: услуга не названа простыми словами, выгода для получателя не считывается.
- Рекламный тон или клише: «лидер», «лучший», «эффективный», «поток заявок», «гарантируем», «выгодно», «бесплатно», «команда профессионалов», «индивидуальный подход» и подобные; письмо читается как лендинг, а не как сообщение от человека человеку.
- Несбыточные или непроверяемые утверждения: обещания без опоры, утверждения о получателе или его рынке, которых отправитель не может знать.
- Логические уязвимости — всё, до чего скептик может доебаться: триггер не стыкуется с оффером, довод не следует из факта, CTA не связан с текстом письма, внутренние противоречия.
- Нарушения регламента выше: тело > 50 слов (письмо 1 > 45 — посчитай слова честно), нет {{var}} в теме, не ровно один {{var}} в теле, не ровно один CTA (в том числе ноль), цифры в теме или теле, timeline-обещания, breakup-фразы, просьба о звонке/встрече, fallback-подстановка не в именительном падеже.
- В письме 1 CTA не гибридный (нет реферальной ветки).
- Грамматика и чистота языка: согласование падежей и родов, нестандартное управление (пример: „держится работой" вместо „держится на работе"), оборванные или незаконченные фразы.
- Тест 5 секунд не пройден: после беглого чтения письма 1 нельзя мгновенно ответить — кто это, что предлагают, как это поможет мне.

КАЛИБРОВКА — НЕ ПРИДИРАЙСЯ:
- Живое короткое письмо по делу — не проблема, даже если написано не так, как написал бы ты. Флаги только то, что реально снизит шанс ответа или выставит отправителя спамером. Одна и та же проблема — один issue, не дублируй её разными словами.
- Если в материалах есть «ЭТАЛОН СТИЛЯ КЛИЕНТА» — оценивай тон относительно эталона: его имитация важнее дефолтных правил тона, но не отменяет регламент, запрет выдуманных имён и структуру оффера.
- Если в материалах есть «ПРОВЕННЫЕ ПАТТЕРНЫ» — не флаги темы и хуки, которые их адаптируют; флаги только дословное копирование паттерна без привязки к вертикали или цитирование процентов reply в письме.
- Формулируй конкретно: problem — в чём именно дело, с короткой цитатой фрагмента письма; fix — что конкретно изменить (действие, а не «сделать лучше»).

Вердикт — одна строка: «можно отправлять» (реальных проблем нет) или «нужна перепись» (есть хотя бы одна).`;

const LANG_NAMES: Record<HeChainLanguage, string> = {
  ru: 'русский',
  en: 'английский',
  pl: 'польский',
};

function renderLettersForReview(letters: Array<{ subject: string; body: string }>): string {
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

  const user = `ВЕРТИКАЛЬ: ${input.verticalName}
${summary ? `${summary}\n` : ''}
${style}${winners}ЦЕПОЧКА ПИСЕМ (${input.letters.length} шт., язык: ${LANG_NAMES[lang]} — оценивай глазами носителя этого языка):
${renderLettersForReview(input.letters)}

Прочитай цепочку как занятой ЛПР этой вертикали, который ненавидит шаблонный спам. Разбери каждое письмо по правилам выше и верни ТОЛЬКО JSON строго такой формы — без markdown-фенсов, без текста до или после:
{
  "verdict": "можно отправлять" | "нужна перепись",
  "issues": [
    { "letter_index": <1-based номер письма>, "problem": "<в чём проблема, с короткой цитатой>", "fix": "<что конкретно изменить>" }
  ]
}
Правила ответа: verdict — ровно одна из двух строк; «можно отправлять» ⇔ issues пустой, «нужна перепись» ⇔ хотя бы один issue; letter_index — только в диапазоне 1..${input.letters.length}; problem и fix — по-русски.`;

  return [
    { role: 'system', content: CRITIC_SYSTEM },
    { role: 'user', content: user },
  ];
}

/* ─────────────── Рерайт отмеченных писем ─────────────── */

const REWRITE_SYSTEM = `Ты — senior email outreach редактор агентства Polza. Получаешь цепочку писем и разбор критика: переписываешь ТОЛЬКО отмеченные письма, остальные возвращаешь без изменений.

${CHAIN_REGULATIONS}

ЖЁСТКИЕ ПРАВИЛА РЕРАЙТА:
- Переписывай ТОЛЬКО письма, чей letter_index есть в issues критики. Все остальные письма возвращай ДОСЛОВНО — символ в символ, включая тему: никаких «заодно поправил».
- Каждый issue отмеченного письма закрывай по его полю fix; после переписи письмо обязано проходить ВЕСЬ регламент. Самопроверка обязательна: посчитай слова в теле (≤ 50, письмо 1 ≤ 45), {{var}} в теме и ровно один в теле, ровно один CTA (в письме 1 — гибридный вопрос с одним вопросительным знаком).
- Конструкция цепочки неизменна: то же количество писем, тот же порядок и те же роли писем в лесенке (письмо 1 — оффер и гибридный CTA, чистый реферальный вопрос — только в последнем). Ничего не добавляй, не удаляй и не меняй местами.
- Новые факты запрещены: используй только то, что уже есть во входных письмах и материалах задачи. Новые имена клиентов, кейсы, цифры и обещания выдумывать нельзя — если критик требует конкретики, которой нет во входе, переписывай безымянно.
- Конкретный кейс/название клиента — максимум в одном письме цепочки; при переписи не размазывай его на несколько писем.
- Углы писем не смешивай: переписанное письмо держит свой исходный угол, не тащи мысль соседнего письма.
- Формат операторов {{var}} не ломай: имена операторов сохраняй как есть, fallback-формулировки — в именительном падеже.
- Тон — человеческий диалог, не реклама; стоп-фразы и клише из регламента запрещены. Перечитай каждое переписанное письмо вслух: согласование падежей и родов должно быть идеальным.
- Если в материалах есть «ЭТАЛОН СТИЛЯ КЛИЕНТА» — переписанные письма подражают его манере, структуре фраз и тону (это важнее дефолтных правил тона), но регламент, запрет выдуманных имён и структура оффера неизменны.
- Если в материалах есть «ПРОВЕННЫЕ ПАТТЕРНЫ» — темы и хуки переписанных писем вдохновляй ими: адаптируй, не копируй дословно, проценты reply не цитируй.`;

const REWRITE_ACK: Record<HeChainLanguage, string> = {
  ru: 'Цепочка и критика в контексте. Переписываю только отмеченные письма, остальные возвращаю дословно.',
  en: 'The sequence and the critique are in context. Rewriting only the flagged emails, returning the rest verbatim.',
  pl: 'Sekwencja i krytyka są w kontekście. Przepisuję tylko oflagowane maile, resztę zwracam bez zmian.',
};

const REWRITE_TASK: Record<HeChainLanguage, string> = {
  ru: `Перепиши цепочку по критике выше: закрой каждый issue, не отмеченные письма верни дословно. Верни цепочку ЦЕЛИКОМ — все письма по порядку, и переписанные, и нетронутые. Сегментные варианты писем не трогаем — они восстанавливаются отдельно, их не выводи.

ФОРМАТ ВЫВОДА (ОБЯЗАТЕЛЕН — иначе ответ не пройдёт парсинг):
---LETTER 1---
Тема: <тема письма 1>

<тело письма 1>

---LETTER 2---
Тема: <тема письма 2>

<тело письма 2>

...и так далее до последнего письма. Никаких пояснений до/после блоков. Маркеры «---LETTER N---» и слово «Тема:» не меняй. Пиши на русском.`,
  en: `Rewrite the sequence per the critique above: close every issue, return unflagged emails verbatim. Return the WHOLE sequence — all emails in order, rewritten and untouched alike. Leave segment variants alone — they are restored separately; do not output them.

OUTPUT FORMAT (MANDATORY — otherwise the response will fail parsing):
---LETTER 1---
Subject: <subject of email 1>

<body of email 1>

---LETTER 2---
Subject: <subject of email 2>

<body of email 2>

...and so on through the last email. No explanations before/after the blocks. Keep the "---LETTER N---" markers and the word "Subject:" exactly as shown. Write in English.`,
  pl: `Przepisz sekwencję według krytyki powyżej: zamknij każdy issue, nieoflagowane maile zwróć dosłownie. Zwróć CAŁĄ sekwencję — wszystkie maile po kolei, i przepisane, i nietknięte. Wariantów segmentowych nie ruszamy — są odtwarzane osobno, nie wypisuj ich.

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
}): LLMMessage[] {
  const lang: HeChainLanguage = input.language === 'en' || input.language === 'pl' ? input.language : 'ru';
  const style = renderStyleExampleBlock(input.styleExample);
  const winners = renderWinnerPatternsBlock(input.winnerPatterns);

  const materials = `ВЕРТИКАЛЬ: ${input.verticalName}

${style}${winners}ИСХОДНАЯ ЦЕПОЧКА (${input.letters.length} писем, язык: ${LANG_NAMES[lang]}):
${renderLettersForReview(input.letters)}

КРИТИКА ЦЕПОЧКИ (вердикт и проблемы; переписываются ТОЛЬКО письма из issues):
${JSON.stringify(input.critique, null, 2)}`;

  return [
    { role: 'system', content: REWRITE_SYSTEM },
    { role: 'user', content: materials },
    { role: 'assistant', content: REWRITE_ACK[lang] },
    { role: 'user', content: REWRITE_TASK[lang] },
  ];
}
