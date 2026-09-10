import { NextResponse, type NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { buildVeFinalPersonalization, normalizeVeFinalLetters } from '@/lib/verticalEngineV2/finalLetters';
import type { VeTemplate } from '@/lib/verticalEngineV2/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;
type Context = { params: Promise<{ id: string }> };
const fail = (error: string, status: number) => NextResponse.json({ error }, { status });

export async function GET(req: NextRequest, { params }: Context) {
  return withToolTrace({ request: req, operation: 'tools.vertical-engine-v2.final-letters.get' }, async () => {
    const auth = await requireInternalToolAuth(req);
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return fail('Server misconfigured', 500);
    const id = (await params).id;
    const { data: template, error } = await supabaseAdmin.from('ve_templates').select('*').eq('id', id).maybeSingle();
    if (error) return fail('Не удалось загрузить письма.', 503);
    if (!template) return fail('Письма не найдены.', 404);
    const { data: audits, error: auditError } = await supabaseAdmin.from('ve_segmentation_audits').select('status, launch_status').eq('template_id', id);
    const { data: item, error: itemError } = await supabaseAdmin.from('ve_launch_queue_items').select('id').eq('template_id', id).limit(1).maybeSingle();
    if (auditError || itemError) return fail('Не удалось проверить доступность редактирования.', 503);
    const editable = !template.launch_info && !template.supply_batch_id && !item && !(audits ?? []).some((a) => ['pending', 'running'].includes(a.status) || ['running', 'uncertain', 'succeeded'].includes(a.launch_status));
    return NextResponse.json({ template, revision: template.updated_at, editable });
  });
}

export async function PATCH(req: NextRequest, { params }: Context) {
  return withToolTrace({ request: req, operation: 'tools.vertical-engine-v2.final-letters.patch' }, async () => {
    const auth = await requireInternalToolAuth(req);
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return fail('Server misconfigured', 500);
    const input = await req.json().catch(() => null);
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.expected_revision !== 'string') return fail('Передайте письма и просмотренную версию.', 400);
    const parsed = normalizeVeFinalLetters(input.letters);
    if (!parsed.letters) return fail(parsed.error ?? 'Некорректные письма.', 400);
    const id = (await params).id;
    const { data: row, error } = await supabaseAdmin.from('ve_templates').select('*').eq('id', id).maybeSingle();
    if (error || !row) return fail('Письма недоступны.', error ? 503 : 404);
    const template = row as VeTemplate;
    if (template.updated_at !== input.expected_revision) return fail('Письма изменились. Обновите страницу.', 409);
    const { data: base, error: baseError } = await supabaseAdmin.from('ve_bases').select('columns').eq('id', template.base_id).single();
    if (baseError || !base) return fail('Не удалось проверить подстановки по базе.', 503);
    let plan;
    try { plan = buildVeFinalPersonalization(parsed.letters, Array.isArray(base.columns) ? base.columns : [], template.personalization_plan); }
    catch (issue) { return fail(issue instanceof Error ? issue.message : 'Некорректные подстановки.', 400); }
    const { data: saved, error: saveError } = await supabaseAdmin.rpc('ve_save_final_template', {
      p_template_id: id, p_expected_updated_at: input.expected_revision, p_letters: parsed.letters, p_personalization_plan: plan,
    });
    if (saveError || !saved) return fail(saveError?.message ?? 'Не удалось сохранить письма.', 409);
    return NextResponse.json({ template: saved, revision: saved.updated_at, editable: true });
  });
}
