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
 */

import type { LLMMessage } from '../llm';
import type { HeChainLanguage, HeEvidenceItem } from '../types';

export const CHAIN_REGULATIONS = `# Регламент аутрич-писем (жёсткие данные: 3.6 млн отправлений, 1700 кампаний, 2026)
- Тело < 50 слов — лучший reply (2.8% против 0.6% у 100–149 слов). Первое письмо — до 100 слов; фоллоу-апы 40–80 слов, каждое короче предыдущего; последнее — 2–4 коротких предложения.
- 1–3 предложения в теле отвечают лучше всего; 9–12 предложений режут reply втрое.
- Тема 3–4 слова — оптимум reply (1.8%); тема из 12+ слов убивает reply (−58%).
- Вопрос в теме даёт +54% reply. Персонализация {{var}} в теме — +117% reply, в теле — +44%. Но не более 1–2 разных {{var}} на письмо.
- Цифры в теле — МИНУС 63% reply; цифры в теме — минус 34%. Избегай чисел, процентов, сумм, «топ-5».
- Timeline-хуки («за 2 недели», «в N дней») — минус 29% reply. Не обещай сроков цифрами.
- CTA-вопрос «созвон на 15 минут?» — минус 37% reply. CTA — мягкий и человеческий: уточнить, к кому лучше обратиться; предложить прислать детали/пример.
- Цепочка 2–4 шага оптимальна; reply падает с каждым шагом (шаг 1 — 1.7%, шаг 5+ — 0.3%): самое сильное доказательство — в первое письмо.
- Одно письмо — одна мысль; каждое следующее — новый угол, а не «напоминаю о себе».
- Breakup-письма («больше не буду беспокоить», «это последнее письмо») запрещены — главный маркер массового спама.`;

export interface ChainPromptHypothesis {
  title: string;
  description: string;
  potential_pct: number;
  evidence: HeEvidenceItem[];
}

export interface ChainPromptInput {
  language: HeChainLanguage;
  verticalName: string;
  verticalSummary: string;
  synonyms: string[];
  /** Гипотезы вертикали с доказательствами (уже отсортированы по %). */
  hypotheses: ChainPromptHypothesis[];
  /** Текстовый снапшот брифа клиента (профиль сайта и т.п.). */
  briefText: string;
  /** Опционально: описание доступных операторов персонализации. */
  operatorsHint?: string;
}

/* ─────────────── Локализованные части задачи ─────────────── */

const PRIMER_ACK: Record<HeChainLanguage, string> = {
  ru: 'Материалы изучены: бриф, вертикаль, доказательства и регламент в контексте. Жду команду.',
  en: 'Materials reviewed: brief, vertical, evidence and regulations are in context. Awaiting your command.',
  pl: 'Materiały przeanalizowane: brief, pion, dowody i regulamin są w kontekście. Czekam na polecenie.',
};

const TASK_PROMPTS: Record<HeChainLanguage, string> = {
  ru: `Ты — senior email outreach специалист с опытом запуска 400+ холодных B2B-кампаний (средний reply rate 8–18%).

Напиши цепочку из 4 писем (допустимо 3–5) для холодной рассылки по вертикали, описанной в материалах выше.

Как использовать материалы:
- Вертикаль и её синонимы — это ЦА: пиши так, будто понимаешь их индустрию изнутри (их термины, их боли, их метрики).
- Гипотезы и доказательства — источник конкретики: рыночные факты, чужие кейсы, регуляторные драйверы. Опирайся на них, но НЕ цитируй URL в письмах и не грузи цифрами (см. регламент).
- Бриф клиента — оффер и УТП. Одно письмо — одна мысль/одно УТП, распредели их по цепочке.
- Первое письмо — самое сильное: лучший угол + лучшее доказательство. Фоллоу-апы — новые углы, а не «пинг».
${'{{OPERATORS_HINT}}'}
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
- The hypotheses and evidence are your source of specifics: market facts, third-party cases, regulatory drivers. Rely on them, but do NOT cite URLs in the emails and do not overload them with numbers (see the regulations).
- The client brief is the offer and USPs. One email — one idea/one USP; spread them across the sequence.
- The first email is the strongest: best angle + best proof. Follow-ups bring new angles, not "just bumping this".
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
- Hipotezy i dowody to źródło konkretów: fakty rynkowe, case studies, czynniki regulacyjne. Opieraj się na nich, ale NIE cytuj URL-i w mailach i nie przeciążaj liczbami (patrz regulamin).
- Brief klienta to oferta i USP. Jeden mail — jedna myśl/jeden USP; rozłóż je na całą sekwencję.
- Pierwszy mail jest najsilniejszy: najlepszy kąt + najlepszy dowód. Follow-upy wnoszą nowe kąty, nie "przypominam o sobie".
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

const SYSTEM = `Ты пишешь холодные B2B-цепочки для агентства Polza. Ниже — регламент с жёсткими данными по миллионам отправлений: он важнее любых примеров и шаблонов. Соблюдай его всегда.

${CHAIN_REGULATIONS}`;

function renderHypotheses(hypotheses: ChainPromptHypothesis[]): string {
  return hypotheses
    .map((h) => {
      const ev = h.evidence
        .slice(0, 3)
        .map((e) => `    • ${e.claim} — «${e.quote}»`)
        .join('\n');
      return `- [${h.potential_pct}%] ${h.title}\n  ${h.description}${ev ? `\n  Доказательства:\n${ev}` : ''}`;
    })
    .join('\n');
}

/** Материалы (бриф + вертикаль + доказательства) — единым user-сообщением. */
export function buildChainMaterialsMessage(input: ChainPromptInput): string {
  const operators = input.operatorsHint?.trim()
    ? `ДОСТУПНЫЕ ОПЕРАТОРЫ ПЕРСОНАЛИЗАЦИИ:\n${input.operatorsHint.trim()}\n`
    : '';

  return `Глубоко изучи материалы ниже — на их основе тебе дадут задачу написать цепочку писем.

БРИФ КЛИЕНТА:
"""
${input.briefText}
"""

ВЕРТИКАЛЬ: ${input.verticalName}
${input.verticalSummary}
Синонимы вертикали (как ещё называют этот сегмент): ${input.synonyms.join(', ') || '—'}

ГИПОТЕЗЫ ВЕРТИКАЛИ С ДОКАЗАТЕЛЬСТВАМИ:
${renderHypotheses(input.hypotheses)}

${operators}Держи всё это в контексте.`;
}

/**
 * Полная цепочка сообщений: system (регламент) → user (материалы) →
 * assistant (праймер-ack) → user (задача на целевом языке).
 */
export function buildChainMessages(input: ChainPromptInput): LLMMessage[] {
  const lang: HeChainLanguage = input.language === 'en' || input.language === 'pl' ? input.language : 'ru';
  const operatorsHint = input.operatorsHint?.trim()
    ? (lang === 'ru'
        ? '- Операторы персонализации из материалов вставляй там, где уместно (не более 1–2 разных на письмо).'
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
