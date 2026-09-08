/**
 * Общее для всех ручек, которые ходят в Telegram аккаунтом из портала.
 *
 * Вынесено из ручки профиля, когда автозаполнение потребовало того же самого:
 * гейт по статусу кампании и подключение через прокси аккаунта. Копия
 * разошлась бы с оригиналом на первой же правке гейта, а гейт тут защитный —
 * он не даёт открыть второе соединение к занятой сессии.
 */
import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import { jsonError } from '@/lib/tgOutreach/apiHelpers';
import { createGramClient } from '@/lib/tgOutreach/gramClient';
import { downloadSessionToTemp } from '@/lib/tgOutreach/campaignLoop';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { OutreachAccount, OutreachProxy } from '@/lib/tgOutreach/types';

/**
 * Аккаунт + гейт по статусу кампании.
 *
 * Работающая кампания уже держит соединение с этим аккаунтом; второе
 * подключение через мобильный прокси — лишний повод для сбоя. Правило одно и
 * для записи профиля, и для чтения: пока идёт рассылка или прогрев, в Telegram
 * не ходим, карточка показывает сохранённое в портале.
 */
export async function loadAccountForProfile(
  supabase: SupabaseClient,
  id: string,
): Promise<{ account: OutreachAccount } | { error: NextResponse }> {
  const { data: accountRow } = await supabase
    .from('tg_outreach_accounts')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (!accountRow) return { error: jsonError('Аккаунт не найден', 404) };
  const account = accountRow as OutreachAccount;

  const { data: campaign } = await supabase
    .from('tg_outreach_campaigns')
    .select('status')
    .eq('id', account.campaign_id)
    .maybeSingle();
  const status = (campaign as { status?: string } | null)?.status;
  if (status && status !== 'stopped' && status !== 'error') {
    return {
      error: jsonError(
        `Кампания сейчас в состоянии «${status}». Остановите её, чтобы работать с профилем аккаунта: во время работы аккаунт занят.`,
        409,
      ),
    };
  }
  return { account };
}

/**
 * Подключиться аккаунтом через его прокси.
 *
 * downloadSessionFile обязателен: у аккаунтов, залитых парами `.json`+`.session`
 * без успешной конверсии SQLite в StringSession, `session_data` пустой, а
 * `session_file_path` заполнен. Без функции скачивания createGramClient падает
 * ещё до подключения — «Нет session_data или session_file_path».
 *
 * Скачивать нужно служебным ключом, а не пользовательским: бакет с сессиями
 * приватный, и обычному пользователю хранилище отвечает «Object not found» —
 * ту же фразу, что и на действительно отсутствующий файл. 10.08.2026 из-за
 * этого чтение профиля падало на всех аккаунтах разом с сообщением про прокси.
 */
export async function connectAccount(supabase: SupabaseClient, account: OutreachAccount) {
  const { data: proxyRow } = account.proxy_id
    ? await supabase.from('tg_outreach_proxies').select('*').eq('id', account.proxy_id).maybeSingle()
    : { data: null };

  const storage = supabaseAdmin ?? supabase;
  return createGramClient(
    account,
    (proxyRow as OutreachProxy) ?? null,
    (storagePath) => downloadSessionToTemp(storage, storagePath),
  );
}

