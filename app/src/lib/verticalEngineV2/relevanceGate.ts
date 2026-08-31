/**
 * Релевант-гейт строк автосборки «Движка вертикалей». Источники тащат шум:
 * hh full-text вернёт любую компанию, чья вакансия упомянула слово; карты —
 * рубричный шум; реестр — самодекларированные ОКВЭД. До запуска строки
 * проверяются дешёвой LLM-проверкой (bulk-модель, батчи по 50): «компания ∈
 * вертикаль?». Помеченные нерелевантными строки остаются в базе для
 * прозрачности, но не уходят в запуск (фильтр в launchTemplate).
 *
 * Never-throw: сбой батча не валит сборку, но его company-группы получают
 * явную fail-closed пометку unchecked и не допускаются к запуску/refill.
 */

import { z } from 'zod';
import { callLLMWithSchema, getVeModel, type LLMMessage } from './llm';

/** Строк в одном вызове (≈2-3k токенов); выше — растёт цена и риск усечения. */
const BATCH_SIZE = 50;
/** Сколько первых уникальных компаний проверяем; хвост остаётся unchecked. */
const configuredMaxCompanies = Number(process.env.VE_RELEVANCE_MAX_ROWS);
const MAX_COMPANIES_TO_CHECK = Number.isFinite(configuredMaxCompanies)
  && configuredMaxCompanies > 0
  ? Math.floor(configuredMaxCompanies)
  : 3000;

interface RelevanceCompanyGroup {
  representativeIndex: number;
  rowIndices: number[];
  row: Record<string, unknown>;
}

