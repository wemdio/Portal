import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getGlobalKnowledgeBase, isSupervisor, upsertGlobalKnowledgeBase } from '@/lib/replyPersonalization/db';

export const dynamic = 'force-dynamic';

/** Чтение — всем, кому открыт инструмент (для пометок в проектной модалке). */
export const GET = withAuth(async () => {
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  return NextResponse.json({ global: await getGlobalKnowledgeBase() });
});

/** Глобальный тон/пример задаёт руководство, а не любой сотрудник. */
export const PUT = withAuth(async (req: NextRequest, user) => {
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  if (!(await isSupervisor(user.id))) {
    return NextResponse.json({ error: 'Недостаточно прав' }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as {
    toneNotes?: string;
    exampleCase?: string;
  } | null;
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });

  await upsertGlobalKnowledgeBase(
    { toneNotes: body.toneNotes ?? '', exampleCase: body.exampleCase ?? '' },
    user.id,
  );
  return NextResponse.json({ global: await getGlobalKnowledgeBase() });
});
