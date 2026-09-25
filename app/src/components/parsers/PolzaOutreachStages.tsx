'use client';

import type { PolzaOutreachFunnel } from '@/types';
import { OutreachStages, stageStatesFromCounts, type StageState } from './OutreachStages';

/**
 * Конвейер англ. аутрича как цепочка этапов, а не как ряд цифр.
 *
 * Плоская воронка отвечала на вопрос «сколько», но не отвечала на главный:
 * ГДЕ сейчас работа и где она встала. Шесть чисел подряд, все нули — и по ним
 * не понять, то ли конвейер не запускался, то ли упал на первом шаге, то ли
 * честно не нашёл ни одной вакансии. Ровно на этом 22.09 и споткнулись:
 * запрос падал на первом же шаге, а воронка показывала просто нули.
 *
 * Поэтому у каждого этапа три вещи: что он делает, сколько прошло дальше и
 * сколько отсеялось между ним и предыдущим. Отсев — это и есть содержательная
 * часть: «из 80 вакансий домен нашёлся у 62» говорит больше, чем оба числа
 * по отдельности.
 */

interface StageDef {
  key: keyof PolzaOutreachFunnel;
  label: string;
  hint: string;
}

const STAGES: StageDef[] = [
  { key: 'vacancies', label: 'Кандидаты', hint: 'Компании с вакансией sales/GTM или из YC: одна компания — одна карточка' },
  { key: 'domain_found', label: 'Домен компании', hint: 'Официальный сайт компании; размер, страна и отрасль из PDL' },
  { key: 'icp_passed', label: 'Фильтр ICP', hint: 'Отсеиваем агентства, стаффинг, B2C и размер вне 3–200' },
  { key: 'geo_confirmed', label: 'Lead Score: write now', hint: 'Сайт, вакансия и поводы → балл 0–100; почту ищем только у набравших порог' },
  { key: 'email_found', label: 'Корпоративная почта', hint: 'Ищем адрес на сайте компании' },
  { key: 'ready', label: 'Цепочка писем', hint: 'Готовы к отправке: компания, вакансия, домен, почта и четыре письма' },
];

export const POLZA_STAGE_LABELS = STAGES.map((stage) => stage.label);

/**
 * Состояние этапов по числам воронки и по тому, что сейчас с запуском.
 *
 * Правило простое: этап пройден, если до него что-то дошло. Первый этап,
 * до которого не дошло ничего, — это и есть место, где работа находится
 * сейчас (или где она встала). Отдельно вынесены «ещё не запускали» и
 * «запуск упал»: без этого пустая воронка выглядит одинаково во всех
 * трёх случаях.
 */
export function stageStates(
  funnel: PolzaOutreachFunnel | null | undefined,
  run: { running: boolean; failed: boolean } | null,
): StageState[] {
  const counts = STAGES.map((stage) => (funnel ? Number(funnel[stage.key] ?? 0) : 0));
  return stageStatesFromCounts(counts, run);
}

export function PolzaOutreachStages({
  funnel,
  run,
  error,
  onOpenStage,
}: {
  funnel: PolzaOutreachFunnel | null | undefined;
  /** Текущий запуск: идёт он или упал. null — запусков ещё не было. */
  run: { running: boolean; failed: boolean } | null;
  /** Текст ошибки запуска — показываем у того этапа, на котором встали. */
  error?: string | null;
  /** Открыть разбор этапа: кто прошёл, кто нет и почему. */
  onOpenStage?: (index: number) => void;
}) {
  return (
    <OutreachStages
      stages={STAGES.map((s) => ({ label: s.label, hint: s.hint, count: funnel ? Number(funnel[s.key] ?? 0) : 0 }))}
      run={run}
      error={error}
      onOpenStage={onOpenStage}
    />
  );
}
