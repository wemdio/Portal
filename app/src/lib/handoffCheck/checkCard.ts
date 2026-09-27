/**
 * Проверки карточки AMO при передаче проекта (спека
 * `docs/superpowers/specs/2026-09-25-handoff-card-check-design.md`, §5). Чистая
 * функция без I/O — данные сделки уже прочитаны (`amoApi.ts`), дубли ИНН уже
 * найдены (`handoff_inn_duplicates`).
 */
import { normalizeInn } from '@/lib/firstSales/money';

export interface CardData {
  found: boolean;
  pipelineId: number | null;
  statusId: number | null;
  statusName: string | null; // из amo_statuses, для текста
  pipelineName: string | null;
  price: number | null; // бюджет AMO
  responsibleUserId: number | null;
  inn: string | null; // сырое значение поля «ИНН»
  source: string | null; // значение поля «Источник»
  innDuplicates: Array<{ amoId: number; name: string | null }>;
}

export type ProblemCode =
  | 'NOT_FOUND'
  | 'WRONG_PIPELINE'
  | 'NOT_WON'
  | 'NO_INN'
  | 'BAD_INN'
  | 'INN_DUPLICATE'
  | 'NO_SOURCE'
  | 'SOURCE_MISMATCH'
  | 'NO_BUDGET'
  | 'BUDGET_MISMATCH'
  | 'NO_RESPONSIBLE'
  // Не порождается checkCard(): AMO был недоступен при чтении сделки (см. Task 5
  // воркера). Заводится отдельно и никогда не уходит в чат — только в таблицу.
  | 'AMO_UNAVAILABLE';

export interface Problem {
  code: ProblemCode;
  text: string;
}

/** Статус «Успешно реализовано» первичной воронки. */
const WON_STATUS_ID = 142;

// Словарь синонимов «Откуда лид» → каноническое значение поля «Источник» AMO.
// Синонимы короче остальных («email», «почта») намеренно исключены — они
// перехватывали бы «Email-рассылку» и другие каналы и давали ложные совпадения.
const SOURCE_SYNONYMS: Array<{ canonical: string; synonyms: string[] }> = [
  { canonical: 'Сайт', synonyms: ['сайт', 'заявкассайта', 'форма'] },
  { canonical: 'Лидскан', synonyms: ['лидскан', 'leadscan'] },
  { canonical: 'Партнер', synonyms: ['партнер'] },
  { canonical: 'Email Outreach', synonyms: ['emailoutreach', 'имейлаутрич', 'emailаутрич'] },
  { canonical: 'Email-рассылка', synonyms: ['рассылк'] },
  { canonical: 'Telegram Outreach', synonyms: ['telegramoutreach', 'tgoutreach', 'тгаутрич'] },
  { canonical: 'Аутрич', synonyms: ['аутрич', 'outreach'] },
  { canonical: 'Сарафан', synonyms: ['сарафан', 'рекомендац'] },
  { canonical: 'Конференция', synonyms: ['конференц', 'выставк'] },
  { canonical: 'SEO', synonyms: ['seo', 'сео'] },
  { canonical: 'Meta Ads', synonyms: ['meta', 'facebook', 'инстаграмреклам'] },
  { canonical: 'Яндекс Директ', synonyms: ['директ', 'direct'] },
];

/** Нижний регистр, ё→е, без пробелов/дефисов/пунктуации — для сравнения «Откуда лид» со словарём. */
function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]/g, '');
}

/**
 * «Откуда лид» → каноническое значение «Источник», если синоним уверенно
 * распознан; иначе null. Среди всех канонических значений, чей синоним
 * встретился подстрокой в тексте, побеждает тот, у кого совпавший синоним
 * длиннее — короткое совпадение реже случайно и увереннее указывает на канал.
 * Ничья по длине между разными каноническими значениями — расхождение не
 * проверяем (`null`), чтобы не спутать один канал с другим.
 */
