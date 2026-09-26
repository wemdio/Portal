'use client';

import type { PolzaOutreachFunnel } from '@/types';
import { POLZA_FUNNEL_ORDER, type PolzaFunnelKey } from '@/lib/polzaOutreach/funnel';
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
  key: PolzaFunnelKey;
  label: string;
  hint: string;
}

const STAGE_TEXT: Record<PolzaFunnelKey, { label: string; hint: string }> = {
  vacancies: { label: 'Кандидаты', hint: 'Компании с вакансией sales/GTM или из YC: одна компания — одна карточка' },
  domain_found: { label: 'Домен компании', hint: 'Официальный сайт компании; размер, страна и отрасль из PDL' },
  icp_passed: {
    label: 'Фильтр ICP и повторы',
    hint: 'Отсеиваем агентства, стаффинг, B2C, размер вне 3–200, дубли домена и компании, уже готовые в прошлых запусках',
  },
  email_found: {
    label: 'Корпоративная почта',
    hint: 'Адрес на сайте компании прошёл SMTP-проверку и не в стоп-листе — ищем до разбора ИИ; проверить не удалось — на ручную проверку',
  },
  geo_confirmed: { label: 'Lead Score: write now', hint: 'Разбор сайта и вакансии ИИ, поводы → балл 0–100 не ниже порога' },
  ready: {
    label: 'Цепочка писем',
    hint: 'Письма — от сильных к слабым до заказанного числа; готовы к отправке: компания, домен, почта и четыре письма',
  },
};

/**
 * Этапы — в порядке шагов раннера (POLZA_FUNNEL_ORDER): с 26.09.2026 почту
 * ищут и проверяют до разбора ИИ, поэтому «Корпоративная почта» стоит раньше
 * Lead Score. Порядок и правила «прошла / не прошла» — в одном месте
 * (lib/polzaOutreach/funnel.ts), здесь только подписи.
 */
const STAGES: StageDef[] = POLZA_FUNNEL_ORDER.map((key) => ({ key, ...STAGE_TEXT[key] }));

export const POLZA_STAGE_LABELS = STAGES.map((stage) => stage.label);
/** Ключ этапа по его номеру на экране — окну разбора этапа. */
export const POLZA_STAGE_KEYS = STAGES.map((stage) => stage.key);

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
