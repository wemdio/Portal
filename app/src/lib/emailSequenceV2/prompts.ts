/**
 * Промпты для инструмента «Цепочки писем 2.0».
 *
 * Под каждый язык вывода (русский / английский / польский) — отдельный
 * полный промпт, написанный НА этом языке. Промпт на целевом языке
 * надёжнее «якорит» язык ответа модели, чем директива внутри чужого текста.
 *
 * Входные данные (бриф, сегмент, правки, примеры) могут быть на любом
 * языке — в каждом промпте явно сказано отвечать на нужном языке.
 *
 * ВАЖНО: служебные маркеры формата `---LETTER N---` одинаковы во всех
 * языках, а слово темы письма («Тема:» / «Subject:» / «Temat:») —
 * локализовано; парсер letterParser.ts понимает все три варианта.
 */

import type { EmailSequenceV2OutputLanguage } from '@/types';

/** Приводит произвольное значение к поддерживаемому языку (фолбэк — русский). */
export function normalizeOutputLanguage(value: unknown): EmailSequenceV2OutputLanguage {
  return value === 'en' || value === 'pl' ? value : 'ru';
}

/* ───────────────────────── Этап 1: извлечение ценностей ───────────────────────── */

const EXTRACT_VALUES_PROMPTS: Record<EmailSequenceV2OutputLanguage, string> = {
  ru: `Проанализируй бриф в документе и извлеки ключевые ценности продукта, его уникальные торговые предложения (УТП), преимущества, технические характеристики, доступные акции или бонусы, а также социальные доказательства (например, видеоотзывы, видео о продукте, упоминания в СМИ, кейсы, достижения и тд.). Для каждой ценности перечисли её описание, важные детали и, если необходимо, упомяни контекст или дополнительные сведения. Бриф может быть на любом языке — всё равно отвечай на русском.

ФОРМАТ ВЫВОДА:
В первой строке: "Ценности [название компании]" (название из брифа).
Затем структурированный список разделов с маркерами и подпунктами. Используй разделы:

1. Уникальные торговые предложения (УТП).
2. Преимущества продукта/услуги.
3. Технические характеристики (если применимо).
4. Акции и бонусы (если есть).
5. Социальные доказательства (отзывы, кейсы, упоминания в СМИ, регалии, награды).
6. Дополнительный контекст и нюансы.

Для каждого пункта — короткое описание + важные детали. Без воды, конкретно. Отвечай на русском.`,

  en: `Analyze the brief in the document and extract the product's key values: its unique selling propositions (USPs), benefits, technical specifications, available promotions or bonuses, and social proof (e.g. video testimonials, product videos, media mentions, case studies, achievements, etc.). For each value, list its description, important details and, if needed, mention context or additional information. The brief may be in any language — always respond in English.

OUTPUT FORMAT:
First line: "Values [company name]" (company name taken from the brief).
Then a structured list of sections with bullets and sub-items. Use these sections:

1. Unique selling propositions (USPs).
2. Product/service benefits.
3. Technical specifications (if applicable).
4. Promotions and bonuses (if any).
5. Social proof (testimonials, case studies, media mentions, credentials, awards).
6. Additional context and nuances.

For each item — a short description + key details. No fluff, be specific. Respond in English.`,

  pl: `Przeanalizuj brief w dokumencie i wyodrębnij kluczowe wartości produktu: jego unikalne propozycje sprzedaży (USP), korzyści, specyfikacje techniczne, dostępne promocje lub bonusy, a także dowody społeczne (np. wideorecenzje, filmy o produkcie, wzmianki w mediach, case studies, osiągnięcia itp.). Dla każdej wartości podaj jej opis, ważne szczegóły oraz, w razie potrzeby, kontekst lub dodatkowe informacje. Brief może być w dowolnym języku — zawsze odpowiadaj po polsku.

FORMAT ODPOWIEDZI:
W pierwszym wierszu: "Wartości [nazwa firmy]" (nazwa z briefu).
Następnie uporządkowana lista sekcji z punktami i podpunktami. Użyj sekcji:

1. Unikalne propozycje sprzedaży (USP).
2. Korzyści produktu/usługi.
3. Specyfikacje techniczne (jeśli dotyczy).
4. Promocje i bonusy (jeśli są).
5. Dowody społeczne (opinie, case studies, wzmianki w mediach, referencje, nagrody).
6. Dodatkowy kontekst i niuanse.

Dla każdego punktu — krótki opis + kluczowe szczegóły. Bez lania wody, konkretnie. Odpowiadaj po polsku.`,
};

/** Промпт извлечения ценностей (этап 1) на выбранном языке. */
export function getExtractValuesPrompt(lang: EmailSequenceV2OutputLanguage): string {
  return EXTRACT_VALUES_PROMPTS[lang] ?? EXTRACT_VALUES_PROMPTS.ru;
}

