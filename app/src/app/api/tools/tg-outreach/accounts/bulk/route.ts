import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { parseBulkDeleteBody } from '@/lib/tgOutreach/bulkDelete';

export const dynamic = 'force-dynamic';

interface BulkAccountItem {
  session_name: string;
  api_id: number;
  api_hash: string;
  phone?: string;
  session_data?: string;
  proxy_id?: string | null;
}

export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.accounts.bulk.post' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;

      let body: { campaign_id?: string; accounts?: unknown[] };
      try {
        body = await req.json();
      } catch {
        return jsonError('Неверный JSON', 400);
      }

      const campaignId = body.campaign_id;
      if (!campaignId) return jsonError('campaign_id обязателен', 400);

      const raw = body.accounts;
      if (!Array.isArray(raw) || raw.length === 0) {
        return jsonError('accounts должен быть непустым массивом', 400);
      }

      const rows: BulkAccountItem[] = [];
      for (let i = 0; i < raw.length; i++) {
        const a = raw[i] as Record<string, unknown>;
        // Support both formats: session_name (legacy) or session_file/phone (NewPortalServ style)
        const sessionName =
          (a.session_name as string)?.trim() ||
          (a.session_file as string)?.trim() ||
          (a.phone as string)?.trim();
        if (!sessionName) {
          return jsonError(`accounts[${i}]: укажите session_name, session_file или phone`, 400);
        }
        const apiId = Number(a.api_id);
        const apiHash = (a.api_hash as string)?.trim();
        if (!apiId || !apiHash) {
          return jsonError(`accounts[${i}]: api_id и api_hash обязательны`, 400);
        }
        rows.push({
          session_name: sessionName,
          api_id: apiId,
          api_hash: apiHash,
          phone: ((a.phone as string) ?? '').trim(),
          session_data: (a.session_data as string) ?? '',
          proxy_id: (a.proxy_id as string) || null,
        });
      }

      const insertRows = rows.map((r) => ({
        campaign_id: campaignId,
        session_name: r.session_name,
        api_id: r.api_id,
        api_hash: r.api_hash,
        phone: r.phone ?? '',
        proxy_id: r.proxy_id || null,
        session_data: r.session_data ?? '',
        is_active: true,
      }));

      const { data, error } = await auth.supabase
        .from('tg_outreach_accounts')
        .insert(insertRows)
        .select();

      if (error) return jsonError(error.message, 500);
      return NextResponse.json(
        { items: data ?? [], count: data?.length ?? 0 },
        { status: 201 },
      );
    },
  );
}

/**
 * Массовое удаление аккаунтов кампании.
 *
 * Удалять по одному через /accounts/[id] оператор физически не может: партия
 * аккаунтов — это 20+ строк, а перезаливка после правки файлов требует сначала
 * снести старые. Фильтр по campaign_id обязателен: без него чужой id в списке
 * снёс бы аккаунт соседней кампании.
 */
export async function DELETE(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.accounts.bulk.delete' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;

      const body = await req.json().catch(() => null);
      const parsed = parseBulkDeleteBody(body);
      if (!parsed.ok) return jsonError(parsed.error, 400);

      const { data, error } = await auth.supabase
        .from('tg_outreach_accounts')
        .delete()
        .eq('campaign_id', parsed.campaignId)
        .in('id', parsed.ids)
        .select('id');

      if (error) return jsonError(error.message, 500);
      return NextResponse.json({ ok: true, count: data?.length ?? 0 });
    },
  );
}
