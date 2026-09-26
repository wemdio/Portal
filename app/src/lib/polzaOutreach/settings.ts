/**
 * Настройки английского аутрича (polza_outreach_settings) — пока одна: подпись
 * писем. У русского аутрича подпись в «Библиотеках» (polza_ru_senders), у
 * английского была константой в коде; теперь её меняют в панели запуска (роут
 * api/parsers/polza-outreach/settings), а раннер и «Переписать цепочку» читают
 * её здесь — одна подпись на все запуски.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { POLZA_OUTREACH_DEFAULT_SIGNATURE, sanitizePolzaSignature } from './types';

const TABLE = 'polza_outreach_settings';
const SIGNATURE_KEY = 'signature';

export interface SignatureSetting {
  signature: string;
  /** Когда подпись меняли; null — действует подпись по умолчанию. */
  updatedAt: string | null;
}

/**
 * Подпись для писем. Настройки нет или она битая (не строка, пустая) — подпись
 * по умолчанию, та же строка, что в сиде миграции. Сбой чтения — ошибка:
 * письма под чужой подписью хуже, чем запуск, упавший до первого письма.
 */
export async function loadSignatureSetting(db: SupabaseClient): Promise<SignatureSetting> {
  const { data, error } = await db.from(TABLE).select('value,updated_at').eq('key', SIGNATURE_KEY).maybeSingle();
  if (error) throw new Error(`Не удалось прочитать подпись писем из настроек: ${error.message}`);
  const clean = sanitizePolzaSignature((data as { value?: unknown } | null)?.value);
  if (!clean.ok) return { signature: POLZA_OUTREACH_DEFAULT_SIGNATURE, updatedAt: null };
  return { signature: clean.value, updatedAt: (data as { updated_at?: string | null } | null)?.updated_at ?? null };
}

export async function loadSignature(db: SupabaseClient): Promise<string> {
  return (await loadSignatureSetting(db)).signature;
}

/** Подпись — уже очищенная sanitizePolzaSignature. value — jsonb-строка. */
export async function saveSignature(db: SupabaseClient, signature: string): Promise<SignatureSetting> {
  const updatedAt = new Date().toISOString();
  const { error } = await db.from(TABLE).upsert({ key: SIGNATURE_KEY, value: signature, updated_at: updatedAt }, { onConflict: 'key' });
  if (error) throw new Error(`Не удалось сохранить подпись: ${error.message}`);
  return { signature, updatedAt };
}
