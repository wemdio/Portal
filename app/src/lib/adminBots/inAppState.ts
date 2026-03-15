import { supabaseAdmin } from '@/lib/supabaseAdmin';

const TG_AGENT_BOT_ID = 'tg-agent';

type InAppStateRow = {
  bot_id: string;
  enabled: boolean;
};

async function ensureDefaults(): Promise<void> {
  if (!supabaseAdmin) return;
  await supabaseAdmin
    .from('in_app_bot_states')
    .upsert({ bot_id: TG_AGENT_BOT_ID, enabled: true }, { onConflict: 'bot_id' });
}

export async function isInAppBotEnabled(botId: string): Promise<boolean> {
  if (!supabaseAdmin) return true;
  await ensureDefaults();
  const { data } = await supabaseAdmin
    .from('in_app_bot_states')
    .select('bot_id, enabled')
    .eq('bot_id', botId)
    .maybeSingle<InAppStateRow>();
  return data?.enabled ?? true;
}

export async function setInAppBotEnabled(botId: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
  if (!supabaseAdmin) return { ok: false, error: 'Server misconfigured' };
  const { error } = await supabaseAdmin
    .from('in_app_bot_states')
    .upsert({ bot_id: botId, enabled }, { onConflict: 'bot_id' });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
