import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireInternalToolAuth } from '@/lib/toolsApiAuth';
import { withToolTrace } from '@/lib/toolTrace';
import { logAudit, logError } from '@/lib/loggerServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { compileBriefText } from '@/lib/clientBrief';
import type { ClientBriefFields } from '@/lib/clientBrief';
import { extractTextFromBriefFile } from '@/lib/emailSequenceV2/briefExtractor';
import {
  applyClientBriefEdit,
  parseClientBriefText,
  readClientBrief,
  type VeClientBrief,
  type VeClientBriefIcp,
} from '@/lib/verticalEngineV2/clientBriefIntake';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Разбор брифа — один LLM-вызов на 20–40k символов: дольше обычных 30 секунд.
export const maxDuration = 120;

/** Форматы, которые умеет читать общий extractTextFromBriefFile. */
const SUPPORTED_EXTENSIONS = ['.pdf', '.docx', '.txt', '.md'];

const MAX_FILE_BYTES = 20 * 1024 * 1024;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/** Проект существует? Инструмент общий для специалистов — владельца не проверяем. */
async function loadProject(id: string) {
  const { data, error } = await supabaseAdmin!
    .from('ve_projects')
    .select('id, brief')
    .eq('id', id)
    .single();
  if (error) {
    return {
      failure: jsonError(
        error.code === 'PGRST116' ? 'Проект не найден' : error.message,
        error.code === 'PGRST116' ? 404 : 500,
      ),
    };
  }
  return { project: data as { id: string; brief: Record<string, unknown> | null } };
}

/**
 * Пишет client_brief в ve_projects.brief, не задевая остальные ключи
 * (site_profile собирается стадией и не должен теряться от загрузки брифа).
 */
async function saveClientBrief(
  projectId: string,
  currentBrief: Record<string, unknown> | null,
  clientBrief: VeClientBrief,
) {
  const brief = { ...(currentBrief ?? {}), client_brief: clientBrief };
  const { error } = await supabaseAdmin!
    .from('ve_projects')
    .update({ brief, updated_at: new Date().toISOString() })
    .eq('id', projectId);
  return error;
}

function briefResponse(brief: VeClientBrief | null) {
  return NextResponse.json({
    brief,
    compiled_brief_text: brief ? compileBriefText(brief.fields) : '',
  });
}

// GET — текущий бриф проекта + скомпилированный текст (его же видят промпты).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.vertical-engine-v2.brief.get' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      const loaded = await loadProject(id);
      if ('failure' in loaded) return loaded.failure;

      return briefResponse(readClientBrief(loaded.project));
    },
  );
}

// POST — загрузка заполненного клиентом брифа (PDF/DOCX/TXT): извлекаем текст,
// раскладываем по полям стандарта агентства и кладём рядом с site_profile.
// website_url проекта не трогаем: в строке брифа у живых клиентов бывает проза.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.vertical-engine-v2.brief.post' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      const { userId } = authed.auth;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      const loaded = await loadProject(id);
      if ('failure' in loaded) return loaded.failure;

      let file: File | null = null;
      try {
        const form = await req.formData();
        const value = form.get('file');
        if (value instanceof File) file = value;
      } catch {
        return jsonError('Ожидается multipart-форма с полем file', 400);
      }
      if (!file) return jsonError('Файл брифа не передан', 400);
      if (file.size > MAX_FILE_BYTES) return jsonError('Файл больше 20 МБ', 400);

      const lowerName = file.name.toLowerCase();
      if (!SUPPORTED_EXTENSIONS.some((ext) => lowerName.endsWith(ext))) {
        return jsonError(
          `Поддерживаются только ${SUPPORTED_EXTENSIONS.join(', ')} — пересохраните бриф в этом формате`,
          400,
        );
      }

      let text = '';
      try {
        ({ text } = await extractTextFromBriefFile(file));
      } catch (e) {
        return jsonError(e instanceof Error ? e.message : 'Не удалось прочитать файл брифа', 400);
      }
      if (!text.trim()) return jsonError('В файле не нашлось текста — возможно, это скан', 400);

      let parsed: Awaited<ReturnType<typeof parseClientBriefText>>;
      try {
        parsed = await parseClientBriefText(text, { fileName: file.name });
      } catch (e) {
        await logError('tools.vertical-engine-v2.brief.parse_failed', e, { userId, projectId: id });
        return jsonError('Не удалось разобрать бриф — попробуйте ещё раз', 502);
      }

      const saveError = await saveClientBrief(id, loaded.project.brief, parsed.brief);
      if (saveError) {
        await logError('tools.vertical-engine-v2.brief.save_failed', new Error(saveError.message), {
          userId,
          projectId: id,
        });
        return jsonError(saveError.message, 500);
      }

      void logAudit('tools.vertical-engine-v2.brief.uploaded', 'Client brief attached to project', {
        userId,
        projectId: id,
        fileName: file.name,
        missing: parsed.brief.missing.length,
      });

      return NextResponse.json({
        ok: true,
        brief: parsed.brief,
        compiled_brief_text: compileBriefText(parsed.brief.fields),
      });
    },
  );
}

// PUT — ручная правка полей поверх разобранного брифа: специалист дозаполняет
// то, что клиент оставил пустым, или исправляет разбор.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return withToolTrace(
    { request: req, operation: 'tools.vertical-engine-v2.brief.put' },
    async () => {
      const authed = await requireInternalToolAuth(req);
      if ('error' in authed) return authed.error;
      const { userId } = authed.auth;
      if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

      const { id } = await params;
      if (!id) return jsonError('Missing id', 400);

      let body: { fields?: unknown; icp?: unknown };
      try {
        body = (await req.json()) as { fields?: unknown; icp?: unknown };
      } catch {
        return jsonError('Invalid body', 400);
      }
      const isObject = (value: unknown) =>
        Boolean(value) && typeof value === 'object' && !Array.isArray(value);
      if (body?.fields !== undefined && !isObject(body.fields)) {
        return jsonError('fields должен быть объектом', 400);
      }
      if (body?.icp !== undefined && !isObject(body.icp)) {
        return jsonError('icp должен быть объектом', 400);
      }
      if (body?.fields === undefined && body?.icp === undefined) {
        return jsonError('Ожидается fields и/или icp', 400);
      }

      const loaded = await loadProject(id);
      if ('failure' in loaded) return loaded.failure;

      const edited = applyClientBriefEdit(
        readClientBrief(loaded.project),
        (body.fields ?? {}) as Partial<ClientBriefFields>,
        body.icp as Partial<VeClientBriefIcp> | undefined,
      );

      const saveError = await saveClientBrief(id, loaded.project.brief, edited);
      if (saveError) {
        await logError('tools.vertical-engine-v2.brief.edit_failed', new Error(saveError.message), {
          userId,
          projectId: id,
        });
        return jsonError(saveError.message, 500);
      }

      void logAudit('tools.vertical-engine-v2.brief.edited', 'Client brief edited by specialist', {
        userId,
        projectId: id,
        missing: edited.missing.length,
      });

      return briefResponse(edited);
    },
  );
}
