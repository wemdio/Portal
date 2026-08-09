/**
 * Прогрев: запомненные собеседники.
 *
 * Найти собеседника стоит дорого — это либо резолв @username, либо импорт
 * телефона в контакты. Второе Telegram считает по отдельному, довольно жёсткому
 * счётчику: 07.08.2026 прогрев ATOL-1 упёрся в него на четвёртом дне, и 32 из 37
 * переписок сорвались, потому что контактные запросы перестали отвечать.
 *
 * Состав аккаунтов внутри прогрева постоянный, поэтому искать одного и того же
 * собеседника заново нет причины: `tg_user_id` и `access_hash` не протухают,
 * пока жива сессия. Здесь они и хранятся.
 *
 * access_hash выдаётся под конкретный аккаунт-наблюдатель: то, что нашёл A, для
 * B бесполезно. Отсюда ключ из пары «кто смотрит — на кого».
 */
import { Api } from 'telegram';
import bigInt from 'big-integer';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface CachedPeer {
  tgUserId: string;
  accessHash: string;
}

/** Ключ кэша: собеседник найден конкретным аккаунтом и только для него годится. */
export function peerKey(viewerAccountId: string, targetAccountId: string): string {
  return `${viewerAccountId}|${targetAccountId}`;
}

/**
 * Достать из Api.User то, что нужно запомнить.
 *
 * null — у сущности нет access_hash (так бывает у урезанных объектов из
 * некоторых ответов): запоминать нечего, в следующий раз найдём заново.
 */
export function peerIdentity(user: Api.User): CachedPeer | null {
  if (user.accessHash == null) return null;
  return { tgUserId: String(user.id), accessHash: String(user.accessHash) };
}

/** Собрать peer для отправки из запомненных чисел. */
export function toInputPeer(peer: CachedPeer): Api.InputPeerUser {
  return new Api.InputPeerUser({
    userId: bigInt(peer.tgUserId),
    accessHash: bigInt(peer.accessHash),
  });
}

/** Загрузить все запомненные пары кампании одним запросом. */
export async function loadPeerCache(
  db: SupabaseClient,
  campaignId: string,
): Promise<Map<string, CachedPeer>> {
  const { data } = await db
    .from('tg_outreach_warmup_peers')
    .select('viewer_account_id, target_account_id, tg_user_id, access_hash')
    .eq('campaign_id', campaignId);

  const out = new Map<string, CachedPeer>();
  for (const row of (data ?? []) as Array<{
    viewer_account_id: string;
    target_account_id: string;
    tg_user_id: string;
    access_hash: string;
  }>) {
    out.set(peerKey(row.viewer_account_id, row.target_account_id), {
      tgUserId: row.tg_user_id,
      accessHash: row.access_hash,
    });
  }
  return out;
}

/**
 * Запомнить найденного собеседника.
 *
 * Сбой записи не должен ронять переписку: в худшем случае в следующий раз
 * собеседника найдут заново, то есть вернётся ровно сегодняшнее поведение.
 */
export async function savePeer(
  db: SupabaseClient,
  params: {
    campaignId: string;
    viewerAccountId: string;
    targetAccountId: string;
    peer: CachedPeer;
  },
): Promise<void> {
  await db
    .from('tg_outreach_warmup_peers')
    .upsert(
      {
        campaign_id: params.campaignId,
        viewer_account_id: params.viewerAccountId,
        target_account_id: params.targetAccountId,
        tg_user_id: params.peer.tgUserId,
        access_hash: params.peer.accessHash,
      },
      { onConflict: 'viewer_account_id,target_account_id' },
    )
    .then(undefined, () => {
      /* см. комментарий выше */
    });
}
