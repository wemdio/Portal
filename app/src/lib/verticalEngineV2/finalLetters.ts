import type { VeChainLetter, VeOperatorMapping, VePersonalizationPlan } from './types';
import { extractPersonalizationOperators, mapOperatorsToColumns } from './letterPersonalization';
import { VE_CHAIN_MAX_WAIT_DAYS } from './chainLetters';

export const VE_FINAL_SUBJECT_COUNT = 6;
const text = (value: unknown, max: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= max;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const hasHtml = (value: string) => /<\/?[a-z][^>]*>/i.test(value);

/** Reject malformed editor input rather than silently dropping selected subjects or bodies. */
export function normalizeVeFinalLetters(value: unknown): { letters?: VeChainLetter[]; error?: string } {
  if (!Array.isArray(value) || value.length < 1 || value.length > 6) return { error: 'В цепочке должно быть от 1 до 6 писем.' };
  const letters: VeChainLetter[] = [];
  for (const [index, raw] of value.entries()) {
    if (!object(raw) || !text(raw.body, 12000) || hasHtml(raw.body)) return { error: `Письмо ${index + 1}: нужен обычный текст варианта A.` };
    if (raw.selected_variant !== 'A' && raw.selected_variant !== 'B') return { error: `Письмо ${index + 1}: выберите текст A или B.` };
    if (!Array.isArray(raw.variants) || raw.variants.length > 1) return { error: `Письмо ${index + 1}: допустима одна альтернатива B.` };
    const alternative = raw.variants[0];
    if (alternative !== undefined && (!object(alternative) || !text(alternative.body, 12000) || hasHtml(alternative.body))) return { error: `Письмо ${index + 1}: проверьте текст B.` };
    if (raw.selected_variant === 'B' && !alternative) return { error: `Письмо ${index + 1}: вариант B отсутствует.` };
    if (typeof raw.wait_days !== 'number' || !Number.isInteger(raw.wait_days) || raw.wait_days < 0 || raw.wait_days > VE_CHAIN_MAX_WAIT_DAYS) return { error: `Письмо ${index + 1}: некорректный интервал.` };
    const meta = (row: Record<string, unknown>) => ({
      ...(text(row.angle, 1000) ? { angle: row.angle.trim() } : {}),
      ...(text(row.cta_intent, 1000) ? { cta_intent: row.cta_intent.trim() } : {}),
    });
    const letter: VeChainLetter = { subject: null, body: raw.body, wait_days: index === 0 ? 0 : raw.wait_days,
      selected_variant: raw.selected_variant, variants: alternative ? [{ subject: null, body: alternative.body as string, ...meta(alternative as Record<string, unknown>) }] : [], ...meta(raw) };
    if (index === 0) {
      if (!Array.isArray(raw.subject_options) || raw.subject_options.length !== VE_FINAL_SUBJECT_COUNT || !raw.subject_options.every((v) => typeof v === 'string' && v.length <= 500 && !/[\r\n]/.test(v))) return { error: 'У первого письма должно быть шесть полей темы.' };
      const subjects = raw.subject_options.map((v: string) => v.trim());
      const selected = raw.selected_subject_indices;
      if (!Array.isArray(selected) || selected.length < 1 || selected.length > VE_FINAL_SUBJECT_COUNT || selected.some((v) => !Number.isInteger(v) || v < 0 || v >= VE_FINAL_SUBJECT_COUNT) || new Set(selected).size !== selected.length) return { error: 'Выберите от одной до шести тем первого письма.' };
      if (selected.some((i: number) => !subjects[i])) return { error: 'Выбранная тема не должна быть пустой.' };
      if (new Set(selected.map((i: number) => subjects[i].toLowerCase())).size !== selected.length) return { error: 'Выбранные темы должны различаться.' };
      letter.subject_options = subjects;
      letter.selected_subject_indices = [...selected];
      letter.subject = subjects[selected[0]];
    }
    if (raw.segment_variants !== undefined) {
      if (!Array.isArray(raw.segment_variants) || raw.segment_variants.length > 20 || raw.segment_variants.some((v) => !object(v) || !text(v.when, 1000) || !text(v.text, 12000) || hasHtml(v.text))) return { error: `Письмо ${index + 1}: проверьте тексты сегментов.` };
      letter.segment_variants = raw.segment_variants.map((v) => ({ when: v.when.trim(), text: v.text }));
    }
    letters.push(letter);
  }
  return { letters };
}

/** Exact final-editor outbound content, shared by preview and Instantly handoff. */
export function materializeVeFinalLetters(letters: VeChainLetter[], segmentWhen?: string | null): VeChainLetter[] {
  return letters.map((letter, index) => {
    if (!letter.selected_variant) return letter;
    const selectedBody = letter.selected_variant === 'B' ? letter.variants?.[0]?.body : letter.body;
    if (!selectedBody?.trim()) throw new Error(`Письмо ${index + 1}: выбранный текст отсутствует.`);
    const segment = segmentWhen ? letter.segment_variants?.find((v) => v.when.trim().toLowerCase() === segmentWhen.trim().toLowerCase()) : undefined;
    const body = segment?.text ?? selectedBody;
    const subjects = index === 0 ? (letter.selected_subject_indices ?? []).map((i) => letter.subject_options?.[i]) : [];
    if (index === 0 && (!subjects.length || subjects.length > VE_FINAL_SUBJECT_COUNT || subjects.some((v) => !v?.trim()))) throw new Error('Выберите темы первого письма.');
    return { subject: index === 0 ? subjects[0]! : null, body, wait_days: letter.wait_days,
      variants: index === 0 ? subjects.slice(1).map((subject) => ({ subject: subject!, body })) : [],
      // Segment materialisation happens here, before subject variants are cloned.
      segment_variants: segmentWhen ? [] : letter.segment_variants };
  });
}

/** Mappings reflect every editable alternative and every offered subject, never invented columns. */
export function buildVeFinalPersonalization(letters: VeChainLetter[], columns: string[], previous?: VePersonalizationPlan): VePersonalizationPlan {
  const texts = letters.map((l) => [l.body, ...(l.variants ?? []).map((v) => v.body), ...(l.subject_options ?? [l.subject ?? '']), ...(l.segment_variants ?? []).map((v) => v.text)].join('\n'));
  const previousMappings = new Map((previous?.operator_mapping ?? []).map((m) => [m.operator.toLowerCase(), m]));
  const operatorMapping: VeOperatorMapping[] = mapOperatorsToColumns(extractPersonalizationOperators(texts.join('\n')), columns).map((mapping) => {
    const old = previousMappings.get(mapping.operator.toLowerCase());
    if (old?.matched && old.column && columns.includes(old.column)) return old;
    return old?.fallback ? { ...mapping, fallback: old.fallback } : mapping;
  });
  const unmatched = operatorMapping.filter((m) => !m.matched && !m.fallback);
  if (unmatched.length) throw new Error(`Нет данных для подстановки: ${unmatched.map((m) => `{{${m.operator}}}`).join(', ')}. Уберите их или используйте существующую колонку.`);
  const subjectOps = new Set(extractPersonalizationOperators((letters[0]?.subject_options ?? []).join('\n')).map((v) => v.toLowerCase()));
  if (operatorMapping.some((m) => subjectOps.has(m.operator.toLowerCase()) && !m.matched)) throw new Error('Подстановка в теме должна соответствовать колонке базы.');
  return { letters: letters.map((letter, i) => ({ letter_index: i + 1, operators: operatorMapping.filter((m) => texts[i].includes(`{{${m.operator}}}`)).map((m) => ({ var: m.operator, column: m.column ?? '', ...(m.fallback ? { fallback: m.fallback } : {}) })) })), additions: [],
    segment_variants: letters.map((letter, i) => ({ letter_index: i + 1, segment_variants: letter.segment_variants ?? [] })), operator_mapping: operatorMapping };
}
