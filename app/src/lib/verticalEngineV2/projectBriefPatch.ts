/**
 * Точечное обновление brief проекта «Движка вертикалей»: offer_override —
 * пользовательская формулировка оффера, style_override — эталон стиля
 * (1–2 «идеальных» письма, чью манеру имитирует генерация) и
 * signature_override — подпись отправителя, которую генерация ставит в конце
 * каждого письма дословно (без неё модель подписывается командой компании и
 * не выдумывает имя человека) и business_override — ручное описание бизнеса
 * (спасение слабого/JS-сайта: идёт в промпт гипотез поверх профиля сайта).
 * Все ложатся в ve_projects.brief и уточняют генерацию. Пустая (или
 * состоящая из пробелов) строка удаляет соответствующий ключ из brief,
 * остальные ключи brief не трогаем — мержим поверх текущего значения.
 * Незнакомые поля верхнего уровня игнорируем.
 *
 * Вынесено из PATCH api/tools/vertical-engine-v2/projects/[id] — клиентский
 * ENG-контур патчит те же поля (api/client/eng/projects/[id]). Ошибки
 * возвращаем машинными кодами, текст локализует роут (staff — RU, клиент — EN).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// Максимум символов эталона стиля (brief.style_override) — после trim.
export const STYLE_OVERRIDE_MAX_LENGTH = 8000;

// Максимум символов подписи отправителя (brief.signature_override) — после trim.
export const SIGNATURE_OVERRIDE_MAX_LENGTH = 500;

// Максимум символов ручного описания бизнеса (brief.business_override) — после trim.
export const BUSINESS_OVERRIDE_MAX_LENGTH = 3000;

export type VeBriefField = 'offer_override' | 'style_override' | 'signature_override' | 'business_override';

export type VeBriefPatchError =
  /** Ни одного из четырёх полей в теле. */
  | { code: 'no_fields' }
  /** Поле передано не строкой. */
  | { code: 'bad_type'; field: VeBriefField }
  /** style/signature/business длиннее лимита после trim. */
  | { code: 'too_long'; field: 'style_override' | 'signature_override' | 'business_override'; max: number }
  | { code: 'not_found' }
  | { code: 'db'; message: string };

export type VeBriefPatchResult =
  | { ok: true; project: Record<string, unknown> }
  | { ok: false; error: VeBriefPatchError };

export interface VeBriefPatchBody {
  offer_override?: unknown;
  style_override?: unknown;
  signature_override?: unknown;
  business_override?: unknown;
}

/** Хотя бы одно поле обязано присутствовать; применяются только строковые. */
export async function patchVeProjectBrief(
  supabase: SupabaseClient,
  projectId: string,
  body: VeBriefPatchBody,
): Promise<VeBriefPatchResult> {
  const offerRaw = body?.offer_override;
  const styleRaw = body?.style_override;
  const signatureRaw = body?.signature_override;
  const businessRaw = body?.business_override;
  if (
    offerRaw === undefined &&
    styleRaw === undefined &&
    signatureRaw === undefined &&
    businessRaw === undefined
  ) {
    return { ok: false, error: { code: 'no_fields' } };
  }
  if (offerRaw !== undefined && typeof offerRaw !== 'string') {
    return { ok: false, error: { code: 'bad_type', field: 'offer_override' } };
  }
  if (styleRaw !== undefined && typeof styleRaw !== 'string') {
    return { ok: false, error: { code: 'bad_type', field: 'style_override' } };
  }
  if (signatureRaw !== undefined && typeof signatureRaw !== 'string') {
    return { ok: false, error: { code: 'bad_type', field: 'signature_override' } };
  }
  if (businessRaw !== undefined && typeof businessRaw !== 'string') {
    return { ok: false, error: { code: 'bad_type', field: 'business_override' } };
  }
  if (typeof styleRaw === 'string' && styleRaw.trim().length > STYLE_OVERRIDE_MAX_LENGTH) {
    return { ok: false, error: { code: 'too_long', field: 'style_override', max: STYLE_OVERRIDE_MAX_LENGTH } };
  }
  if (typeof signatureRaw === 'string' && signatureRaw.trim().length > SIGNATURE_OVERRIDE_MAX_LENGTH) {
    return { ok: false, error: { code: 'too_long', field: 'signature_override', max: SIGNATURE_OVERRIDE_MAX_LENGTH } };
  }
  if (typeof businessRaw === 'string' && businessRaw.trim().length > BUSINESS_OVERRIDE_MAX_LENGTH) {
    return { ok: false, error: { code: 'too_long', field: 'business_override', max: BUSINESS_OVERRIDE_MAX_LENGTH } };
  }

  const { data: current, error: loadErr } = await supabase
    .from('ve_projects')
    .select('brief')
    .eq('id', projectId)
    .single();
  if (loadErr) {
    return {
      ok: false,
      error:
        loadErr.code === 'PGRST116'
          ? { code: 'not_found' }
          : { code: 'db', message: loadErr.message },
    };
  }

  const brief = { ...((current?.brief as Record<string, unknown> | null) ?? {}) };
  if (typeof offerRaw === 'string') {
    const offer = offerRaw.trim();
    if (offer) brief.offer_override = offer;
    else delete brief.offer_override;
  }
  if (typeof styleRaw === 'string') {
    const style = styleRaw.trim();
    if (style) brief.style_override = style;
    else delete brief.style_override;
  }
  if (typeof signatureRaw === 'string') {
    const signature = signatureRaw.trim();
    if (signature) brief.signature_override = signature;
    else delete brief.signature_override;
  }
  if (typeof businessRaw === 'string') {
    const business = businessRaw.trim();
    if (business) brief.business_override = business;
    else delete brief.business_override;
  }

  const { data: project, error } = await supabase
    .from('ve_projects')
    .update({ brief })
    .eq('id', projectId)
    .select()
    .single();
  if (error) return { ok: false, error: { code: 'db', message: error.message } };

  return { ok: true, project: project as Record<string, unknown> };
}
