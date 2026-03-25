import { NextRequest, NextResponse } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { sqliteBufferToSessionString } from '@/lib/telegram/sessionUtils';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function basename(filename: string): string {
  return filename.replace(/\.(json|session)$/i, '') || filename;
}

function toText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

interface ParsedAccount {
  api_id: number;
  api_hash: string;
  phone: string;
  session_string: string;
  name: string;
  proxy_url: string;
}

function parseAccountJson(text: string): ParsedAccount[] {
  const parsed = JSON.parse(text) as unknown;
  const items = Array.isArray(parsed) ? parsed : [parsed];
  return items
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    .map((raw) => ({
      api_id: Number(raw.api_id) || 0,
      api_hash: toText(raw.api_hash),
      phone: toText(raw.phone),
      session_string: toText(raw.session_string) || toText(raw.session_data),
      name: toText(raw.name) || toText(raw.session_name),
      proxy_url: toText(raw.proxy_url) || toText(raw.proxy),
    }));
}

export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-parser.accounts.bulk-files.post' },
    async () => {
      const token = getBearerToken(req.headers.get('authorization'));
      if (!token) return jsonError('Unauthorized', 401);

      const supabase = createAuthedSupabaseClient(token);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return jsonError('Unauthorized', 401);

      const formData = await req.formData();
      const files = formData.getAll('files') as File[];
      if (!files.length) {
        return jsonError('Добавьте файлы с аккаунтами (.json + .session)', 400);
      }

      const byBase = new Map<string, { json?: string; session?: ArrayBuffer }>();
      for (const file of files) {
        const name = file.name.trim();
        const base = basename(name);
        const entry = byBase.get(base) ?? {};
        if (name.toLowerCase().endsWith('.json')) {
          entry.json = await file.text();
        } else if (name.toLowerCase().endsWith('.session')) {
          entry.session = await file.arrayBuffer();
        }
        byBase.set(base, entry);
      }

      const rows: Array<{
        user_id: string;
        name: string;
        api_id: number;
        api_hash: string;
        phone: string;
        session_data: string;
        proxy_url: string;
        is_active: boolean;
      }>[] = [];
      const errors: string[] = [];

      for (const [base, item] of byBase) {
        if (!item.json) {
          if (item.session) {
            errors.push(`${base}.session: нет парного .json файла с api_id/api_hash`);
          }
          continue;
        }

        let accounts: ParsedAccount[];
        try {
          accounts = parseAccountJson(item.json);
        } catch (err) {
          const msg = err instanceof Error ? err.message : 'Неверный JSON';
          return jsonError(`Ошибка в ${base}.json: ${msg}`, 400);
        }

        for (let i = 0; i < accounts.length; i++) {
          const acc = accounts[i];
          if (!acc.api_id || !acc.api_hash) {
            errors.push(`${base}.json[${i}]: отсутствует api_id или api_hash`);
            continue;
          }

          let sessionData = acc.session_string;

          if (i === 0 && item.session && !sessionData) {
            try {
              sessionData = await sqliteBufferToSessionString(item.session);
            } catch (err) {
              const msg = err instanceof Error ? err.message : 'Ошибка чтения';
              errors.push(`${base}.session: ${msg}`);
            }
          }

          rows.push({
            user_id: user.id,
            name: acc.name || `${base} ${accounts.length > 1 ? `#${i + 1}` : ''}`.trim(),
            api_id: acc.api_id,
            api_hash: acc.api_hash,
            phone: acc.phone,
            session_data: sessionData,
            proxy_url: acc.proxy_url,
            is_active: true,
          });
        }
      }

      if (!rows.length) {
        return jsonError(
          errors.length
            ? `Не найдено валидных аккаунтов. ${errors.join('; ')}`
            : 'Не найдено валидных JSON файлов с аккаунтами',
          400,
        );
      }

      const { data, error } = await supabase
        .from('tg_parser_accounts')
        .insert(rows)
        .select('id, name, api_id, api_hash, phone, proxy_url, is_active, created_at');

      if (error) return jsonError(error.message, 500);

      return NextResponse.json({
        items: data ?? [],
        count: data?.length ?? 0,
        warnings: errors.length ? errors : undefined,
      }, { status: 201 });
    },
  );
}