/* ───────────────── Этап 2: «разогрев» модели перед генерацией ───────────────── */

const PRIMER_PROMPTS: Record<EmailSequenceV2OutputLanguage, string> = {
  ru: `Перед тем как я дам тебе задачу, глубоко проанализируй входящие данные.
В последующей работе ты будешь опираться на полученную из них информацию.

Тебе передан полный набор материалов в одном сообщении:
1) Бриф клиента и Ценности (этап 1).
2) Сегмент базы по гипотезе и правки заказчика.
3) Регламент написания цепочек и шаблон структуры писем outreach.
4) Примеры рабочих цепочек для понимания глубины и смыслов писем.
5) Операторы для персонализации (опционально).

Часть материалов может быть на другом языке. Изучи каждый блок и удерживай его в контексте.`,

  en: `Before I give you the task, deeply analyze the incoming data.
In the work that follows you will rely on the information obtained from it.

You have been given a full set of materials in a single message:
1) The client brief and Values (stage 1).
2) The database segment by hypothesis and the customer's edits.
3) Email sequence guidelines and the outreach email structure template.
4) Examples of working sequences to understand the depth and meaning of the emails.
5) Personalization operators (optional).

Some of the materials may be in another language. Study each block and keep it in context.`,

  pl: `Zanim przekażę Ci zadanie, dogłębnie przeanalizuj dane wejściowe.
W dalszej pracy będziesz opierać się na informacjach z nich uzyskanych.

Otrzymujesz pełny zestaw materiałów w jednej wiadomości:
1) Brief klienta i Wartości (etap 1).
2) Segment bazy według hipotezy oraz uwagi klienta.
3) Regulamin tworzenia sekwencji i szablon struktury maili outreach.
4) Przykłady działających sekwencji, aby zrozumieć głębię i sens maili.
5) Operatory personalizacji (opcjonalnie).

Część materiałów może być w innym języku. Przeanalizuj każdy blok i utrzymuj go w kontekście.`,
};

/** Промпт-«разогрев» (этап 2) на выбранном языке. */
export function getPrimerPrompt(lang: EmailSequenceV2OutputLanguage): string {
  return PRIMER_PROMPTS[lang] ?? PRIMER_PROMPTS.ru;
}

/* ───────────────────── Этап 3: генерация цепочки писем ───────────────────── */

