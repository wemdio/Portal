import { NextResponse } from 'next/server';
import { withCopilotAuth } from '@/lib/salesCopilot/apiHelper';
import { sendMessageViaAccount } from '@/lib/salesCopilot/sender';

export const POST = withCopilotAuth(async (req, { supabase }, params) => {
  const configId = params?.id;
  const draftId = params?.draftId;
  if (!configId || !draftId) return NextResponse.json({ error: 'Missing ids' }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const editedText = body.edited_text as string | undefined;

  const { data: draft, error: fetchErr } = await supabase
    .from('sales_copilot_drafts')
    .select('*')
    .eq('id', draftId)
    .eq('config_id', configId)
    .single();

  if (fetchErr || !draft) return NextResponse.json({ error: 'Draft not found' }, { status: 404 });
  if (draft.status !== 'pending') return NextResponse.json({ error: 'Draft already processed' }, { status: 409 });

  const { data: account, error: accErr } = await supabase
    .from('tg_pool_accounts')
    .select('session_data, proxy:tg_pool_proxies(ip, port, type, login, password)')
    .eq('id', draft.account_id)
    .single();

  if (accErr || !account) return NextResponse.json({ error: 'Account not found' }, { status: 404 });

  const finalText = editedText ?? draft.draft_text;

  const result = await sendMessageViaAccount(
    { session_data: account.session_data, proxy: account.proxy },
    draft.tg_user_id,
    finalText,
    draft.tg_draft_set,
  );

  if (!result.ok) {
    return NextResponse.json({ error: `Ошибка отправки: ${result.error}` }, { status: 500 });
  }

  const newStatus = editedText ? 'edited_and_sent' : 'sent';

  const { error: updateErr } = await supabase
    .from('sales_copilot_drafts')
    .update({
      status: newStatus,
      edited_text: editedText ?? null,
      acted_at: new Date().toISOString(),
    })
    .eq('id', draftId);

  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });
  return NextResponse.json({ ok: true, status: newStatus, text: finalText });
});
