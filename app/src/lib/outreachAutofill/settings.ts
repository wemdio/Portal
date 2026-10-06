import 'server-only';

import { sanitizePolzaOutreachConfig, type PolzaOutreachConfig } from '@/lib/polzaOutreach/types';
import { RU_OUTREACH_PARSER_TYPE, sanitizeRuOutreachConfig, type RuOutreachConfig } from '@/lib/polzaRuOutreach/types';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

/**
 * Настройки и состояние автодобора (таблица outreach_autofill, строка на язык).
 * Конфиг — тот же, что у ручного запуска языка, без «сколько компаний» (его
 * считает автодобор) и без «брать уже выгруженные»: автосбор не должен
 * приводить компании, которым уже писали.
 */

export type AutofillLang = 'ru' | 'en';
export const AUTOFILL_LANGS: AutofillLang[] = ['ru', 'en'];

export const AUTOFILL_PARSER_TYPE: Record<AutofillLang, string> = {
  ru: RU_OUTREACH_PARSER_TYPE,
  en: 'polza_outreach',
};
export const AUTOFILL_FOLDER_KEY: Record<AutofillLang, string> = { ru: 'auto_ru', en: 'auto_en' };
export const AUTOFILL_LABEL: Record<AutofillLang, string> = { ru: 'RU', en: 'EN' };

export type AutofillConfig = Partial<RuOutreachConfig> | Partial<PolzaOutreachConfig>;

export interface AutofillState {
  perDay: number;
  remaining: number;
  daysLeft: number | null;
  /** Последний рабочий день, на который хватит базы (YYYY-MM-DD), null — база пуста. */
  baseUntil: string | null;
  checkedAt: string;
}

export interface AutofillRow {
  lang: AutofillLang;
  enabled: boolean;
  config: AutofillConfig;
  owner_id: string | null;
  last_check_at: string | null;
  last_state: AutofillState | null;
  last_job_id: string | null;
  last_job_day: string | null;
  last_job_handled: boolean;
  last_job_target: number | null;
  short_streak: number;
  updated_at: string;
}

export function isAutofillLang(value: unknown): value is AutofillLang {
  return value === 'ru' || value === 'en';
}

function db() {
  if (!supabaseAdmin) throw new Error('Сервис не настроен: нет сервисного ключа базы');
  return supabaseAdmin;
}

export async function loadAutofill(lang: AutofillLang): Promise<AutofillRow | null> {
  const { data, error } = await db().from('outreach_autofill').select('*').eq('lang', lang).maybeSingle();
  if (error) throw new Error(`настройки автодобора не прочитаны: ${error.message}`);
  return (data as AutofillRow | null) ?? null;
}

export async function updateAutofill(lang: AutofillLang, patch: Partial<Omit<AutofillRow, 'lang'>>): Promise<void> {
  const { error } = await db()
    .from('outreach_autofill')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('lang', lang);
  if (error) throw new Error(`настройки автодобора не записаны: ${error.message}`);
}

/** Полный конфиг запуска языка: санитайзер своего аутрича. */
function sanitizeFor(lang: AutofillLang, raw: Record<string, unknown>): Record<string, unknown> {
  return lang === 'ru'
    ? { ...sanitizeRuOutreachConfig(raw as Partial<RuOutreachConfig>) }
    : { ...sanitizePolzaOutreachConfig(raw as Partial<PolzaOutreachConfig>) };
}

/** Конфиг для хранения: без limit и include_previously_exported. */
export function sanitizeAutofillConfig(lang: AutofillLang, raw: unknown): AutofillConfig {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const clean = sanitizeFor(lang, source);
  delete clean.limit;
  delete clean.include_previously_exported;
  return clean as AutofillConfig;
}

/** Конфиг автосбора: сохранённые настройки + цель + пометка автодобора. */
export function buildAutofillJobConfig(lang: AutofillLang, config: AutofillConfig, target: number): Record<string, unknown> {
  const clean = sanitizeFor(lang, { ...(config as Record<string, unknown>), limit: target, include_previously_exported: false });
  return { ...clean, autofill: true };
}
