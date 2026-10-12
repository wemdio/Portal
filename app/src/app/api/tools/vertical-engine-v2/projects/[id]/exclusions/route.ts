import { NextResponse, type NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { loadVeProjectExclusions, validateVeProjectExclusionInput } from '@/lib/verticalEngineV2/projectExclusions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 30;
type Context = { params: Promise<{ id: string }> };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const failure = (error: string, status: number) => NextResponse.json({ error }, { status });

export async function GET(req: NextRequest, { params }: Context) {
  const auth = await requireInternalToolAuth(req);
  if ('error' in auth) return auth.error;
  if (!supabaseAdmin) return failure('Сервис недоступен', 503);
  const { id } = await params;
  if (!uuid.test(id)) return failure('Некорректный проект', 400);
  try {
    const project = await supabaseAdmin.from('ve_projects').select('id').eq('id', id).maybeSingle();
    if (project.error) return failure('Не удалось проверить проект', 503);
    if (!project.data) return failure('Проект не найден', 404);
    const rules = await loadVeProjectExclusions(supabaseAdmin, id);
    return NextResponse.json({ revision: rules.revision, inns: rules.inns, domains: rules.domains, updated_at: rules.updated_at });
  } catch {
    return failure('Не удалось загрузить исключения. Повторите попытку.', 503);
  }
}

export async function PUT(req: NextRequest, { params }: Context) {
  const auth = await requireInternalToolAuth(req);
  if ('error' in auth) return auth.error;
  if (!supabaseAdmin) return failure('Сервис недоступен', 503);
  const { id } = await params;
  if (!uuid.test(id)) return failure('Некорректный проект', 400);
  let input: unknown;
  try { input = await req.json(); } catch { return failure('Некорректный список исключений', 400); }
  const validated = validateVeProjectExclusionInput(input);
  if (!validated.ok) return NextResponse.json({ error: 'Проверьте список исключений', errors: validated.errors }, { status: 400 });
  try {
    const { data, error } = await supabaseAdmin.rpc('ve_save_project_exclusions', {
      p_project_id: id, p_revision: validated.revision, p_inns: validated.inns,
      p_domains: validated.domains, p_actor_id: auth.auth.userId,
    });
    if (error || !data || typeof data !== 'object') return failure('Не удалось подтвердить сохранение. Обновите список перед повтором.', 503);
    if (data.error === 'conflict') return failure('Исключения изменены в другой вкладке. Обновите список.', 409);
    if (data.error === 'not_found') return failure('Проект не найден', 404);
    if (data.error === 'invalid') return failure('Некорректный список исключений', 400);
    const saved = validateVeProjectExclusionInput(data);
    if (!saved.ok || saved.revision !== validated.revision + 1) return failure('Не удалось подтвердить сохранение. Обновите список перед повтором.', 503);
    return NextResponse.json({ revision: saved.revision, inns: saved.inns, domains: saved.domains, updated_at: data.updated_at });
  } catch {
    return failure('Не удалось подтвердить сохранение. Обновите список перед повтором.', 503);
  }
}
