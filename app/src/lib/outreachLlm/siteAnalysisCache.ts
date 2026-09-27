/**
 * Кэш разбора сайта ИИ на 30 дней (polza_site_analysis_cache, миграция
 * 20260926_0001) — общий для RU и EN аутричей.
 *
 * Повторный запуск не платит ИИ за ту же компанию и не обходит её сайт
 * заново. В ключе язык, домен, версия промпта и модель: после правки промпта
 * или смены модели старый разбор просто не находится.
 *
 * Кэш — экономия, а не источник правды: сбой чтения — промах, сбой записи —
 * пропуск. Ронять разбор компании из-за кэша нельзя.
 */

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { OutreachLang } from './context';

const TABLE = 'polza_site_analysis_cache';
const DAY_MS = 86_400_000;

/** Сколько дней разбор сайта считается свежим. */
export const SITE_ANALYSIS_CACHE_DAYS = 30;

export interface SiteAnalysisCacheKey {
  lang: OutreachLang;
  /** Нормализованный домен (без схемы, www и пути): один сайт — одна запись. */
  domain: string;
  /** Версия промпта и разбора ответа — константа рядом с промптом. */
  promptVersion: string;
  /** Модель разбора, которую запуск спросил бы сейчас (outreachModel). */
  model: string;
}

/** И Error, и ошибка Supabase (PostgrestError — не Error) несут message. */
function warn(message: string, err: unknown): void {
  const text = err && typeof err === 'object' && 'message' in err ? String((err as { message: unknown }).message) : String(err);
  console.warn(`[outreach-llm][WARN] ${message}: ${text}`);
}

/** Сохранённый результат разбора не старше 30 дней; null — промах. Форму проверяет вызывающий. */
export async function readSiteAnalysisCache(key: SiteAnalysisCacheKey): Promise<unknown> {
  const db = supabaseAdmin;
  if (!db) return null;
  try {
    const since = new Date(Date.now() - SITE_ANALYSIS_CACHE_DAYS * DAY_MS).toISOString();
    const { data, error } = await db
      .from(TABLE)
      .select('result')
      .eq('lang', key.lang)
      .eq('domain', key.domain)
      .eq('prompt_version', key.promptVersion)
      .eq('model', key.model)
      .gte('created_at', since)
      .maybeSingle();
    if (error) {
      warn(`site analysis cache read failed (${key.lang} ${key.domain})`, error);
      return null;
    }
    return (data as { result?: unknown } | null)?.result ?? null;
  } catch (err) {
    warn(`site analysis cache read failed (${key.lang} ${key.domain})`, err);
    return null;
  }
}

/**
 * Удаляет записи языка старше 30 дней. Читатель их и так не берёт, но без
 * чистки таблица растёт с каждым запуском; зовётся раз на старте запуска,
 * по индексу created_at. Сбой — не повод не запускаться.
 */
export async function pruneSiteAnalysisCache(lang: OutreachLang): Promise<void> {
  const db = supabaseAdmin;
  if (!db) return;
  try {
    const before = new Date(Date.now() - SITE_ANALYSIS_CACHE_DAYS * DAY_MS).toISOString();
    const { error } = await db.from(TABLE).delete().eq('lang', lang).lt('created_at', before);
    if (error) warn(`site analysis cache prune failed (${lang})`, error);
  } catch (err) {
    warn(`site analysis cache prune failed (${lang})`, err);
  }
}

/**
 * Запоминает разбор. created_at ставим явно: default now() в таблице
 * срабатывает только на вставке, и перезаписанная запись иначе сохранила бы
 * старую дату и выпала бы из кэша раньше срока.
 */
export async function writeSiteAnalysisCache(key: SiteAnalysisCacheKey, result: unknown): Promise<void> {
  const db = supabaseAdmin;
  if (!db) return;
  try {
    const { error } = await db.from(TABLE).upsert(
      {
        lang: key.lang,
        domain: key.domain,
        prompt_version: key.promptVersion,
        model: key.model,
        result,
        created_at: new Date().toISOString(),
      },
      { onConflict: 'lang,domain,prompt_version,model' },
    );
    if (error) warn(`site analysis cache write failed (${key.lang} ${key.domain})`, error);
  } catch (err) {
    warn(`site analysis cache write failed (${key.lang} ${key.domain})`, err);
  }
}
