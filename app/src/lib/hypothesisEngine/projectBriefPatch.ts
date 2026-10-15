/**
 * Точечное обновление brief проекта «Движка вертикалей»: offer_override —
 * пользовательская формулировка оффера, style_override — эталон стиля
 * (1–2 «идеальных» письма, чью манеру имитирует генерация) и
 * signature_override — подпись отправителя, которую генерация ставит в конце
 * каждого письма дословно (без неё модель подписывается командой компании и
 * не выдумывает имя человека) и business_override — ручное описание бизнеса
 * (спасение слабого/JS-сайта: идёт в промпт гипотез поверх профиля сайта).
 * Все ложатся в he_projects.brief и уточняют генерацию. Пустая (или
 * состоящая из пробелов) строка удаляет соответствующий ключ из brief,
 * остальные ключи brief не трогаем — мержим поверх текущего значения.
 * Незнакомые поля верхнего уровня игнорируем.
 *
 * Вынесено из PATCH api/tools/hypothesis-engine/projects/[id] — клиентский
 * ENG-контур патчит те же поля (api/client/eng/projects/[id]) и вдобавок
 * рамку ЦА brief.icp (HeBriefPatchClientFields ниже; staff её не пишет).
 * Бриф нового проекта ENG-кабинета собирает buildHeEngCreateBrief (внизу).
 * Ошибки возвращаем машинными кодами, текст локализует роут (staff — RU,
 * клиент — EN).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { mergeHeIcpFrame, type HeIcpFramePatch } from './icpFrame';
import { projectMarket } from './market';

// Максимум символов эталона стиля (brief.style_override) — после trim.
export const STYLE_OVERRIDE_MAX_LENGTH = 8000;

// Максимум символов подписи отправителя (brief.signature_override) — после trim.
export const SIGNATURE_OVERRIDE_MAX_LENGTH = 500;

// Максимум символов ручного описания бизнеса (brief.business_override) — после trim.
export const BUSINESS_OVERRIDE_MAX_LENGTH = 3000;

// Максимум символов оффера (brief.offer_override) — после trim, ТОЛЬКО у проекта
// market='us'. Оффер целиком уходит в платные промпты: письма (chain,
// template), а на рынке 'us' ещё и профиль сайта (stages/siteProfile.ts режет
// его тем же капом при чтении). Клиентский ENG-кабинет (api/client/eng/
// projects/[id]) передаёт кап правилом HeBriefPatchRules.offerMaxLength;
// staff-PATCH правила не передаёт, и тогда кап решает рынок проекта: 'us' —
// тот же кап и тот же отказ, RU-проект принимает оффер любой длины, как до
// порта ENG (решение владельца 14.10.2026 «Как было»). Уже сохранённое длиннее
// значение запись не трогает.
export const OFFER_OVERRIDE_MAX_LENGTH = 3000;

export type HeBriefField = 'offer_override' | 'style_override' | 'signature_override' | 'business_override';

export type HeBriefPatchError =
  /** Ни одного из четырёх полей в теле (и, у клиентского роута, без рамки ЦА). */
  | { code: 'no_fields' }
  /** Поле передано не строкой. */
  | { code: 'bad_type'; field: HeBriefField }
  /** style/signature/business (offer — только у проекта 'us') длиннее лимита после trim. */
  | { code: 'too_long'; field: HeBriefField; max: number }
  | { code: 'not_found' }
  | { code: 'db'; message: string };

export type HeBriefPatchResult =
  | { ok: true; project: Record<string, unknown> }
  | { ok: false; error: HeBriefPatchError };

export interface HeBriefPatchBody {
  offer_override?: unknown;
  style_override?: unknown;
  signature_override?: unknown;
  business_override?: unknown;
}

/**
 * Ключи brief, которые пишет ТОЛЬКО клиентский ENG-роут
 * (api/client/eng/projects/[id]). Отдельным аргументом, а не полем тела:
 * staff-роут RU-инструмента зовёт функцию с тремя аргументами, и `icp` из его
 * тела сюда не попадает — его запросы ведут себя ровно как раньше (тело с
 * одним `icp` у него по-прежнему `no_fields`). Значение уже проверено
 * вызывающим (parseHeIcpFramePatch в icpFrame.ts).
 */
export interface HeBriefPatchClientFields {
  /**
   * Правка рамки ЦА: присланные подполя заменяются, остальные сохраняются;
   * null — снять рамку целиком. Сливается с сохранённой рамкой в той же
   * записи, что и overrides, — один read-merge-write на запрос.
   */
  icp?: HeIcpFramePatch | null;
}

/**
 * Правила записи, которые выбирает вызывающий роут. Отдельным аргументом по
 * той же причине, что и HeBriefPatchClientFields: staff-роут зовёт функцию без
 * него.
 */
export interface HeBriefPatchRules {
  /**
   * Максимум символов offer_override после trim (кабинет —
   * OFFER_OVERRIDE_MAX_LENGTH). Проверка стоит на том же месте, где стояла:
   * после проверок типов всех полей и до капов остальных полей.
   *
   * Не задан (staff-роут) — кап по рынку проекта: оффер длиннее
   * OFFER_OVERRIDE_MAX_LENGTH заставляет прочитать проект раньше обычного, и
   * у 'us' ответ — тот же отказ too_long на том же месте, у RU-проекта оффер
   * принимается, как до порта ENG. Проект не прочитался — путь RU (прежние
   * капы остальных полей, затем not_found/db этого же чтения): это
   * staff-инструмент, а знать, что проект 'us', не из чего.
   */
  offerMaxLength?: number;
}

