import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';
import { isTechnician } from '@/lib/roles';
import type { UserRole } from '@/types';
import { createYookassaInvoice, extractInvoiceUrl, isYookassaConfigured, buildDefaultReceipt, type YookassaVatCode } from '@/lib/yookassa';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

async function requireTechnicianAuth(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return { error: jsonError('Unauthorized', 401) };

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: jsonError('Unauthorized', 401) };
  if (!supabaseAdmin) return { error: jsonError('Server misconfigured', 500) };

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (!isTechnician((profile?.role ?? null) as UserRole | null)) {
    return { error: jsonError('Forbidden', 403) };
  }

  return { user };
}

/* ─── GET /api/invoices ─── */
export async function GET(req: NextRequest) {
  const auth = await requireTechnicianAuth(req);
  if ('error' in auth) return auth.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { searchParams } = new URL(req.url);
  const status = searchParams.get('status');
  const search = searchParams.get('search') ?? '';
  const from = searchParams.get('from');
  const to = searchParams.get('to');
  const page = Math.max(0, Number(searchParams.get('page') ?? '0'));
  const pageSize = 50;

  let query = supabaseAdmin
    .from('invoices')
    .select('*, creator:created_by(id, full_name, email)', { count: 'exact' })
    .is('archived_at', null)
    .order('created_at', { ascending: false })
    .range(page * pageSize, (page + 1) * pageSize - 1);

  if (status && status !== 'all') {
    query = query.eq('status', status);
  }
  if (search) {
    query = query.ilike('company_name', `%${search}%`);
  }
  if (from) {
    query = query.gte('created_at', from);
  }
  if (to) {
    query = query.lte('created_at', to);
  }

  const { data, error, count } = await query;

  if (error) {
    await logError('invoices.list.failed', error, {});
    return jsonError('Failed to load invoices', 500);
  }

  // Chart stats: period = 'week' | 'month' | 'all'
  const chartPeriod = searchParams.get('period') ?? 'month';

  let chartFrom: Date | null = null;
  const now = new Date();

  if (chartPeriod === 'week') {
    chartFrom = new Date(now);
    chartFrom.setDate(chartFrom.getDate() - 6);
  } else if (chartPeriod === 'month') {
    chartFrom = new Date(now);
    chartFrom.setDate(chartFrom.getDate() - 29);
  }
  // 'all' → no lower bound

  let statsQuery = supabaseAdmin
    .from('invoices')
    .select('created_at, amount, status')
    .is('archived_at', null)
    .order('created_at', { ascending: true });

  if (chartFrom) {
    statsQuery = statsQuery.gte('created_at', chartFrom.toISOString());
  }

  const { data: statsRows, error: dailyErr } = await statsQuery;
  if (dailyErr) {
    await logError('invoices.daily.failed', dailyErr, {});
  }

  // For 'all': group by month. For week/month: group by day.
  const useMonthly = chartPeriod === 'all';
  const statsMap: Record<string, { total: number; paid: number; count: number }> = {};

  if (chartPeriod === 'week') {
    for (let i = 0; i < 7; i++) {
      const d = new Date(chartFrom!);
      d.setDate(d.getDate() + i);
      statsMap[d.toISOString().slice(0, 10)] = { total: 0, paid: 0, count: 0 };
    }
  } else if (chartPeriod === 'month') {
    for (let i = 0; i < 30; i++) {
      const d = new Date(chartFrom!);
      d.setDate(d.getDate() + i);
      statsMap[d.toISOString().slice(0, 10)] = { total: 0, paid: 0, count: 0 };
    }
  }

  for (const row of statsRows ?? []) {
    const key = useMonthly
      ? row.created_at.slice(0, 7)   // "2026-05"
      : row.created_at.slice(0, 10); // "2026-05-18"
    if (!statsMap[key]) statsMap[key] = { total: 0, paid: 0, count: 0 };
    statsMap[key].total += Number(row.amount);
    statsMap[key].count += 1;
    if (row.status === 'paid') statsMap[key].paid += Number(row.amount);
  }

  const daily = Object.entries(statsMap).map(([date, s]) => ({ date, ...s }));

  return NextResponse.json({
    invoices: data ?? [],
    total: count ?? 0,
    daily,
  });
}

