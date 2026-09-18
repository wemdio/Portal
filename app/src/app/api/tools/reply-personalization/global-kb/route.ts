import { NextRequest, NextResponse } from 'next/server';
import { withAuth } from '@/lib/instantly/apiRouteHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  getGlobalKnowledgeBase,
  getGlobalSystemPrompt,
  isAdminUser,
  isSupervisor,
  saveGlobalSystemPrompt,
  upsertGlobalKnowledgeBase,
} from '@/lib/replyPersonalization/db';
import { UNIVERSAL_REPLY_RULES } from '@/lib/replyPersonalization/promptRules';

export const dynamic = 'force-dynamic';

/** Промпт и стандартный текст — только админу; остальным поле не отдаём вовсе. */
async function adminPromptPayload(userId: string) {
  if (!(await isAdminUser(userId))) return {};
  return { systemPrompt: await getGlobalSystemPrompt(), defaultSystemPrompt: UNIVERSAL_REPLY_RULES };
}

/** Чтение — всем, кому открыт инструмент (для пометок в проектной модалке). */
export const GET = withAuth(async (_req, user) => {
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  return NextResponse.json({ global: await getGlobalKnowledgeBase(), ...(await adminPromptPayload(user.id)) });
});

/**
 * Глобальный тон/пример задаёт руководство, а не любой сотрудник.
 * Системный промпт — только админ: это правила для всех ответов всех проектов,
 * неудачная правка сразу портит каждый черновик.
 */
export const PUT = withAuth(async (req: NextRequest, user) => {
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  if (!(await isSupervisor(user.id))) {
    return NextResponse.json({ error: 'Недостаточно прав' }, { status: 403 });
  }

  const body = (await req.json().catch(() => null)) as {
    toneNotes?: string;
    exampleCase?: string;
    systemPrompt?: string;
  } | null;
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });

  if (body.systemPrompt !== undefined) {
    if (!(await isAdminUser(user.id))) {
      return NextResponse.json({ error: 'Системный промпт может менять только админ' }, { status: 403 });
    }
    // Совпадает со стандартным — храним пусто: тогда правки правил в коде
    // продолжат доезжать до генерации.
    const prompt = body.systemPrompt.trim() === UNIVERSAL_REPLY_RULES.trim() ? '' : body.systemPrompt;
    await saveGlobalSystemPrompt(prompt, user.id);
  }

  await upsertGlobalKnowledgeBase(
    { toneNotes: body.toneNotes ?? '', exampleCase: body.exampleCase ?? '' },
    user.id,
  );
  return NextResponse.json({ global: await getGlobalKnowledgeBase(), ...(await adminPromptPayload(user.id)) });
});
