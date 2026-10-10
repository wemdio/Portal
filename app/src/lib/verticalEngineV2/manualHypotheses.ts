import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import type { VeHypothesis, VeVertical } from './types';

export const VE_MANUAL_HYPOTHESIS_TITLE_MAX = 160;
export const VE_MANUAL_HYPOTHESIS_DESCRIPTION_MAX = 2000;

// Store the specialist's audience as supplied. No model request, invented
// evidence, score, or change to the current outreach selection is needed.
export const VeManualHypothesisInputSchema = z.object({
  title: z.string().max(VE_MANUAL_HYPOTHESIS_TITLE_MAX, 'Название: не более 160 символов')
    .transform((value) => value.replace(/\s+/g, ' ').trim())
    .refine((value) => /[\p{L}\p{N}]/u.test(value) && !/[\p{Cc}\p{Cf}]/u.test(value), 'Укажите название аудитории'),
  description: z.string().max(VE_MANUAL_HYPOTHESIS_DESCRIPTION_MAX, 'Описание: не более 2000 символов')
    .transform((value) => value.replace(/\r\n?/g, '\n').trim())
    .refine((value) => /[\p{L}\p{N}]/u.test(value) && !/[\p{Cc}\p{Cf}]/u.test(value.replace(/[\n\t]/g, '')), 'Опишите, какие компании нужны'),
  request_id: z.string().uuid('Некорректный идентификатор запроса'),
}).strict();

export type VeManualHypothesisInput = z.infer<typeof VeManualHypothesisInputSchema>;
export type VeManualHypothesisFailure = 'invalid' | 'not_found' | 'busy' | 'not_ready' | 'duplicate' | 'conflict' | 'migration' | 'db';
export type VeManualHypothesisResult =
  | { ok: true; hypothesis: VeHypothesis; vertical: VeVertical; existing: boolean }
  | { ok: false; reason: VeManualHypothesisFailure; message: string; diagnostic?: string };

const ERRORS: Record<string, { reason: VeManualHypothesisFailure; message: string }> = {
  ve_manual_invalid_input: { reason: 'invalid', message: 'Укажите название и описание аудитории' },
  ve_manual_project_not_found: { reason: 'not_found', message: 'Проект не найден' },
  ve_manual_research_busy: { reason: 'busy', message: 'Дождитесь окончания исследования проекта' },
  ve_manual_project_not_ready: { reason: 'not_ready', message: 'Сначала завершите исследование проекта' },
  ve_manual_duplicate_title: { reason: 'duplicate', message: 'Гипотеза с таким названием уже есть в проекте' },
  ve_manual_request_conflict: { reason: 'conflict', message: 'Этот запрос уже использован для другой гипотезы. Обновите страницу' },
  ve_manual_result_removed: { reason: 'conflict', message: 'Ранее добавленная гипотеза уже удалена. Обновите страницу' },
};

const SavedResultSchema = z.object({
  ok: z.literal(true),
  existing: z.boolean(),
  hypothesis: z.object({
    id: z.string().uuid(), project_id: z.string().uuid(), vertical_id: z.string().uuid(),
    title: z.string(), description: z.string(), origin: z.literal('manual'),
  }).passthrough(),
  vertical: z.object({ id: z.string().uuid(), project_id: z.string().uuid(), name: z.string() }).passthrough(),
});

/** One atomic RPC also stores the receipt, so retrying an unknown outcome is safe. */
export async function createVeManualHypothesis(
  supabase: SupabaseClient,
  projectId: string,
  userId: string,
  input: unknown,
): Promise<VeManualHypothesisResult> {
  const parsed = VeManualHypothesisInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, reason: 'invalid', message: parsed.error.issues[0]?.code === 'unrecognized_keys'
      ? 'Переданы неизвестные поля' : parsed.error.issues[0]?.message ?? 'Проверьте поля гипотезы' };
  }
  if (!z.string().uuid().safeParse(projectId).success || !z.string().uuid().safeParse(userId).success) {
    return { ok: false, reason: 'invalid', message: 'Некорректный идентификатор проекта или пользователя' };
  }
  try {
    const { data, error } = await supabase.rpc('ve_add_manual_hypothesis', {
      p_project_id: projectId,
      p_request_id: parsed.data.request_id,
      p_title: parsed.data.title,
      p_description: parsed.data.description,
      p_created_by: userId,
    });
    if (error) {
      const known = ERRORS[error.message];
      if (known) return { ok: false, ...known };
      if (error.code === 'PGRST202' || error.code === '42883') {
        return { ok: false, reason: 'migration', message: 'Добавление гипотез пока недоступно: обновление базы данных ещё не применено' };
      }
      return { ok: false, reason: 'db', message: 'Не удалось подтвердить сохранение. Повторите добавление', diagnostic: error.message };
    }
    const saved = SavedResultSchema.safeParse(data);
    if (!saved.success || saved.data.hypothesis.project_id !== projectId
      || saved.data.vertical.project_id !== projectId
      || saved.data.hypothesis.vertical_id !== saved.data.vertical.id) {
      return { ok: false, reason: 'db', message: 'Не удалось подтвердить сохранение. Повторите добавление', diagnostic: 'Invalid manual hypothesis RPC receipt' };
    }
    return {
      ok: true, existing: saved.data.existing,
      hypothesis: saved.data.hypothesis as unknown as VeHypothesis,
      vertical: saved.data.vertical as unknown as VeVertical,
    };
  } catch (error) {
    return { ok: false, reason: 'db', message: 'Не удалось подтвердить сохранение. Повторите добавление', diagnostic: error instanceof Error ? error.message : String(error) };
  }
}