/* ─── POST /api/invoices ─── */
export async function POST(req: NextRequest) {
  const auth = await requireTechnicianAuth(req);
  if ('error' in auth) return auth.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const { user } = auth;

  let body: {
    company_name: string;
    amount: number;
    currency?: string;
    description?: string;
    client_user_id?: string;
    vat_code?: number;
  };
  try {
    body = await req.json();
  } catch {
    return jsonError('Invalid body', 400);
  }

  if (!body.company_name?.trim()) return jsonError('company_name is required', 400);
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) return jsonError('amount must be positive', 400);

  const { data: invoice, error: insertError } = await supabaseAdmin
    .from('invoices')
    .insert({
      company_name: body.company_name.trim(),
      amount,
      currency: body.currency ?? 'RUB',
      description: body.description?.trim() ?? null,
      client_user_id: body.client_user_id ?? null,
      created_by: user.id,
      status: 'pending',
    })
    .select()
    .single();

  if (insertError || !invoice) {
    await logError('invoices.create.failed', insertError, { company_name: body.company_name });
    return jsonError('Failed to create invoice', 500);
  }

  // Create YooKassa payment if configured
  let yookassaError: string | null = null;

  if (!isYookassaConfigured()) {
    yookassaError = 'YOOKASSA_SHOP_ID / YOOKASSA_SECRET_KEY не настроены';
  } else {
    // 54-FZ receipt requires a customer email (or phone). Prefer the linked
    // client's profile email; fall back to YOOKASSA_FALLBACK_RECEIPT_EMAIL
    // for invoices not tied to a specific client.
    let customerEmail: string | null = null;
    if (invoice.client_user_id) {
      const { data: clientProfile } = await supabaseAdmin
        .from('profiles')
        .select('email')
        .eq('id', invoice.client_user_id)
        .maybeSingle();
      customerEmail = clientProfile?.email ?? null;
    }
    if (!customerEmail) {
      customerEmail = process.env.YOOKASSA_FALLBACK_RECEIPT_EMAIL ?? null;
    }

    if (!customerEmail) {
      yookassaError = 'Не удалось определить email для чека (54-ФЗ). Привяжите клиента к счёту или задайте YOOKASSA_FALLBACK_RECEIPT_EMAIL.';
      await logError('invoices.yookassa.no_receipt_email', null, { invoice_id: invoice.id, client_user_id: invoice.client_user_id });
    } else {
      try {
        const description = invoice.description ?? `Счёт для ${invoice.company_name}`;
        const vatCode = (body.vat_code as YookassaVatCode | undefined) ?? 1;
        const ykInvoice = await createYookassaInvoice({
          amount,
          currency: invoice.currency,
          description,
          invoiceId: invoice.id,
          companyName: invoice.company_name,
          idempotencyKey: invoice.id,
          receipt: buildDefaultReceipt({
            customerEmail,
            description,
            amount,
            currency: invoice.currency,
            vatCode,
          }),
        });

        const ykUrl = extractInvoiceUrl(ykInvoice);

        await supabaseAdmin
          .from('invoices')
          .update({
            yookassa_payment_id: ykInvoice.id,
            yookassa_payment_url: ykUrl,
          })
          .eq('id', invoice.id);

        invoice.yookassa_payment_id = ykInvoice.id;
        invoice.yookassa_payment_url = ykUrl;
      } catch (ykErr) {
        yookassaError = ykErr instanceof Error ? ykErr.message : String(ykErr);
        await logError('invoices.yookassa.create.failed', ykErr, { invoice_id: invoice.id });
      }
    }
  }

  await logAudit(
    'invoices.created',
    `Invoice created for ${invoice.company_name} — ${amount} ${invoice.currency}`,
    { invoice_id: invoice.id, company_name: invoice.company_name, amount },
    { userId: user.id },
  );

  // Re-fetch to return the actual saved state (including yookassa fields)
  const { data: finalInvoice } = await supabaseAdmin
    .from('invoices')
    .select('*')
    .eq('id', invoice.id)
    .single();

  return NextResponse.json({ invoice: finalInvoice ?? invoice, yookassa_error: yookassaError }, { status: 201 });
}
