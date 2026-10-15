import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isInternalRole } from '@/lib/roles';
import type { UserRole } from '@/types';
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
    .select('id, full_name, role, email, is_demo')
    .eq('id', link.user_id)
    .single();

  if (profileErr || !profile) return null;

  // The agent answers with service-role SQL over every table and with service-role
  // write tools, which no RLS policy can limit. Only internal non-demo staff may use
  // it — the same rule as the middleware staff API gate. Clients, demo and role-less
  // accounts that ever got into telegram_links get the usual "not linked" reply.
  const role = (profile.role ?? null) as UserRole | null;
  if (!role || !isInternalRole(role) || profile.is_demo === true) return null;

  return {
    userId: profile.id,
    fullName: profile.full_name ?? profile.email ?? 'Пользователь',
    role,
    email: profile.email ?? '',
    telegramId,
  };
}
