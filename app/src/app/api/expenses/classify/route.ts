import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { requireExpensesAccess } from '@/lib/expenses/access';
import { EXPENSE_SOURCES, isUuid, readJsonBody } from '@/lib/expenses/request';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { ExpenseSource } from '@/lib/expenses/types';

export const dynamic = 'force-dynamic';

const MATCH_FIELDS = ['payee_name', 'payee_inn', 'purpose', 'merchant'] as const;
const MATCH_TYPES = ['exact', 'contains'] as const;

interface ClassifyBody {
  source?: string;
  sourceRef?: string;
  vendorId?: string;
  rule?: {
    matchField?: string;
    matchType?: string;
    pattern?: string;
    source?: string | null;
  };
}

/** Значения CHECK-констрейнтов дублируют схему: несовпадение вернуло бы 500 из базы вместо 400. */
function isKnownSource(value: unknown): value is ExpenseSource {
  return typeof value === 'string' && EXPENSE_SOURCES.includes(value as ExpenseSource);
}

export async function POST(req: NextRequest) {
  const guard = await requireExpensesAccess(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  let body: ClassifyBody;
  try {
    body = await readJsonBody<ClassifyBody>(req);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  if (!isKnownSource(body.source)) {
    return NextResponse.json({ error: `source: ожидается ${EXPENSE_SOURCES.join(', ')}` }, { status: 400 });
  }
  if (typeof body.sourceRef !== 'string' || body.sourceRef.trim().length === 0) {
    return NextResponse.json({ error: 'Нужен sourceRef размечаемой операции' }, { status: 400 });
  }
  if (!isUuid(body.vendorId)) {
    return NextResponse.json({ error: 'vendorId: ожидается UUID' }, { status: 400 });
  }

  const source = body.source;
  const sourceRef = body.sourceRef.trim();
  const vendorId = body.vendorId;

  // Разметку пишем ПЕРВОЙ и с method=manual: apply_expense_rules обновляет
  // только строки с method=rule, поэтому дальнейший прогон правила эту
  // операцию уже не тронет.
  const { error: classifyError } = await supabaseAdmin.from('expense_classifications').upsert(
    {
      source,
      source_ref: sourceRef,
      vendor_id: vendorId,
      method: 'manual',
      rule_id: null,
      classified_by: guard.userId,
      classified_at: new Date().toISOString(),
    },
    { onConflict: 'source,source_ref' },
  );

  if (classifyError) {
    return NextResponse.json({ error: classifyError.message }, { status: 500 });
  }

  if (!body.rule) return NextResponse.json({ ok: true, applied: 0 });

  const { matchField, matchType, pattern } = body.rule;
  if (!matchField || !MATCH_FIELDS.includes(matchField as (typeof MATCH_FIELDS)[number])) {
    return NextResponse.json({ error: `matchField: ожидается ${MATCH_FIELDS.join(', ')}` }, { status: 400 });
  }
  if (!matchType || !MATCH_TYPES.includes(matchType as (typeof MATCH_TYPES)[number])) {
    return NextResponse.json({ error: `matchType: ожидается ${MATCH_TYPES.join(', ')}` }, { status: 400 });
  }
  if (!pattern || pattern.trim().length < 3) {
    return NextResponse.json(
      { error: 'Образец правила короче трёх символов — такое правило совпадёт почти со всем' },
      { status: 400 },
    );
  }
  // source правила необязателен (NULL = любой источник), но если задан —
  // должен пройти тот же CHECK, что и в схеме.
  const ruleSource = body.rule.source ?? null;
  if (ruleSource !== null && !isKnownSource(ruleSource)) {
    return NextResponse.json(
      { error: `rule.source: ожидается ${EXPENSE_SOURCES.join(', ')} или null` },
      { status: 400 },
    );
  }

  const { data: rule, error: ruleError } = await supabaseAdmin
    .from('expense_rules')
    .insert({
      vendor_id: vendorId,
      match_field: matchField,
      match_type: matchType,
      pattern: pattern.trim(),
      source: ruleSource,
      created_by: guard.userId,
    })
    .select('id')
    .single();

  if (ruleError) {
    const status = ruleError.code === '23505' ? 409 : 500;
    return NextResponse.json({ error: ruleError.message }, { status });
  }

  const { data: applied, error: applyError } = await supabaseAdmin.rpc('apply_expense_rules', {
    p_rule_id: rule.id,
  });

  if (applyError) return NextResponse.json({ error: applyError.message }, { status: 500 });

  return NextResponse.json({ ok: true, ruleId: rule.id, applied: applied ?? 0 });
}
