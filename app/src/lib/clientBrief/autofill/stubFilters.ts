/**
 * Stub-фильтры для текстовых полей брифа.
 *
 * Цель: ловить "отписки" типа "Раздел 'Кейсы' на сайте, упомянуто 85+ проектов"
 * которые AI пишет, когда не смог достать реальное содержимое страницы.
 * Такие тексты бесполезны для downstream-инструментов (Оценка ЦА, гипотезы).
 *
 * История: с 2026-05-20 stub-фильтры были в каждом enricher-parser отдельно,
 * но паттерны были недостаточно широкие — "Раздел X на сайте" проходило
 * мимо, потому что паттерн ждал "есть раздел", а не "Раздел". Этот модуль
 * выносит фильтрацию в одно место с более жёсткими дефолтами, и
 * применяет её ТАКЖЕ в main flow (mapAutofillToBriefPatch) — раньше main AI
 * мог записать мусор напрямую в social_proof.X.comment.
 */

/** Подстроки, по которым опознаём типовые "отписки". */
const GENERIC_STUB_PATTERNS: readonly RegExp[] = [
  // "Раздел 'X' на сайте", "Раздел 'X' с упоминаниями"
  /^\s*раздел\s+[«'"„]/i,
  /^\s*раздел\s+[А-Яа-яA-Za-z]+\s+(на\s+сайте|со\s+|с\s+)/i,
  // "Упоминание X на сайте", "Упоминание 'Y'"
  /^\s*упоминан[а-я]*\s+[«'"„]/i,
  /^\s*упоминан[а-я]*\s+\S+\s+(на\s+сайте|и\s+)/i,
  // "Есть X на сайте", "Имеются Y"
  /^\s*есть\s+(раздел|кейс|портфолио|отзыв|наград|сертификат|упоминан|видео|подкаст|faq|вопрос)/i,
  /^\s*имеются\s+(кейс|отзыв|наград|упоминан)/i,
  // "X есть на сайте / в разделе / в портфолио"
  /\b(кейсы|отзывы|награды|сертификаты|видео|подкасты|упоминания|публикации|выступления|презентации|faq)\s+есть\s+(на\s+сайте|в\s+портфолио|в\s+разделе)/i,
  // "FAQ есть на сайте..." — отдельно, потому что выше требует \b до 'кейсы'
  /\bfaq\s+есть\s+на\s+сайте/i,
  // "85+ проектов", "100 кейсов" (только число + сущность, без описания)
  /^\s*\d+\+?\s*(кейс|проект|отзыв|клиент|наград)/i,
  // "См. на сайте", "Подробнее в разделе", "Смотрите в портфолио"
  /\bсм\.\s*(сайт|раздел|портфолио)/i,
  /\bподробнее\s+(на\s+сайте|в\s+разделе|в\s+портфолио)/i,
  /\bсмотрите?\s+(на\s+сайте|в\s+портфолио|в\s+разделе)/i,
  // "Информация о X есть/имеется"
  /\bинформация\s+о\s+\S+\s+(есть|имеется)/i,
  // "На сайте представлены X", "На сайте указаны Y"
  /^\s*на\s+сайте\s+(представлен|указан|есть|имеются)/i,
  // "Положительные отзывы", "Хорошие оценки", "Множество наград", "Высокие оценки"
  /^\s*(положительные|много|множество|немало|хорошие|высокие)\s+(отзыв|оценк|наград|кейс)/i,
  // "Пишут о нас в крупных изданиях" — лезет даже с годом
  /^\s*пишут\s+о\s+нас/i,
];

/** Категория-специфичные паттерны: для рейтингов нужно ЧИСЛО, для рекомендаций КАВЫЧКА и т.д. */
export type StubFilterCategory =
  | 'cases'
  | 'ratings'
  | 'recommendations'
  | 'press'
  | 'awards'
  | 'media'
  | 'common_questions'
  | 'client_problems';

interface CategoryRule {
  /** Минимальная длина если структурных маркеров нет. */
  minLengthWithoutMarkers?: number;
  /** Какие структурные маркеры считаем "содержательностью". */
  contentMarkers?: RegExp[];
  /** Дополнительные паттерны категории, по которым drop. */
  extraStubPatterns?: RegExp[];
  /** Если задано — текст ОБЯЗАН содержать хотя бы один из этих паттернов. */
  requiredPatterns?: RegExp[];
}

const CATEGORY_RULES: Record<StubFilterCategory, CategoryRule> = {
  cases: {
    // Любая цифра ИЛИ тире — считаем что есть конкретика. Чистые отписки
    // ("85+ проектов") уже отсеяны через GENERIC_STUB_PATTERNS.
    minLengthWithoutMarkers: 60,
    contentMarkers: [/[—–]/, /\d/, /\bROI\b/i, /\bx\s*\d/i],
  },
  ratings: {
    // Рейтинг должен содержать хоть какое-то число (балл, позицию, год,
    // количество отзывов). Если цифр нет — это почти всегда отписка
    // ("положительные отзывы", "высокие оценки"), и она уже ловится
    // через GENERIC_STUB_PATTERNS. Лояльно к форматам:
    //   - 4.8/5
    //   - 87%
    //   - TOP-20 Tagline 2025
    //   - 5 звёзд от 124 клиентов
    requiredPatterns: [/\d/],
  },
  recommendations: {
    // Рекомендация ДОЛЖНА содержать кавычку (цитата) или двоеточие с большой буквой (автор)
    requiredPatterns: [/[«»"„""]/, /:\s*[«"]/, /,\s*(CEO|CTO|CMO|директор|основател|руководител)/i],
  },
  press: {
    // Упоминание в СМИ должно содержать год/дату
    requiredPatterns: [/\b(19|20)\d{2}\b/, /(январ|феврал|март|апрел|май|июн|июл|август|сентябр|октябр|ноябр|декабр)/i],
  },
  awards: {
    // Награда — год или конкретное название с тире/двоеточием
    contentMarkers: [/\b(19|20)\d{2}\b/, /[—–:]/],
    minLengthWithoutMarkers: 60,
  },
  media: {
    // Видео/подкаст — платформа + дата ИЛИ название с двоеточием
    contentMarkers: [/[—–:(]/, /\b(19|20)\d{2}\b/],
    minLengthWithoutMarkers: 60,
  },
  common_questions: {
    // Q/A формат или несколько вопросительных знаков.
    // ВНИМАНИЕ: \b не работает с кириллическим "В", поэтому используем
    // multiline anchor (^ в режиме m) — "В:" в начале строки.
    requiredPatterns: [/^\s*В:\s/mu, /^\s*Q:\s/m, /\?[\s\S]*?\?/],
  },
  client_problems: {
    // Достаточно либо 2+ строк, либо >=40 символов с маркером структуры.
    minLengthWithoutMarkers: 40,
    contentMarkers: [/\n/, /[—–:]/],
  },
};

export interface StubFilterResult {
  /** true если текст распознан как stub и должен быть отброшен. */
  isStub: boolean;
  /** Какое правило сработало (для логов/debug). */
  reason?:
    | 'empty'
    | 'generic_pattern'
    | 'category_pattern'
    | 'missing_required_marker'
    | 'too_short_without_markers';
}

/**
 * Проверяет, является ли text "отпиской".
 *
 * Принципы:
 * 1. Пустая строка → stub.
 * 2. Любая строка матчит GENERIC_STUB_PATTERNS → stub.
 * 3. Любая строка матчит category extraStubPatterns → stub.
 * 4. Если требуются requiredPatterns — текст ДОЛЖЕН содержать хотя бы один.
 * 5. Если есть contentMarkers — наличие хотя бы одного маркера ИЛИ длина
 *    выше minLengthWithoutMarkers → ок. Иначе → stub.
 */
export function detectStub(text: unknown, category: StubFilterCategory): StubFilterResult {
  if (typeof text !== 'string') return { isStub: true, reason: 'empty' };
  const trimmed = text.trim();
  if (!trimmed) return { isStub: true, reason: 'empty' };

  const lines = trimmed.split('\n').map((l) => l.trim()).filter(Boolean);

  // 2. Generic stubs.
  for (const line of lines) {
    if (GENERIC_STUB_PATTERNS.some((re) => re.test(line))) {
      return { isStub: true, reason: 'generic_pattern' };
    }
  }

  const rule = CATEGORY_RULES[category];

  // 3. Category-specific stubs.
  if (rule.extraStubPatterns) {
    for (const line of lines) {
      if (rule.extraStubPatterns.some((re) => re.test(line))) {
        return { isStub: true, reason: 'category_pattern' };
      }
    }
  }

  // 4. Required patterns (must contain at least one).
  if (rule.requiredPatterns) {
    if (!rule.requiredPatterns.some((re) => re.test(trimmed))) {
      return { isStub: true, reason: 'missing_required_marker' };
    }
  }

  // 5. Length vs content markers.
  if (rule.minLengthWithoutMarkers !== undefined) {
    const hasMarker = rule.contentMarkers
      ? rule.contentMarkers.some((re) => re.test(trimmed))
      : false;
    if (!hasMarker && trimmed.length < rule.minLengthWithoutMarkers) {
      return { isStub: true, reason: 'too_short_without_markers' };
    }
  }

  return { isStub: false };
}

/** Convenience: вернуть text если не stub, иначе пустую строку. */
export function dropIfStub(text: unknown, category: StubFilterCategory): string {
  if (typeof text !== 'string') return '';
  return detectStub(text, category).isStub ? '' : text;
}
