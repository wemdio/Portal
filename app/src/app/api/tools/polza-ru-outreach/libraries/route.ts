import { NextResponse, type NextRequest } from 'next/server';
import { logAudit, logError } from '@/lib/loggerServer';
import { authed, jsonError } from '@/lib/polzaRuOutreach/routeAuth';

export const dynamic = 'force-dynamic';

/**
 * Библиотеки «Нашего автоаутрича»: кейсы, утверждения оффера, подписи.
 * Команда ведёт их сама; генератор берёт только утверждённые и не истёкшие
 * записи (для кейсов — ещё и с разрешением на публикацию).
 */

const TABLES = {
  cases: {
    table: 'polza_ru_cases',
    order: 'case_id',
    fields: [
      'case_id', 'public_name', 'client_name_internal', 'anonymization_required', 'industry_groups', 'allowed_chains',
      'case_text_short', 'case_text_long', 'case_text_en', 'case_segment_en', 'case_url', 'metrics',
      'source_file_or_url', 'source_location', 'verified_at', 'verified_by', 'status', 'expires_at',
      'legal_publication_approved', 'notes', 'leads_count',
    ],
    required: ['case_id', 'public_name', 'case_text_short'],
  },
  claims: {
    table: 'polza_ru_offer_claims',
    order: 'claim_key',
    fields: ['chain_type', 'claim_key', 'claim_text', 'status', 'approved_at', 'expires_at', 'approved_by'],
    required: ['chain_type', 'claim_key', 'claim_text'],
  },
  senders: {
    table: 'polza_ru_senders',
    order: 'sender_name',
    fields: ['sender_name', 'sender_title', 'company_name', 'phone', 'website', 'telegram', 'status', 'is_default'],
    required: ['sender_name'],
  },
} as const;

type TableKey = keyof typeof TABLES;
const ARRAY_FIELDS = new Set(['industry_groups', 'allowed_chains']);
const INTEGER_FIELDS = new Set(['leads_count']);

function pick(key: TableKey, input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of TABLES[key].fields) {
    if (!(f in input)) continue;
    let v = input[f];
    if (ARRAY_FIELDS.has(f) && typeof v === 'string') v = v.split(',').map((s) => s.trim()).filter(Boolean);
    if (v === '') v = null;
    if (INTEGER_FIELDS.has(f) && v !== null) {
      const n = Number(String(v).replace(/\s+/g, ''));
      v = Number.isInteger(n) && n >= 0 ? n : null;
    }
    out[f] = v;
  }
  return out;
}

function tableOf(value: unknown): TableKey | null {
  return typeof value === 'string' && value in TABLES ? (value as TableKey) : null;
}

export async function GET(req: NextRequest) {
  const auth = await authed(req);
  if ('error' in auth) return auth.error;
  const result: Record<string, unknown[]> = {};
  for (const [key, cfg] of Object.entries(TABLES)) {
    const { data, error } = await auth.supabase.from(cfg.table).select('*').order(cfg.order, { ascending: true });
    if (error) return jsonError(error.message, 500);
    result[key] = data ?? [];
  }
  return NextResponse.json(result);
}

export async function POST(req: NextRequest) {
  const auth = await authed(req);
  if ('error' in auth) return auth.error;
  const body = (await req.json().catch(() => null)) as { table?: string; record?: Record<string, unknown> } | null;
  const key = tableOf(body?.table);
  if (!key || !body?.record) return jsonError('Нужны table и record', 400);
  const record = pick(key, body.record);
  const missing = TABLES[key].required.filter((f) => !record[f]);
  if (missing.length) return jsonError(`Не заполнены поля: ${missing.join(', ')}`, 400);
  if (key === 'claims' && record.status === 'approved') record.approved_at = record.approved_at ?? new Date().toISOString();
  if (key === 'senders' && record.is_default) {
    await auth.supabase.from('polza_ru_senders').update({ is_default: false }).eq('is_default', true);
  }
  const { data, error } = await auth.supabase.from(TABLES[key].table).insert(record).select('*').single();
  if (error) {
    await logError('polza_ru_outreach.library.create.failed', error, { table: key }, { userId: auth.user.id });
    return jsonError(error.message, 500);
  }
  await logAudit('polza_ru_outreach.library.created', `Наш автоаутрич: запись ${key}`, { table: key, id: data?.id }, { userId: auth.user.id });
  return NextResponse.json({ record: data });
}

export async function PATCH(req: NextRequest) {
  const auth = await authed(req);
  if ('error' in auth) return auth.error;
  const body = (await req.json().catch(() => null)) as { table?: string; id?: string; patch?: Record<string, unknown> } | null;
  const key = tableOf(body?.table);
  if (!key || !body?.id || !body.patch) return jsonError('Нужны table, id и patch', 400);
  const patch: Record<string, unknown> = { ...pick(key, body.patch), updated_at: new Date().toISOString() };
  if (key === 'claims' && patch.status === 'approved' && !patch.approved_at) patch.approved_at = new Date().toISOString();
  if (key === 'senders' && patch.is_default === true) {
    await auth.supabase.from('polza_ru_senders').update({ is_default: false }).neq('id', body.id);
  }
  const { data, error } = await auth.supabase.from(TABLES[key].table).update(patch).eq('id', body.id).select('*').single();
  if (error) {
    await logError('polza_ru_outreach.library.update.failed', error, { table: key, id: body.id }, { userId: auth.user.id });
    return jsonError(error.message, 500);
  }
  await logAudit('polza_ru_outreach.library.updated', `Наш автоаутрич: правка ${key}`, { table: key, id: body.id, patch }, { userId: auth.user.id });
  return NextResponse.json({ record: data });
}

export async function DELETE(req: NextRequest) {
  const auth = await authed(req);
  if ('error' in auth) return auth.error;
  const key = tableOf(req.nextUrl.searchParams.get('table'));
  const id = req.nextUrl.searchParams.get('id');
  if (!key || !id) return jsonError('Нужны table и id', 400);
  const { error } = await auth.supabase.from(TABLES[key].table).delete().eq('id', id);
  if (error) return jsonError(error.message, 500);
  await logAudit('polza_ru_outreach.library.deleted', `Наш автоаутрич: удаление ${key}`, { table: key, id }, { userId: auth.user.id });
  return NextResponse.json({ ok: true });
}
