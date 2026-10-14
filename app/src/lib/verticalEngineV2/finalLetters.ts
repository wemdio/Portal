import type { VeChainLetter, VeOperatorMapping, VePersonalizationPlan } from './types';
import { extractPersonalizationOperators, mapOperatorsToColumns } from './letterPersonalization';
import { veEmailBodyHasInvalidLinks } from './emailBody';
import { VE_CHAIN_MAX_WAIT_DAYS } from './chainLetters';

export const VE_FINAL_SUBJECT_COUNT = 6;
export const VE_BODY_VARIANTS = ['A', 'B', 'C'] as const;
export type VeBodyVariant = typeof VE_BODY_VARIANTS[number];
export const selectedVeBodies = (letter: VeChainLetter): VeBodyVariant[] => letter.selected_variants ?? [letter.selected_variant ?? 'A'];
const validBody = (value: unknown): value is string => text(value, 12000) && !hasHtml(value) && !veEmailBodyHasInvalidLinks(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= max;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const hasHtml = (value: string) => /<\/?[a-z][^>]*>/i.test(value);

/** Reject malformed editor input rather than silently dropping selected subjects or bodies. */
export function normalizeVeFinalLetters(value: unknown): { letters?: VeChainLetter[]; error?: string } {
  if (!Array.isArray(value) || value.length < 1 || value.length > 6) return { error: 'В цепочке должно быть от 1 до 6 писем.' };
  const letters: VeChainLetter[] = [];
  for (const [index, raw] of value.entries()) {
    if (!object(raw) || !validBody(raw.body)) return { error: `Письмо ${index + 1}: проверьте текст A и ссылки.` };
    if (!VE_BODY_VARIANTS.includes(raw.selected_variant as VeBodyVariant)) return { error: `Письмо ${index + 1}: выберите текст.` };
    if (!Array.isArray(raw.variants) || raw.variants.length > 2 || raw.variants.some(v => !object(v) || !validBody(v.body))) return { error: `Письмо ${index + 1}: проверьте тексты B/C и ссылки.` };
    const selected = raw.selected_variants ?? [raw.selected_variant];
    if (!Array.isArray(selected) || !selected.length || selected.length > 3 || new Set(selected).size !== selected.length
      || selected.some(v => !VE_BODY_VARIANTS.includes(v) || VE_BODY_VARIANTS.indexOf(v) > (raw.variants as unknown[]).length)) return { error: `Письмо ${index + 1}: выбранный текст отсутствует.` };
    if (typeof raw.wait_days !== 'number' || !Number.isInteger(raw.wait_days) || raw.wait_days < 0 || raw.wait_days > VE_CHAIN_MAX_WAIT_DAYS) return { error: `Письмо ${index + 1}: некорректный интервал.` };
    const meta = (row: Record<string, unknown>) => ({
      ...(text(row.angle, 1000) ? { angle: row.angle.trim() } : {}),
      ...(text(row.cta_intent, 1000) ? { cta_intent: row.cta_intent.trim() } : {}),
    });
    const letter: VeChainLetter = { subject: null, body: raw.body, wait_days: index === 0 ? 0 : raw.wait_days,
      selected_variant: selected[0], ...(raw.selected_variants ? { selected_variants: selected as VeBodyVariant[] } : {}),
      variants: raw.variants.map(v => ({ subject: null, body: v.body as string, ...meta(v) })), ...meta(raw) };
    if (index === 0) {
      if (!Array.isArray(raw.subject_options) || raw.subject_options.length !== VE_FINAL_SUBJECT_COUNT || !raw.subject_options.every((v) => typeof v === 'string' && v.length <= 500 && !/[\r\n]/.test(v))) return { error: 'У первого письма должно быть шесть полей темы.' };
      const subjects = raw.subject_options.map((v: string) => v.trim());
      const selected = raw.selected_subject_indices;
      if (!Array.isArray(selected) || selected.length < 1 || selected.length > VE_FINAL_SUBJECT_COUNT || selected.some((v) => !Number.isInteger(v) || v < 0 || v >= VE_FINAL_SUBJECT_COUNT) || new Set(selected).size !== selected.length) return { error: 'Выберите от одной до шести тем первого письма.' };
      if (selected.some((i: number) => !subjects[i])) return { error: 'Выбранная тема не должна быть пустой.' };
      if (new Set(selected.map((i: number) => subjects[i].toLowerCase())).size !== selected.length) return { error: 'Выбранные темы должны различаться.' };
      if (selectedVeBodies(letter).length > 1 && selected.length !== 1) return { error: 'Для теста текстов выберите одну общую тему.' };
      letter.subject_options = subjects;
      letter.selected_subject_indices = [...selected];
      letter.subject = subjects[selected[0]];
    }
    if (raw.segment_variants !== undefined) {
      if (!Array.isArray(raw.segment_variants) || raw.segment_variants.length > 20 || raw.segment_variants.some((v) => !object(v) || !text(v.when, 1000) || !validBody(v.text))) return { error: `Письмо ${index + 1}: проверьте тексты сегментов.` };
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
    const bodies = selectedVeBodies(letter).map(side => side === 'A' ? letter.body : letter.variants?.[VE_BODY_VARIANTS.indexOf(side) - 1]?.body);
    if (bodies.some(body => !body?.trim())) throw new Error(`Письмо ${index + 1}: выбранный текст отсутствует.`);
    const segment = segmentWhen ? letter.segment_variants?.find(v => v.when.trim().toLowerCase() === segmentWhen.trim().toLowerCase()) : undefined;
    const subjects = index === 0 ? (letter.selected_subject_indices ?? []).map(i => letter.subject_options?.[i]) : [null];
    if (index === 0 && (!subjects.length || subjects.length > VE_FINAL_SUBJECT_COUNT || subjects.some(v => !v?.trim()))) throw new Error('Выберите темы первого письма.');
    if (index === 0 && bodies.length > 1 && subjects.length > 1) throw new Error('Для теста текстов выберите одну общую тему.');
    const variants = subjects.flatMap(subject => (segment ? [segment.text] : bodies).map(body => ({ subject: subject ?? null, body: body! })));
    return { ...variants[0], wait_days: letter.wait_days, variants: variants.slice(1),
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
