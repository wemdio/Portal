import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';

import { isProduct, legacyStepOf, type Product } from './cascade';
import { CHAIN_TYPES, type ChainType } from './types';

/**
 * Какой продукт предлагали получателю «Рассылки». Получатель автоаутрича хранит
 * в `group_key` id строки компании (`polza_ru_outreach_companies.id`), а у строки
 * записан продукт и номер шага каскада. Читают сообщение о лиде (senderLeads) и
 * ИИ-собеседник (senderAiQualifier).
 */

export interface RowProduct {
  product: Product;
  /** Шаг каскада 1–3; null — номер не записан. */
  cascadeNo: number | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Продукт получателя или null: рассылка не русского автоаутрича (у `ve2` и
 * ручных group_key значит другое), строка удалена, у строки до каскада продукта
 * нет или он неизвестен. Сбой чтения — исключение: вызывающий повторит ход, а не
 * отправит лиду КП не того продукта.
 */
export async function loadRecipientProduct(
  db: SupabaseClient, recipientId: string, options: { includeLegacy?: boolean } = {},
): Promise<RowProduct | null> {
  const { data, error } = await db
    .from('sender_recipients')
    .select('group_key, sender_campaigns(source_kind)')
    .eq('id', recipientId)
    .maybeSingle();
  if (error) throw new Error(`sender_recipients: ${error.message}`);
  type Campaign = { source_kind: string | null };
  const recipient = data as { group_key: string | null; sender_campaigns: Campaign | Campaign[] | null } | null;
  const campaign = Array.isArray(recipient?.sender_campaigns) ? recipient.sender_campaigns[0] : recipient?.sender_campaigns;
  const rowId = recipient?.group_key ?? '';
  if (campaign?.source_kind !== 'polza_ru' || !UUID_RE.test(rowId)) return null;

  const { data: found, error: rowError } = await db
    .from('polza_ru_outreach_companies')
    .select('product, cascade_no, chain_type')
    .eq('id', rowId)
    .maybeSingle();
  if (rowError) throw new Error(`polza_ru_outreach_companies: ${rowError.message}`);
  const row = found as { product: string | null; cascade_no: number | null; chain_type: string | null } | null;
  if (!row) return null;
  if (!row.product && options.includeLegacy && row.chain_type && (CHAIN_TYPES as readonly string[]).includes(row.chain_type)) {
    return { product: legacyStepOf(row.chain_type as ChainType), cascadeNo: null };
  }
  if (!row.product || !isProduct(row.product)) return null;
  const no = row.cascade_no;
  return { product: row.product, cascadeNo: typeof no === 'number' && Number.isInteger(no) && no >= 1 && no <= 3 ? no : null };
}
