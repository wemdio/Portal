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
// Порядок важен: «Аутрич» проверяется после email/telegram-аутрича, иначе более
// общий синоним «outreach» перехватит их случаи.
const SOURCE_SYNONYMS: Array<{ canonical: string; synonyms: string[] }> = [
  { canonical: 'Сайт', synonyms: ['сайт', 'заявкассайта', 'форма'] },
  { canonical: 'Лидскан', synonyms: ['лидскан', 'leadscan'] },
  { canonical: 'Партнер', synonyms: ['партнер', 'партнёр'] },
  { canonical: 'Email Outreach', synonyms: ['emailoutreach', 'email', 'имейл', 'почта'] },
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

/** «Откуда лид» → каноническое значение «Источник», если синоним уверенно распознан; иначе null. */
export function canonicalSource(statedSource: string | null): string | null {
  if (!statedSource) return null;
  const normalized = normalizeForMatch(statedSource);
  if (!normalized) return null;
  for (const { canonical, synonyms } of SOURCE_SYNONYMS) {
    if (synonyms.some((synonym) => normalized.includes(synonym))) return canonical;
  }
  return null;
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
    if (canonical && canonical !== card.source) {
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
