import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import type { DialogMessage } from '@/lib/tgOutreach/types';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await authenticateRequest(req.headers.get('authorization'));
  if ('error' in auth) return auth.error;

  const url = new URL(req.url);
  const campaignId = url.searchParams.get('campaign_id');
  const format = url.searchParams.get('format') ?? 'json';

  if (!campaignId) return jsonError('campaign_id обязателен', 400);

  const { data, error } = await auth.supabase
    .from('tg_outreach_dialogs')
    .select('*')
    .eq('campaign_id', campaignId)
    .order('last_message_at', { ascending: false, nullsFirst: false });

  if (error) return jsonError(error.message, 500);

  if (format === 'html') {
    const html = generateHtmlExport(data ?? []);
    return new NextResponse(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': `attachment; filename="dialogs_${campaignId}.html"`,
      },
    });
  }

  return NextResponse.json({ items: data ?? [] });
}

interface DialogRow {
  tg_username: string | null;
  tg_user_id: number;
  status: string;
  messages: DialogMessage[];
}

function generateHtmlExport(dialogs: DialogRow[]): string {
  const rows = dialogs.map((d) => {
    const name = d.tg_username ? `@${d.tg_username}` : String(d.tg_user_id);
    const msgs = (d.messages ?? [])
      .map((m) => `<div class="${m.role}"><b>${m.role === 'user' ? 'Собеседник' : 'GPT'}:</b> ${escapeHtml(m.content)}</div>`)
      .join('');
    return `<div class="dialog"><h3>${escapeHtml(name)} <span class="status">[${d.status}]</span></h3>${msgs}</div>`;
  });

  return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>Экспорт диалогов</title>
<style>
body{font-family:system-ui,sans-serif;max-width:900px;margin:0 auto;padding:20px;background:#f9fafb}
.dialog{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin-bottom:16px}
.dialog h3{margin:0 0 12px}.status{color:#6b7280;font-weight:normal;font-size:14px}
.user{background:#eff6ff;border-radius:8px;padding:8px 12px;margin:4px 0}
.assistant{background:#f0fdf4;border-radius:8px;padding:8px 12px;margin:4px 0}
</style></head><body><h1>Диалоги (${dialogs.length})</h1>${rows.join('')}</body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
