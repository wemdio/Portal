import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { generateJSON } from '@tiptap/html/server';
import type { JSONContent } from '@tiptap/core';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isAdmin } from '@/lib/roles';
import type { UserRole } from '@/types';
import { createReglamentSlug, DEFAULT_REGLAMENT_CONTENT } from '@/lib/reglamentEditor';
import { REGLAMENT_IMPORT_EXTENSIONS } from '@/lib/reglamentImportExtensions';
import { wrapSectionsInBlocks } from '@/lib/wrapSectionsInBlocks';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const GOOGLE_DOC_ID_REGEX = /(?:^|\/)([a-zA-Z0-9_-]{25,})(?:\/|$)/;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function extractDocumentId(urlOrId: string): string | null {
  const trimmed = urlOrId.trim();
  if (!trimmed) return null;
  // Direct ID (alphanumeric, 25+ chars)
  if (/^[a-zA-Z0-9_-]{25,}$/.test(trimmed)) return trimmed;
  // URL: docs.google.com/document/d/DOC_ID/...
  const match = trimmed.match(/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  // Fallback: any long alphanumeric segment
  const idMatch = trimmed.match(GOOGLE_DOC_ID_REGEX);
  return idMatch ? idMatch[1] : null;
}

async function fetchHtmlViaExportUrl(documentId: string): Promise<string> {
  const exportUrl = `https://docs.google.com/document/d/${documentId}/export?format=html`;
  const res = await fetch(exportUrl, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  });

  if (!res.ok) {
    if (res.status === 403) {
      throw new Error(
        'Доступ запрещён. Убедитесь, что документ доступен по ссылке (Файл → Поделиться → Доступ по ссылке). ' +
          'Для приватных документов настройте GOOGLE_SERVICE_ACCOUNT_EMAIL и GOOGLE_PRIVATE_KEY в .env'
      );
    }
    if (res.status === 404) {
      throw new Error('Документ не найден. Проверьте ссылку.');
    }
    throw new Error(`Ошибка загрузки: ${res.status}`);
  }

  return res.text();
}

async function fetchHtmlViaDriveApi(documentId: string): Promise<string> {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  if (!email || !privateKey) return '';

  try {
    const mod = await import('googleapis').catch(() => null);
    if (!mod?.google) return '';
    const { google } = mod;
    const auth = new google.auth.JWT({
      email,
      key: privateKey,
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });
    const drive = google.drive({ version: 'v3', auth });
    const res = await drive.files.export({
      fileId: documentId,
      mimeType: 'text/html',
    });
    const data = res.data as unknown;
    if (typeof data === 'string') return data;
    if (Buffer.isBuffer(data)) return data.toString('utf-8');
    return '';
  } catch {
    return '';
  }
}

function extractTitleFromHtml(html: string): string {
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (titleMatch) {
    return titleMatch[1].replace(/ - Google Docs$/i, '').trim() || 'Импорт из Google Docs';
  }
  return 'Импорт из Google Docs';
}

function extractBodyHtml(html: string): string {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (bodyMatch) return bodyMatch[1];
  return html;
}

/** Нормализует HTML из Google Docs для корректного парсинга таблиц и чек-листов */
async function normalizeGoogleDocsHtml(html: string): Promise<string> {
  try {
    const { load } = await import('cheerio');
    const $ = load(html);

    $('colgroup, col').remove();

    // Detect and mark checklist items from Google Docs
    // Google Docs exports checkboxes as list items with specific list-style or checkbox characters
    $('li').each((_i, el) => {
      const text = $(el).text().trim();
      // Match items starting with [ ], [x], [X], ☐, ☑ or similar checkbox indicators
      if (/^(\[\s*[xX✓✔]?\s*\]|☐|☑|✅)/.test(text)) {
        $(el).addClass('checklist-item');
        if (/^(\[\s*[xX✓✔]\s*\]|☑|✅)/.test(text)) {
          $(el).addClass('checked');
        }
      }
    });

    // Google Docs sometimes uses role="checkbox" on list items
    $('li[role="checkbox"]').each((_i, el) => {
      $(el).addClass('checklist-item');
      if ($(el).attr('aria-checked') === 'true') {
        $(el).addClass('checked');
      }
    });

    // Remove empty paragraphs at the start/end of sections to reduce whitespace
    $('body > p').each((_i, el) => {
      const text = $(el).text().trim();
      const hasImage = $(el).find('img').length > 0;
      if (!text && !hasImage) $(el).remove();
    });

    return $('body').html() ?? html;
  } catch {
    return html;
  }
}

async function htmlToJsonContent(html: string): Promise<JSONContent> {
  const bodyHtml = extractBodyHtml(html);
  if (!bodyHtml.trim()) return DEFAULT_REGLAMENT_CONTENT;
  const normalized = await normalizeGoogleDocsHtml(`<body>${bodyHtml}</body>`);

  try {
    let json = generateJSON(normalized, REGLAMENT_IMPORT_EXTENSIONS);
    if (json?.type === 'doc' && json?.content?.length) {
      json = wrapSectionsInBlocks(json as JSONContent) as typeof json;
      return json as JSONContent;
    }
  } catch (err) {
    console.error('reglament import html parse error', err);
  }
  return DEFAULT_REGLAMENT_CONTENT;
}

export async function POST(req: NextRequest) {
  try {
    const token = getBearerToken(req.headers.get('authorization'));
    if (!token) return jsonError('Unauthorized', 401);

    const supabase = createAuthedSupabaseClient(token);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return jsonError('Unauthorized', 401);

    if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .single();
    const role = (profile?.role ?? null) as UserRole | null;
    if (!isAdmin(role)) return jsonError('Forbidden', 403);

    let body: { url?: string; documentId?: string };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonError('Invalid JSON body', 400);
    }

    const urlOrId = body.url?.trim() ?? body.documentId?.trim() ?? '';
    const documentId = extractDocumentId(urlOrId);
    if (!documentId) {
      return jsonError(
        'Укажите ссылку на Google Doc (например: https://docs.google.com/document/d/ID/edit) или ID документа',
        400
      );
    }

    let html: string;
    try {
      html = await fetchHtmlViaExportUrl(documentId);
    } catch (exportErr) {
      const msg = exportErr instanceof Error ? exportErr.message : 'Не удалось загрузить документ';
      const driveHtml = await fetchHtmlViaDriveApi(documentId);
      if (driveHtml) {
        html = driveHtml;
      } else {
        return jsonError(msg, 400);
      }
    }

    const title = extractTitleFromHtml(html);
    const content = await htmlToJsonContent(html);

    const now = new Date().toISOString();
    const baseSlug = createReglamentSlug(title) || 'document';
    const slug = `${baseSlug}-${Date.now()}`;

    const { data: inserted, error: insertError } = await supabaseAdmin
      .from('reglament_documents')
      .insert({
        title,
        slug,
        status: 'draft',
        content,
        created_at: now,
        updated_at: now,
      })
      .select('id')
      .single();

    if (insertError || !inserted) {
      console.error('reglament import insert failed', insertError);
      return jsonError(insertError?.message ?? 'Не удалось создать документ', 500);
    }

    return NextResponse.json({
      id: inserted.id,
      title,
      slug,
      redirectUrl: `/admin/reglament/${inserted.id}`,
    });
  } catch (err) {
    console.error('reglament import-google-doc failed', err);
    const message = err instanceof Error ? err.message : 'Ошибка при импорте';
    return jsonError(message, 500);
  }
}
