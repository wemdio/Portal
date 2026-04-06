import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (!supabaseInstantly) return jsonError('Server misconfigured', 500);

  const { userId } = result.auth;
  const { id: leadId } = await ctx.params;

  const { data: lead } = await supabaseInstantly
    .from('client_forwarded_leads')
    .select('id')
    .eq('id', leadId)
    .eq('client_user_id', userId)
    .maybeSingle();

  if (!lead) return jsonError('Lead not found', 404);

  const { data, error } = await supabaseInstantly
    .from('client_lead_comments')
    .select('*')
    .eq('forwarded_lead_id', leadId)
    .order('created_at', { ascending: true });

  if (error) return jsonError(error.message, 500);

  return NextResponse.json({ items: data ?? [] });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (!supabaseInstantly) return jsonError('Server misconfigured', 500);

  const { userId } = result.auth;
  const { id: leadId } = await ctx.params;

  const { data: lead } = await supabaseInstantly
    .from('client_forwarded_leads')
    .select('id')
    .eq('id', leadId)
    .eq('client_user_id', userId)
    .maybeSingle();

  if (!lead) return jsonError('Lead not found', 404);

  const body = (await req.json()) as { comment?: string };
  const comment = body.comment?.trim();
  if (!comment) return jsonError('comment is required', 400);

  let userName: string | null = null;
  if (supabaseAdmin) {
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('full_name')
      .eq('id', userId)
      .single();
    userName = profile?.full_name ?? null;
  }

  const { data, error } = await supabaseInstantly
    .from('client_lead_comments')
    .insert({
      forwarded_lead_id: leadId,
      user_id: userId,
      user_name: userName,
      comment,
    })
    .select()
    .single();

  if (error) return jsonError(error.message, 500);

  return NextResponse.json(data, { status: 201 });
}
