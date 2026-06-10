import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { V2_DEFAULT_PROMPTS } from '@/lib/liOutreach/v2DefaultPrompts';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

/**
 * Активирует кампанию LinkedIn Outreach v2 и сигналит OpenOutreach-daemon'у
 * через флип `li2_accounts.status='running'`.
 *
 * Раньше эта ручка инсертила строку в `li2_jobs`, но у этой очереди никогда
 * не было потребителя (см. инцидент 10.06.2026, 09:28: "OpenOutreach start
 * job queued" висел 23 минуты единственным логом, и при этом сама `li2_jobs`
 * таблица была не применена к проду). После миграции 20260610_0001 контракт
 * Portal↔daemon свёлся к одному полю: `li2_accounts.status`, daemon поллит
 * его каждые 5s и стартует AccountWorker для каждой running-строки.
 *
 * Per-campaign LLM конфиг (продукт, рынок, цель, qualify-prompt) едет в
 * `li2_campaigns.qualifiers jsonb`, daemon читает его в момент исполнения
 * task'а.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach-v2.campaigns.start' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    const { id } = await ctx.params;
    const requestyKey = (process.env.OPENROUTER_LI_OUTREACH_API_KEY ?? '').trim();
    if (!requestyKey) {
      return jsonError('OPENROUTER_LI_OUTREACH_API_KEY is not configured on server', 500);
    }

    const { data: settings } = await auth.supabase
      .from('li2_settings')
      .select('linkedin_email,linkedin_password,legal_accepted,prompt_follow_up_agent,prompt_qualify_lead,prompt_search_keywords')
      .eq('user_id', auth.user.id)
      .maybeSingle();

    if (!settings?.linkedin_email || !settings?.linkedin_password) {
      return jsonError('Fill LinkedIn settings before starting OpenOutreach', 400);
    }
    if (!settings.legal_accepted) {
      return jsonError('Accept the LinkedIn automation risk notice before starting', 400);
    }

    const { data: campaign, error: loadError } = await auth.supabase
      .from('li2_campaigns')
      .select('*')
      .eq('id', id)
      .eq('user_id', auth.user.id)
      .maybeSingle();
    if (loadError) return jsonError(loadError.message, 500);
    if (!campaign) return jsonError('Campaign not found', 404);

    const now = new Date().toISOString();

    // Промпты: пустой user-override → upstream default. Daemon при исполнении
    // task'а возьмёт из qualifiers, поэтому полная LLM-конфигурация едет в
    // jsonb-поле campaign'а, а не в env-переменной как было в job-payload'е.
    const prompts = {
      follow_up_agent: (settings.prompt_follow_up_agent ?? '').trim() || V2_DEFAULT_PROMPTS.follow_up_agent,
      qualify_lead:    (settings.prompt_qualify_lead    ?? '').trim() || V2_DEFAULT_PROMPTS.qualify_lead,
      search_keywords: (settings.prompt_search_keywords ?? '').trim() || V2_DEFAULT_PROMPTS.search_keywords,
    };
    const qualifiers = [{
      name: 'default',
      prompt: prompts.qualify_lead,
      product_description: campaign.product_description,
      target_market: campaign.target_market,
      campaign_objective: campaign.campaign_objective,
      follow_up_prompt: prompts.follow_up_agent,
      search_keywords_prompt: prompts.search_keywords,
      // Stored as a single textarea string ("one URL per line"); parse to
      // array of trimmed non-empty URLs for the daemon. Эти seed-URL'ы
      // OpenOutreach использует для bootstrap'а discovery (1st-degree
      // connections, "people also viewed", etc.).
      seed_profile_urls: String(campaign.seed_profile_urls ?? '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    }];

    // Активируем кампанию + прокидываем qualifiers для daemon'а
    const { error: updateError } = await auth.supabase
      .from('li2_campaigns')
      .update({
        status: 'running',
        runtime_status: 'queued_for_openoutreach',
        qualifiers,
        updated_at: now,
      })
      .eq('id', id)
      .eq('user_id', auth.user.id);
    if (updateError) return jsonError(updateError.message, 500);

    // Upsert li2_accounts: daemon-side state aggregator per user.
    // Если status был 'disconnected'/'needs_captcha' — перетираем на 'running',
    // даём daemon'у попробовать заново. Если daemon снова упрётся в проблему
    // (CAPTCHA, banned account) — он сам флипнет обратно.
    const { error: accError } = await auth.supabase
      .from('li2_accounts')
      .upsert({
        user_id: auth.user.id,
        status: 'running',
        runtime_status: 'starting',
        last_error: null,
        updated_at: now,
      }, { onConflict: 'user_id' });
    if (accError) return jsonError(accError.message, 500);

    await auth.supabase.from('li2_logs').insert({
      user_id: auth.user.id,
      campaign_id: id,
      level: 'info',
      message: 'Campaign activated — daemon will start within ~5s',
    });

    return NextResponse.json({ ok: true });
  });
}
