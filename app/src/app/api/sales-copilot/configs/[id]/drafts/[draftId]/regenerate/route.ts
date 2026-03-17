import { NextResponse } from 'next/server';
import { withCopilotAuth } from '@/lib/salesCopilot/apiHelper';
import { generateDraft } from '@/lib/salesCopilot/llm';
import type { CopilotDraftMessage } from '@/lib/salesCopilot/types';

export const POST = withCopilotAuth(async (_req, { supabase }, params) => {
  const configId = params?.id;
  const draftId = params?.draftId;
  if (!configId || !draftId) return NextResponse.json({ error: 'Missing ids' }, { status: 400 });

  const { data: draft, error: fetchErr } = await supabase
    .from('sales_copilot_drafts')
    .select('*')
    .eq('id', draftId)
    .eq('config_id', configId)
    .single();

  if (fetchErr || !draft) return NextResponse.json({ error: 'Draft not found' }, { status: 404 });
  if (draft.status !== 'pending') return NextResponse.json({ error: 'Draft already processed' }, { status: 409 });

  const { data: config } = await supabase
    .from('sales_copilot_configs')
    .select('llm_model, reactive_system_prompt, proactive_system_prompt, proactive_silence_days')
    .eq('id', configId)
    .single();

  if (!config) return NextResponse.json({ error: 'Config not found' }, { status: 404 });

  const history = (draft.chat_history ?? []) as CopilotDraftMessage[];
  let prompt = draft.draft_type === 'proactive'
    ? (config.proactive_system_prompt ?? '')
    : (config.reactive_system_prompt ?? '');

  if (draft.draft_type === 'proactive' && draft.silence_days) {
    prompt = prompt.replace(/\{silence_days\}/g, String(draft.silence_days));
  }

  const result = await generateDraft(history, prompt, config.llm_model);

  if (!result.text) {
    return NextResponse.json({ error: 'LLM не сгенерировал ответ' }, { status: 500 });
  }

  const { error: updateErr } = await supabase
    .from('sales_copilot_drafts')
    .update({
      draft_text: result.text,
      llm_tokens_used: result.tokensUsed,
    })
    .eq('id', draftId);

  if (updateErr) return NextResponse.json({ error: updateErr.message }, { status: 500 });
  return NextResponse.json({ ok: true, draft_text: result.text });
});