/** Хотя бы одно поле обязано присутствовать; применяются только строковые. */
export async function patchHeProjectBrief(
  supabase: SupabaseClient,
  projectId: string,
  body: HeBriefPatchBody,
  clientFields?: HeBriefPatchClientFields,
  rules?: HeBriefPatchRules,
): Promise<HeBriefPatchResult> {
  const offerRaw = body?.offer_override;
  const styleRaw = body?.style_override;
  const signatureRaw = body?.signature_override;
  const businessRaw = body?.business_override;
  const icpPatch = clientFields?.icp;
  if (
    offerRaw === undefined &&
    styleRaw === undefined &&
    signatureRaw === undefined &&
    businessRaw === undefined &&
    icpPatch === undefined
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
  const offerMax = rules?.offerMaxLength;
  if (offerMax !== undefined && typeof offerRaw === 'string' && offerRaw.trim().length > offerMax) {
    return { ok: false, error: { code: 'too_long', field: 'offer_override', max: offerMax } };
  }
  // Staff-роут (правила нет): кап по рынку проекта (см. HeBriefPatchRules).
  // Чтение — только когда оффер длиннее капа; его результат идёт и в
  // read-merge-write ниже, второго чтения нет.
  let earlyLoad: { data: unknown; error: { code?: string; message: string } | null } | null = null;
  if (offerMax === undefined && typeof offerRaw === 'string' && offerRaw.trim().length > OFFER_OVERRIDE_MAX_LENGTH) {
    const { data, error } = await supabase
      .from('he_projects')
      .select('brief, market')
      .eq('id', projectId)
      .single();
    if (!error && data && projectMarket(data as { market?: string | null }) === 'us') {
      return { ok: false, error: { code: 'too_long', field: 'offer_override', max: OFFER_OVERRIDE_MAX_LENGTH } };
    }
    earlyLoad = { data, error };
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

  const { data: current, error: loadErr } =
    earlyLoad ?? (await supabase.from('he_projects').select('brief').eq('id', projectId).single());
  if (loadErr) {
    return {
      ok: false,
      error:
        loadErr.code === 'PGRST116'
          ? { code: 'not_found' }
          : { code: 'db', message: loadErr.message },
    };
  }

  const brief = { ...(((current as { brief?: unknown } | null)?.brief as Record<string, unknown> | null) ?? {}) };
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
  if (icpPatch !== undefined) {
    const icp = mergeHeIcpFrame(brief.icp, icpPatch);
    if (icp) brief.icp = icp;
    else delete brief.icp;
  }

  const { data: project, error } = await supabase
    .from('he_projects')
    .update({ brief })
    .eq('id', projectId)
    .select()
    .single();
  if (error) return { ok: false, error: { code: 'db', message: error.message } };

  return { ok: true, project: project as Record<string, unknown> };
}

/** Отказы buildHeEngCreateBrief — те же коды, что у правки. */
export type HeEngCreateBriefError = Extract<HeBriefPatchError, { code: 'bad_type' | 'too_long' }>;

/**
 * Бриф НОВОГО проекта клиентского ENG-кабинета (POST api/client/eng/projects):
 * ответы формы создания, которые исследование читает и которые поэтому нужны
 * ДО него — повторить исследование кликом клиент не может (решение владельца
 * 10.10.2026). Ровно то, что читают стадии исследования:
 *  - business_override — стадия hypotheses кладёт его в промпт поверх профиля
 *    сайта, стадия site_profile строит по нему профиль, когда сайт не открылся
 *    (без него такой прогон падает);
 *  - icp — рамка ЦА, её читает стадия hypotheses на рынке us (проект кабинета
 *    всегда us).
 * offer/style/signature исследование не читает (их читают письма и шаблон) —
 * они остаются на шаге «Brief».
 *
 * Проверка business_override — та же, что у patchHeProjectBrief: строка,
 * trim, BUSINESS_OVERRIDE_MAX_LENGTH, те же коды. Рамку вызывающий уже
 * проверил (parseHeIcpFramePatch), здесь она ложится на пустую рамку тем же
 * mergeHeIcpFrame, что и правка. Пустое не пишется: нет ни одного ответа —
 * null, и колонка brief остаётся пустой, как у проекта, созданного без них.
 */
export function buildHeEngCreateBrief(
  body: { business_override?: unknown },
  clientFields: HeBriefPatchClientFields = {},
): { ok: true; brief: Record<string, unknown> | null } | { ok: false; error: HeEngCreateBriefError } {
  const businessRaw = body?.business_override;
  if (businessRaw !== undefined && typeof businessRaw !== 'string') {
    return { ok: false, error: { code: 'bad_type', field: 'business_override' } };
  }
  const business = typeof businessRaw === 'string' ? businessRaw.trim() : '';
  if (business.length > BUSINESS_OVERRIDE_MAX_LENGTH) {
    return { ok: false, error: { code: 'too_long', field: 'business_override', max: BUSINESS_OVERRIDE_MAX_LENGTH } };
  }
  const brief: Record<string, unknown> = {};
  if (business) brief.business_override = business;
  if (clientFields.icp !== undefined) {
    const icp = mergeHeIcpFrame(undefined, clientFields.icp);
    if (icp) brief.icp = icp;
  }
  return { ok: true, brief: Object.keys(brief).length > 0 ? brief : null };
}
