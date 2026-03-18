import { NextResponse } from 'next/server';
import { withCopilotAuth } from '@/lib/salesCopilot/apiHelper';

export const GET = withCopilotAuth(async (_req, { supabase }, params) => {
  const configId = params?.id;
  if (!configId) return NextResponse.json({ error: 'Missing config id' }, { status: 400 });

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayISO = todayStart.toISOString();

  const [pendingReactive, pendingProactive, sentToday, dismissedToday] = await Promise.all([
    supabase.from('sales_copilot_drafts').select('id', { count: 'exact', head: true })
      .eq('config_id', configId).eq('status', 'pending').eq('draft_type', 'reactive'),
    supabase.from('sales_copilot_drafts').select('id', { count: 'exact', head: true })
      .eq('config_id', configId).eq('status', 'pending').eq('draft_type', 'proactive'),
    supabase.from('sales_copilot_drafts').select('id', { count: 'exact', head: true })
      .eq('config_id', configId).in('status', ['sent', 'edited_and_sent']).gte('acted_at', todayISO),
    supabase.from('sales_copilot_drafts').select('id', { count: 'exact', head: true })
      .eq('config_id', configId).eq('status', 'dismissed').gte('acted_at', todayISO),
  ]);

  return NextResponse.json({
    pending_reactive: pendingReactive.count ?? 0,
    pending_proactive: pendingProactive.count ?? 0,
    sent_today: sentToday.count ?? 0,
    dismissed_today: dismissedToday.count ?? 0,
  });
});
