import { NextRequest, NextResponse } from 'next/server';
import { supabaseInstantly } from '@/lib/supabaseInstantly';

export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;
  if (!supabaseInstantly) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const { data, error } = await supabaseInstantly
    .from('project_instantly_campaigns')
    .select('campaign_id, match_source, created_at')
    .eq('project_id', projectId)
    .order('created_at', { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Enrich with campaign names from catalog
  const campaignIds = (data ?? []).map((r) => r.campaign_id as string);
  let nameMap: Record<string, string> = {};

  if (campaignIds.length > 0) {
    const { data: catalog } = await supabaseInstantly
      .from('instantly_campaign_catalog')
      .select('id, name')
      .in('id', campaignIds);

    if (catalog) {
      nameMap = Object.fromEntries(
        catalog.map((c: { id: string; name: string }) => [c.id, c.name]),
      );
    }
  }

  const items = (data ?? []).map((r) => ({
    campaign_id: r.campaign_id as string,
    campaign_name: nameMap[r.campaign_id as string] ?? r.campaign_id,
    match_source: r.match_source as string,
    created_at: r.created_at as string,
  }));

  return NextResponse.json({ items });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;
  if (!supabaseInstantly) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const body = await req.json() as { campaign_id?: string };
  if (!body.campaign_id) {
    return NextResponse.json({ error: 'campaign_id required' }, { status: 400 });
  }

  const { error } = await supabaseInstantly
    .from('project_instantly_campaigns')
    .upsert(
      { project_id: projectId, campaign_id: body.campaign_id, match_source: 'manual' },
      { onConflict: 'project_id,campaign_id' },
    );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;
  if (!supabaseInstantly) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const url = new URL(req.url);
  const campaignId = url.searchParams.get('campaign_id');
  if (!campaignId) {
    return NextResponse.json({ error: 'campaign_id required' }, { status: 400 });
  }

  const { error } = await supabaseInstantly
    .from('project_instantly_campaigns')
    .delete()
    .eq('project_id', projectId)
    .eq('campaign_id', campaignId);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