export function canonicalSource(statedSource: string | null): string | null {
  if (!statedSource) return null;
  const normalized = normalizeForMatch(statedSource);
  if (!normalized) return null;

  let best: { canonical: string; length: number } | null = null;
  let tie = false;

  for (const { canonical, synonyms } of SOURCE_SYNONYMS) {
    let longestMatch = 0;
    for (const synonym of synonyms) {
      const normalizedSynonym = normalizeForMatch(synonym);
      if (normalizedSynonym && normalized.includes(normalizedSynonym)) {
        longestMatch = Math.max(longestMatch, normalizedSynonym.length);
      }
    }
    if (longestMatch === 0) continue;

    if (!best || longestMatch > best.length) {
      best = { canonical, length: longestMatch };
      tie = false;
    } else if (longestMatch === best.length && canonical !== best.canonical) {
      tie = true;
    }
  }

  return best && !tie ? best.canonical : null;
}

function formatRub(amount: number): string {
  return `${amount.toLocaleString('ru-RU')} ₽`;
}

export function checkCard(
  card: CardData,
  stated: { amount: number | null; source: string | null },
  firstSalesPipelineId: number,
): Problem[] {
  if (!card.found) {
    return [{ code: 'NOT_FOUND', text: 'сделка не найдена в AMO' }];
  }

  const problems: Problem[] = [];

  if (card.pipelineId !== firstSalesPipelineId) {
    const pipelineLabel = card.pipelineName ? `«${card.pipelineName}»` : String(card.pipelineId ?? '—');
    problems.push({
      code: 'WRONG_PIPELINE',
      text: `сделка не в воронке первичных продаж (сейчас: ${pipelineLabel})`,
    });
  } else if (card.statusId !== WON_STATUS_ID) {
    const statusLabel = card.statusName ? `«${card.statusName}»` : String(card.statusId ?? '—');
    problems.push({
      code: 'NOT_WON',
      text: `сделка на этапе ${statusLabel}, а не «Успешно реализовано» — продажа не засчитается`,
    });
  }

  const normalizedInn = normalizeInn(card.inn);
  if (!card.inn) {
    problems.push({ code: 'NO_INN', text: 'нет ИНН' });
  } else if (!normalizedInn) {
    problems.push({ code: 'BAD_INN', text: `ИНН «${card.inn}» не похож на настоящий (не 10 и не 12 цифр)` });
  } else if (card.innDuplicates.length > 0) {
    const ids = card.innDuplicates.map((duplicate) => duplicate.amoId).join(', ');
    problems.push({
      code: 'INN_DUPLICATE',
      text: `тот же ИНН уже есть у другой сделки первички (${ids}) — платёж станет «спорным» и не засчитается ни одной`,
    });
  }

  if (!card.source) {
    problems.push({ code: 'NO_SOURCE', text: 'не заполнен «Источник»' });
  } else {
    const canonical = canonicalSource(stated.source);
    if (canonical && normalizeForMatch(canonical) !== normalizeForMatch(card.source)) {
      problems.push({
        code: 'SOURCE_MISMATCH',
        text: `«Источник» в карточке — «${card.source}», а в сообщении «Откуда лид: ${stated.source}» (похоже на «${canonical}»)`,
      });
    }
  }

  if (!card.price || card.price <= 0) {
    const statedText = stated.amount != null ? `, а в сообщении ${formatRub(stated.amount)}` : '';
    problems.push({ code: 'NO_BUDGET', text: `бюджет 0 ₽${statedText}` });
  } else if (stated.amount != null && Math.abs(card.price - stated.amount) / stated.amount > 0.01) {
    problems.push({
      code: 'BUDGET_MISMATCH',
      text: `бюджет в карточке ${formatRub(card.price)}, а в сообщении ${formatRub(stated.amount)}`,
    });
  }

  if (!card.responsibleUserId) {
    problems.push({ code: 'NO_RESPONSIBLE', text: 'не задан ответственный' });
  }

  return problems;
}