const TASK_PROMPTS: Record<EmailSequenceV2OutputLanguage, string> = {
  ru: `Ты — senior email outreach специалист с опытом запуска более 400 успешных холодных рассылок в B2B (средний reply rate 8–18%).

Тебе нужно создать цепочку из 3–5 писем для холодной/тёплой рассылки, которая максимально соответствует вводным данным.

Входящие материалы (используй их все):

1. Бриф от клиента и сгенерированные ценности.

2. Конкретный сегмент базы, чтобы персонализировать цепочку под нужную ЦА + УТП (преимущества, выгоды, social proofs и тд) и правки в тз от заказчика.

3. Регламент написания цепочек + структура писем (шаблон) в outreach. Изучи регламент и пойми логику outreach рассылок. Изучи структуру писем и пойми как нужно составлять письма, чтобы наполнить их смыслами, проанализируй как меняется текст в зависимости от глубины письма (второе, третье, последнее и тд.), шаблон — лишь твой вспомогательный инструмент, меняй структуру в зависимости от контекста.

4. Примеры работающих цепочек (проанализируй, пойми структуру и о чём мы пишем на втором, третьем и последующих письмах, проанализируй цели и смыслы, как меняются смыслы в зависимости от глубины письма).

5. Операторы для персонализации определяют границы адаптивности и индивидуальности каждого письма. Используй их уместно, чтобы персонализировать письмо. Если операторы не переданы — пиши без подстановок.

Задача: Создай последовательную цепочку из 4 писем (можно 3 или 5, если это логично и лучше). Если регламент или примеры предполагают больше писем — приоритет у этого задания.

ЯЗЫК: пиши всю цепочку строго на русском, даже если бриф, сегмент, правки и примеры поданы на другом языке. Передавай смысл, а не делай дословный перевод. Бренды, имена собственные и устоявшиеся технические термины можно оставлять в оригинале.

ФОРМАТ ВЫВОДА (ОБЯЗАТЕЛЕН — иначе ответ не пройдёт парсинг):
Каждое письмо отдельным блоком, разделители — строки вида:

---LETTER 1---
Тема: <тема письма 1>

<тело письма 1>

---LETTER 2---
Тема: <тема письма 2>

<тело письма 2>

... и так далее до последнего письма.

ТРЕБОВАНИЯ:
- Никаких пояснений до или после блоков. Только блоки писем.
- Каждое письмо начинается с "Тема: ..." сразу после маркера.
- Служебные маркеры формата (строки вида «---LETTER N---» и слово «Тема:») пиши именно так и не меняй их — на русский переводи только сам текст темы и тела письма.
- Тело письма — простым разговорным языком, короткими абзацами.
- ОБЪЁМ (жёсткий лимит, важнее примеров, шаблона и регламента): первое письмо — не длиннее 100 слов; каждый промежуточный фоллоу-ап (все письма между первым и последним) — 40–80 слов и короче предыдущего; последнее письмо — 2–4 коротких предложения. Если примеры или регламент в материалах длиннее — всё равно соблюдай этот лимит.
- Одно письмо — одна ключевая мысль. Не перечисляй все УТП и преимущества в одном письме — распределяй их по цепочке.
- ЗАПРЕЩЕНЫ «прощальные»/breakup-письма. НИ ОДНО письмо (включая последнее) не должно: объявлять, что оно последнее; просить ответить «не нужно»/«не актуально»/«не интересно»; обещать «больше не буду беспокоить/отвлекать/писать»; извиняться за беспокойство; упоминать отписку. Это главный маркер массовой спам-рассылки — он мгновенно убивает доверие, даже если сами примеры/регламент так делают. Последнее письмо — это ещё один короткий полезный заход с НОВЫМ углом или ценностью и мягким живым CTA, как в настоящей 1:1-переписке между людьми (можно спросить, к кому лучше адресовать вопрос, или предложить конкретный следующий шаг).
- Если в данных были операторы персонализации (например, {{firstName}}, {{companyName}}), вставляй их там, где уместно.

Приступай к выполнению.`,

  en: `You are a senior email outreach specialist with experience launching over 400 successful cold B2B campaigns (average reply rate 8–18%).

You need to create a sequence of 3–5 emails for a cold/warm campaign that best matches the input data.

Input materials (use all of them):

1. The client's brief and the generated values.

2. A specific database segment, to personalize the sequence for the target audience + USPs (benefits, advantages, social proof, etc.) and the customer's edits to the spec.

3. Email sequence guidelines + the outreach email structure (template). Study the guidelines and understand the logic of outreach campaigns. Study the email structure and understand how to build emails so they are filled with meaning; analyze how the text changes depending on the email's depth (second, third, last, etc.) — the template is only a supporting tool, change the structure depending on context.

4. Examples of working sequences (analyze them, understand the structure and what we write about in the second, third and following emails; analyze the goals and meanings, and how meaning changes depending on the email's depth).

5. Personalization operators define the boundaries of each email's adaptivity and individuality. Use them appropriately to personalize the email. If no operators are provided — write without substitutions.

Task: Create a coherent sequence of 4 emails (3 or 5 is fine if it is more logical and works better). If the guidelines or examples imply more emails — this task takes priority.

LANGUAGE: write the entire sequence strictly in English, even if the brief, segment, edits and examples are provided in another language. Convey the meaning, do not translate word for word. Brands, proper names and established technical terms may be kept in the original.

OUTPUT FORMAT (MANDATORY — otherwise the response will fail parsing):
Each email as a separate block, separated by lines of the form:

---LETTER 1---
Subject: <subject of email 1>

<body of email 1>

---LETTER 2---
Subject: <subject of email 2>

<body of email 2>

... and so on through the last email.

REQUIREMENTS:
- No explanations before or after the blocks. Only the email blocks.
- Each email starts with "Subject: ..." right after the marker.
- Write the format markers (lines like "---LETTER N---" and the word "Subject:") exactly like that and do NOT change them — translate into English only the actual subject and body text.
- The email body — in plain conversational language, with short paragraphs.
- LENGTH (hard limit, takes priority over the examples, the template and the guidelines): the first email — no longer than 100 words; each intermediate follow-up (every email between the first and the last) — 40–80 words and shorter than the previous one; the last email — 2–4 short sentences. Even if the provided examples or guidelines are longer, obey this limit.
- One email — one key idea. Do not list every USP and benefit in a single email — spread them across the sequence.
- NO "breakup"/goodbye emails. NO email (including the last one) may: announce that it is the last; ask the recipient to reply "not interested"/"no need"; promise to "stop bothering/writing"; apologize for bothering them; mention unsubscribing. This is the number-one signal of mass spam and instantly destroys trust — even if the examples or guidelines do it. The last email is just one more short, useful touch with a NEW angle or value and a soft, human CTA, like real 1:1 correspondence between people (e.g. ask who is the right person to address, or propose a concrete next step).
- If personalization operators were provided in the data (e.g. {{firstName}}, {{companyName}}), insert them where appropriate.

Get started.`,

  pl: `Jesteś starszym specjalistą ds. email outreach z doświadczeniem w uruchomieniu ponad 400 udanych zimnych kampanii B2B (średni reply rate 8–18%).

Musisz stworzyć sekwencję 3–5 maili do zimnej/ciepłej kampanii, która maksymalnie odpowiada danym wejściowym.

Materiały wejściowe (wykorzystaj je wszystkie):

1. Brief od klienta i wygenerowane wartości.

2. Konkretny segment bazy, aby spersonalizować sekwencję pod właściwą grupę docelową + USP (korzyści, zalety, social proof itp.) oraz uwagi do specyfikacji od klienta.

3. Regulamin tworzenia sekwencji + struktura maili (szablon) w outreach. Przeanalizuj regulamin i zrozum logikę kampanii outreach. Przeanalizuj strukturę maili i zrozum, jak tworzyć maile, by wypełnić je sensem; przeanalizuj, jak zmienia się tekst w zależności od głębokości maila (drugi, trzeci, ostatni itp.) — szablon to tylko narzędzie pomocnicze, zmieniaj strukturę zależnie od kontekstu.

4. Przykłady działających sekwencji (przeanalizuj je, zrozum strukturę i o czym piszemy w drugim, trzecim i kolejnych mailach; przeanalizuj cele i sensy oraz to, jak zmienia się sens zależnie od głębokości maila).

5. Operatory personalizacji określają granice adaptacyjności i indywidualności każdego maila. Używaj ich odpowiednio, aby spersonalizować maila. Jeśli operatory nie zostały przekazane — pisz bez podstawień.

Zadanie: Stwórz spójną sekwencję 4 maili (3 lub 5 jest w porządku, jeśli to bardziej logiczne i działa lepiej). Jeśli regulamin lub przykłady zakładają więcej maili — priorytet ma to zadanie.

JĘZYK: napisz całą sekwencję wyłącznie po polsku, nawet jeśli brief, segment, uwagi i przykłady są w innym języku. Przekazuj sens, nie tłumacz słowo w słowo. Marki, nazwy własne i utrwalone terminy techniczne można zostawić w oryginale.

FORMAT ODPOWIEDZI (OBOWIĄZKOWY — w przeciwnym razie odpowiedź nie przejdzie parsowania):
Każdy mail jako osobny blok, oddzielony wierszami w formie:

---LETTER 1---
Temat: <temat maila 1>

<treść maila 1>

---LETTER 2---
Temat: <temat maila 2>

<treść maila 2>

... i tak dalej aż do ostatniego maila.

WYMAGANIA:
- Żadnych wyjaśnień przed ani po blokach. Tylko bloki maili.
- Każdy mail zaczyna się od "Temat: ..." zaraz po znaczniku.
- Znaczniki formatu (wiersze typu "---LETTER N---" i słowo "Temat:") pisz dokładnie tak i NIE zmieniaj ich — na polski tłumacz tylko właściwy temat i treść maila.
- Treść maila — prostym, konwersacyjnym językiem, krótkimi akapitami.
- OBJĘTOŚĆ (twardy limit, ważniejszy niż przykłady, szablon i regulamin): pierwszy mail — nie dłuższy niż 100 słów; każdy pośredni follow-up (wszystkie maile między pierwszym a ostatnim) — 40–80 słów i krótszy od poprzedniego; ostatni mail — 2–4 krótkie zdania. Nawet jeśli przykłady lub regulamin w materiałach są dłuższe — przestrzegaj tego limitu.
- Jeden mail — jedna kluczowa myśl. Nie wymieniaj wszystkich USP i korzyści w jednym mailu — rozłóż je na całą sekwencję.
- Jeśli w danych były operatory personalizacji (np. {{firstName}}, {{companyName}}), wstawiaj je tam, gdzie to odpowiednie.

Przystąp do wykonania.`,
};

/** Промпт основной задачи (этап 3) на выбранном языке. */
export function getTaskPrompt(lang: EmailSequenceV2OutputLanguage): string {
  return TASK_PROMPTS[lang] ?? TASK_PROMPTS.ru;
}

/**
 * Фейковая «реплика ассистента» между разогревом и задачей.
 * Тоже локализуем, чтобы не подмешивать модели чужой язык.
 */
const PRIMER_ACK: Record<EmailSequenceV2OutputLanguage, string> = {
  ru: 'Входящие данные обработаны. Жду команду.',
  en: 'The incoming data has been processed. Awaiting your command.',
  pl: 'Dane wejściowe zostały przetworzone. Czekam na polecenie.',
};

/** Реплика-подтверждение модели после «разогрева» — на выбранном языке. */
export function getPrimerAck(lang: EmailSequenceV2OutputLanguage): string {
  return PRIMER_ACK[lang] ?? PRIMER_ACK.ru;
}
