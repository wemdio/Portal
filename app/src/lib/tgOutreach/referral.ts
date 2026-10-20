/**
 * Собеседник дал контакт коллеги: «пишите @AntoshCo». Такой ник уходит в базу
 * кампании, и первое касание ему отправит обычная очередь — бот больше не
 * обещает «напишу коллеге» впустую (19.10.2026).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DialogMessage } from './types';
import { usernameKey } from './report';

/** Ник Telegram: «@name» или ссылка t.me/name. Длина ника в Telegram — 5–32. */
const USERNAME_RE = /(?:^|[^\w@/])@([a-zA-Z][a-zA-Z0-9_]{4,31})\b|(?:https?:\/\/)?t\.me\/([a-zA-Z][a-zA-Z0-9_]{4,31})\b/g;

/**
 * Ник коллеги из последнего сообщения собеседника. Пропускаем его самого и
 * ники, которые уже звучали в наших сообщениях (наш менеджер, чат передачи).
 */
export function findReferredUsername(
  history: DialogMessage[],
  own: Array<string | null | undefined>,
): string | null {
  const last = [...history].reverse().find((m) => m.role === 'user');
  if (!last) return null;
  const excluded = new Set(own.map(usernameKey).filter(Boolean));
  for (const m of history) {
    if (m.role !== 'assistant') continue;
    for (const match of String(m.content ?? '').matchAll(USERNAME_RE)) {
      excluded.add(usernameKey(match[1] ?? match[2]));
    }
  }
  for (const match of String(last.content ?? '').matchAll(USERNAME_RE)) {
    const name = match[1] ?? match[2];
    if (name && !excluded.has(usernameKey(name))) return name;
  }
  return null;
}

/** Инструкция модели: первое сообщение коллеге со ссылкой на того, кто порекомендовал. */
export function referralFirstTouchInstruction(referred: string, referrer: string | null): string {
  return `Собеседник порекомендовал написать своему коллеге @${referred}. Напиши ПЕРВОЕ сообщение этому коллеге (не собеседнику): представься по правилам системного промпта, одной фразой скажи, что его контакт дал ${referrer ? `@${referrer}` : 'коллега'}, и кратко задай тот же вопрос о предложении, что был в нашем первом сообщении в этой переписке. Пиши на языке переписки, 200-400 символов, без ссылок и без фразы передачи менеджеру.`;
}

export type AddReferralResult = 'added' | 'already_known' | 'no_base';

/**
 * Положить ник в базу, из которой пришёл порекомендовавший (или в первую базу
 * кампании). Если ник уже есть в любой базе кампании или ему уже писали —
 * не трогаем: повторно первое касание не нужно.
 */
export async function addReferralToBase(
  db: SupabaseClient,
  campaignId: string,
  referrer: string | null,
  referred: string,
  /** Текст первого касания; зовём, только когда ник точно новый — генерация стоит денег. */
  makeMessage: () => Promise<string | null>,
): Promise<AddReferralResult | 'no_message'> {
  const key = usernameKey(referred);

  const { data: baseRows } = await db
    .from('tg_outreach_bases')
    .select('id, created_at')
    .eq('campaign_id', campaignId)
    .order('created_at', { ascending: true })
    .limit(500);
  const bases = (baseRows ?? []) as Array<{ id: string }>;
  if (!bases.length) return 'no_base';

  const { data: contactRows } = await db
    .from('tg_outreach_base_contacts')
    .select('base_id, username')
    .in('base_id', bases.map((b) => b.id))
    .limit(50_000);
  const contacts = (contactRows ?? []) as Array<{ base_id: string; username: string }>;
  if (contacts.some((c) => usernameKey(c.username) === key)) return 'already_known';

  const { data: processed } = await db
    .from('tg_outreach_processed')
    .select('id')
    .eq('campaign_id', campaignId)
    .ilike('tg_username', key)
    .limit(1);
  if (processed?.length) return 'already_known';

  const referrerKey = usernameKey(referrer);
  const message = (await makeMessage())?.trim();
  if (!message) return 'no_message';

  const baseId = contacts.find((c) => referrerKey && usernameKey(c.username) === referrerKey)?.base_id ?? bases[0].id;

  const { error } = await db.from('tg_outreach_base_contacts').upsert(
    {
      base_id: baseId,
      username: key,
      message,
      raw: { source: 'referral', referred_by: referrer ? `@${referrerKey}` : null },
    },
    { onConflict: 'base_id,username', ignoreDuplicates: true },
  );
  if (error) throw new Error(error.message);
  return 'added';
}