function rowText(row: Record<string, unknown>, names: string[]): string {
  for (const name of names) {
    const value = row[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (const [key, value] of Object.entries(row)) {
    if (wanted.has(key.trim().toLowerCase()) && typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function normalizeIdentityPart(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * После split_emails одна компания занимает несколько почти одинаковых строк.
 * Релевантность — свойство компании, а не конкретного адреса: проверяем один
 * representative и затем распространяем verdict на все email-строки группы.
 * ИНН — устойчивый legal-entity key; без него используем company+website.
 */
function groupRowsByCompany(rows: Array<Record<string, unknown>>): RelevanceCompanyGroup[] {
  const groups = new Map<string, RelevanceCompanyGroup>();
  rows.forEach((row, index) => {
    const inn = rowText(row, ['inn', 'инн']).replace(/\D/g, '');
    const company = normalizeIdentityPart(rowText(row, ['company', 'компания']));
    const website = normalizeIdentityPart(rowText(row, ['website', 'site', 'сайт']));
    const key = inn
      ? `inn:${inn}`
      : company || website
        ? `company-site:${JSON.stringify([company, website])}`
        : `row:${index}`;
    const existing = groups.get(key);
    if (existing) {
      existing.rowIndices.push(index);
    } else {
      groups.set(key, { representativeIndex: index, rowIndices: [index], row });
    }
  });
  return [...groups.values()];
}

const RelevanceSchema = z.object({
  /** Индексы нерелевантных строк (0-based, из входного батча). */
  // Поле обязательно: отсутствие нельзя трактовать как «все релевантны».
  irrelevant: z.array(z.number().int()),
});

export interface VeRelevanceGateResult {
  /** Глобальные индексы нерелевантных строк (во входном массиве rows). */
  flagged: Set<number>;
  /** Строки компаний, для которых gate не получил надёжный verdict. */
  unchecked: Set<number>;
  /** Покрытие считается по company-группам, а не по email-строкам. */
  coverage: {
    checkedCompanies: number;
    totalCompanies: number;
    complete: boolean;
  };
  tokensUsed: number;
  costUsd: number;
}

function markGroupsUnchecked(
  result: VeRelevanceGateResult,
  groups: RelevanceCompanyGroup[],
): void {
  for (const group of groups) {
    for (const rowIndex of group.rowIndices) result.unchecked.add(rowIndex);
  }
}

function buildRelevanceMessages(
  verticalName: string,
  verticalSummary: string,
  hypothesisTitle: string,
  hypothesisDescription: string,
  batch: Array<{ i: number; company: string; website: string; category: string; vacancy_title: string }>,
  language: 'ru' | 'en',
): LLMMessage[] {
  const rowsJson = JSON.stringify(batch);
  const hasHypothesis = hypothesisTitle.trim().length > 0;
  if (language === 'en') {
    const scope =
      `Vertical: «${verticalName}»${verticalSummary ? ` — ${verticalSummary}` : ''}` +
      (hasHypothesis
        ? `\nTarget hypothesis: «${hypothesisTitle}»${hypothesisDescription ? ` — ${hypothesisDescription}` : ''}`
        : '');
    return [
      {
        role: 'system',
        content: hasHypothesis
          ? 'You filter a collected lead base for one specific hypothesis inside a market vertical. A row is relevant only if the company itself plausibly belongs to the vertical and fits the target audience described by the hypothesis (not merely mentions it in a vacancy or sells to it). Missing size, geography, or trigger evidence is not proof of irrelevance. Answer strictly in JSON.'
          : 'You filter a collected lead base for one market vertical. A row is relevant only if the company itself plausibly belongs to the vertical (not merely mentions it in a vacancy or sells to it). Answer strictly in JSON.',
      },
      {
        role: 'user',
        content: `${scope}\n\nRows (i + fields):\n${rowsJson}\n\nReturn JSON {"irrelevant": [<i>, ...]} with the indices of rows whose company clearly ${
          hasHypothesis
            ? 'does NOT fit the target hypothesis within this vertical'
            : 'does NOT belong to this vertical'
        }. When in doubt — keep the row (do not list it).`,
      },
    ];
  }
  const scope =
    `Вертикаль: «${verticalName}»${verticalSummary ? ` — ${verticalSummary}` : ''}` +
    (hasHypothesis
      ? `\nЦелевая гипотеза: «${hypothesisTitle}»${hypothesisDescription ? ` — ${hypothesisDescription}` : ''}`
      : '');
  return [
    {
      role: 'system',
      content: hasHypothesis
        ? 'Ты фильтруешь собранную базу лидов под одну конкретную гипотезу внутри вертикали рынка. Строка релевантна, только если сама компания правдоподобно принадлежит вертикали и подходит целевой аудитории из гипотезы (а не просто упоминает её в вакансии или продаёт ей). Отсутствие в строке данных о размере, географии или триггере само по себе не доказывает нерелевантность. Отвечай строго в JSON.'
        : 'Ты фильтруешь собранную базу лидов под одну вертикаль рынка. Строка релевантна, только если сама компания правдоподобно принадлежит вертикали (а не просто упоминает её в вакансии или продаёт ей). Отвечай строго в JSON.',
    },
    {
      role: 'user',
      content: `${scope}\n\nСтроки (i + поля):\n${rowsJson}\n\nВерни JSON {"irrelevant": [<i>, ...]} с индексами строк, чья компания явно ${
        hasHypothesis
          ? 'НЕ подходит целевой гипотезе внутри вертикали'
          : 'НЕ принадлежит вертикали'
      }. Сомневаешься — оставляй строку (в список не включай).`,
    },
  ];
}

/**
 * Найти нерелевантные компании среди первых MAX_COMPANIES_TO_CHECK уникальных
 * company-групп. В LLM уходит один representative, а verdict возвращается для
 * всех исходных строк этой компании. Хвост и сбойные батчи возвращаются в
 * unchecked: вызывающий код обязан исключить их до запуска.
 */
export async function findIrrelevantRows(input: {
  rows: Array<Record<string, unknown>>;
  verticalName: string;
  verticalSummary?: string;
  /** Узкая аудитория конкретной base-per-hypothesis базы. */
  hypothesisTitle?: string;
  hypothesisDescription?: string;
  language: 'ru' | 'en';
  log?: (msg: string) => void;
}): Promise<VeRelevanceGateResult> {
  const {
    rows,
    verticalName,
    verticalSummary = '',
    hypothesisTitle = '',
    hypothesisDescription = '',
    language,
    log,
  } = input;
  const groups = groupRowsByCompany(rows);
  const checked = groups.slice(0, MAX_COMPANIES_TO_CHECK);
  const result: VeRelevanceGateResult = {
    flagged: new Set<number>(),
    unchecked: new Set<number>(),
    coverage: {
      checkedCompanies: 0,
      totalCompanies: groups.length,
      complete: groups.length === 0,
    },
    tokensUsed: 0,
    costUsd: 0,
  };
  markGroupsUnchecked(result, groups.slice(MAX_COMPANIES_TO_CHECK));
  if (checked.length === 0) return result;
  if (!verticalName.trim()) {
    markGroupsUnchecked(result, checked);
    return result;
  }

  for (let start = 0; start < checked.length; start += BATCH_SIZE) {
    const batchGroups = checked.slice(start, start + BATCH_SIZE);
    const batch = batchGroups.map((group) => ({
      i: group.representativeIndex,
      company: rowText(group.row, ['company', 'компания']).slice(0, 120),
      website: rowText(group.row, ['website', 'site', 'сайт']).slice(0, 80),
      category: rowText(group.row, ['category', 'категория']).slice(0, 80),
      vacancy_title: rowText(group.row, ['vacancy_title', 'vacancy', 'вакансия']).slice(0, 80),
    }));
    const groupByRepresentative = new Map(
      batchGroups.map((group) => [group.representativeIndex, group] as const),
    );
    try {
      const llm = await callLLMWithSchema(
        buildRelevanceMessages(
          verticalName,
          verticalSummary,
          hypothesisTitle,
          hypothesisDescription,
          batch,
          language,
        ),
        RelevanceSchema,
        // Роль gate: мини-модель — бинарная классификация строк не требует
        // reasoning; на нём только тратились выходные токены и ловились
        // усечения max_tokens (finish_reason='length').
        { model: getVeModel('gate'), maxTokens: 2048 },
      );
      // Защита от мусорного ответа (моки/обрезка): без массива irrelevant
      // батч пропускаем, расход не считаем.
      const irrelevant = Array.isArray((llm.data as { irrelevant?: unknown[] } | undefined)?.irrelevant)
        ? (llm.data as { irrelevant: unknown[] }).irrelevant
        : null;
      if (!irrelevant) {
        markGroupsUnchecked(result, batchGroups);
        log?.(`[relevanceGate] батч ${start}–${start + batch.length - 1}: ответ без irrelevant — пропуск`);
        continue;
      }
      const validRepresentatives = new Set(batchGroups.map((group) => group.representativeIndex));
      if (irrelevant.some((idx) => typeof idx !== 'number' || !validRepresentatives.has(idx))) {
        markGroupsUnchecked(result, batchGroups);
        log?.(
          `[relevanceGate] батч ${start}–${start + batch.length - 1}: ` +
            'ответ содержит чужой индекс — весь батч остаётся непроверенным',
        );
        continue;
      }
      result.tokensUsed += llm.tokensUsed;
      result.costUsd += llm.costUsd;
      result.coverage.checkedCompanies += batchGroups.length;
      for (const idx of irrelevant) {
        // Guard retained for TypeScript/runtime even after whole-array validation.
        if (typeof idx !== 'number') continue;
        const group = groupByRepresentative.get(idx);
        if (!group) continue;
        for (const rowIndex of group.rowIndices) result.flagged.add(rowIndex);
      }
    } catch (e) {
      markGroupsUnchecked(result, batchGroups);
      log?.(
        `[relevanceGate] батч ${start}–${start + batch.length - 1} пропущен: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  result.coverage.complete =
    result.coverage.checkedCompanies === result.coverage.totalCompanies
    && result.unchecked.size === 0;
  return result;
}
