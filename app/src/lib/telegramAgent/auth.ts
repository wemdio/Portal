import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { AgentUser } from './types';

export async function identifyUser(telegramId: number): Promise<AgentUser | null> {
  if (!supabaseAdmin) return null;

  const { data: link, error: linkErr } = await supabaseAdmin
    .from('telegram_links')
    .select('user_id')
    .eq('telegram_id', String(telegramId))
    .maybeSingle();

  if (linkErr || !link) return null;

  const { data: profile, error: profileErr } = await supabaseAdmin
    .from('profiles')
    .select('id, full_name, role, email')
    .eq('id', link.user_id)
    .single();

  if (profileErr || !profile) return null;

  return {
    userId: profile.id,
    fullName: profile.full_name ?? profile.email ?? 'Пользователь',
    role: profile.role ?? 'technician',
    email: profile.email ?? '',
    telegramId,
  };
}
