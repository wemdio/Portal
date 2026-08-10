import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { sqliteBufferToSessionString } from '@/lib/telegram/sessionUtils';
import {
  collectTdataCandidates,
  splitExistingAccounts,
  type TdataSkip,
  type TdataError,
  type TdataUpload,
} from '@/lib/tgOutreach/tdataImport';

export const dynamic = 'force-dynamic';

const BUCKET = 'tg-outreach-sessions';

function basename(filename: string): string {
  const name = filename.replace(/\.(json|session)$/i, '');
  return name || filename;
}

/** Parse one account from object (NewPortalServ format): session_file, phone, api_id, api_hash, ... */
function parseAccountObj(a: Record<string, unknown>): { session_name: string; api_id: number; api_hash: string; phone: string } {
  const sessionName =
    (a.session_name as string)?.trim() ||
    (a.session_file as string)?.trim() ||
    (a.phone as string)?.trim() ||
    '';
  const apiId = Number(a.api_id);
  const apiHash = (a.api_hash as string)?.trim() || '';
  const phone = ((a.phone as string) ?? '').trim();
  if (!sessionName || !apiId || !apiHash) {
    throw new Error('Нужны session_file/phone, api_id и api_hash');
  }
  return { session_name: sessionName, api_id: apiId, api_hash: apiHash, phone };
}

function parseAccountJson(text: string): { session_name: string; api_id: number; api_hash: string; phone: string }[] {
  const data = JSON.parse(text) as unknown;
  if (Array.isArray(data)) {
    return data.map((item, _i) => {
      const a = item as Record<string, unknown>;
      return parseAccountObj(a);
    });
  }
  return [parseAccountObj(data as Record<string, unknown>)];
}

/**
 * Отдавать архивы по одному, а не складывать всю партию в память.
 *
 * Настоящий архив продавца весит килобайты, но оператор выбирает пачку
 * целиком, а в полной папке Telegram Desktop лежат гигабайты кэша — и
 * `unzipper` берёт архив только целым буфером. Читая по одному, держим в
 * памяти текущий архив, а не сумму всех.
 */
async function* bufferOneByOne(files: File[]): AsyncGenerator<TdataUpload> {
  for (const file of files) {
    yield { name: file.name, buffer: Buffer.from(await file.arrayBuffer()) };
  }
}

export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.accounts.bulk-files.post' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;

      const campaignId = new URL(req.url).searchParams.get('campaign_id');
      if (!campaignId) return jsonError('campaign_id обязателен (query)', 400);

      const formData = await req.formData();
      const files = formData.getAll('files') as File[];
      if (!files?.length) return jsonError('Добавьте файлы (JSON и/или .session)', 400);

      const zipFiles = files.filter((f) => f.name.toLowerCase().endsWith('.zip'));
      const plainFiles = files.filter((f) => !f.name.toLowerCase().endsWith('.zip'));

      const byBase = new Map<string, { json?: string; session?: ArrayBuffer }>();
      for (const file of plainFiles) {
        const name = file.name.trim();
        const base = basename(name);
        if (!base) continue;
        const ext = name.toLowerCase().endsWith('.session') ? 'session' : name.toLowerCase().endsWith('.json') ? 'json' : null;
        if (!ext) continue;
        const existing = byBase.get(base) ?? {};
        if (ext === 'json') {
          existing.json = await file.text();
        } else {
          existing.session = await file.arrayBuffer();
        }
        byBase.set(base, existing);
      }

      const ordered: Array<{ base: string; acc: { session_name: string; api_id: number; api_hash: string; phone: string }; sessionBuf?: ArrayBuffer }> = [];

      for (const [base, data] of byBase) {
        if (!data.json) continue;
        try {
          const accounts = parseAccountJson(data.json);
          for (let i = 0; i < accounts.length; i++) {
            const sessionBuf = i === 0 ? data.session : undefined;
            ordered.push({ base: accounts.length > 1 ? `${base}_${i}` : base, acc: accounts[i], sessionBuf });
          }
        } catch (e) {
          return jsonError(`Файл ${base}.json: ${e instanceof Error ? e.message : String(e)}`, 400);
        }
      }

      if (ordered.length === 0 && zipFiles.length === 0) {
        return jsonError('Нет валидных JSON-файлов с аккаунтами', 400);
      }

      // Verify campaign belongs to the authenticated user before inserting
      const { data: campaign, error: campaignError } = await auth.supabase
        .from('tg_outreach_campaigns')
        .select('id')
        .eq('id', campaignId)
        .single();

      if (campaignError || !campaign) return jsonError('Кампания не найдена или нет доступа', 403);

      // Клиент для записи объявляем один раз здесь: ниже он же используется
      // при вставке и при загрузке .session в хранилище.
      const db = supabaseAdmin ?? auth.supabase;

      // Аккаунты из tdata: архив читается в память, к Telegram не подключаемся.
      const tdataSkipped: TdataSkip[] = [];
      const tdataErrors: TdataError[] = [];
      let tdataRows: Array<Record<string, unknown>> = [];

      if (zipFiles.length) {
        const collected = await collectTdataCandidates(bufferOneByOne(zipFiles));
        tdataSkipped.push(...collected.skipped);
        tdataErrors.push(...collected.errors);

        if (collected.candidates.length) {
          // Читаем всю таблицу, а не только строки с нужными tg_user_id.
          // Фильтр по id вырезал бы ровно то, ради чего сверка и делается:
          // у аккаунтов, залитых старым путём (.session), tg_user_id пуст,
          // и найти их можно только по ключу авторизации из session_data.
          // Колонки узкие, таблица — внутренний список аккаунтов, так что
          // выборка целиком дешевле пропущенного AUTH_KEY_DUPLICATED.
          const { data: existing, error: existingError } = await db
            .from('tg_outreach_accounts')
            .select('tg_user_id, session_data, tg_outreach_campaigns(name)');

          // Провалившуюся сверку нельзя трактовать как «дублей нет»: тогда тот
          // же ключ авторизации уедет в базу вторым аккаунтом, оба подключения
          // получат AUTH_KEY_DUPLICATED, и Telegram отзовёт сессию — ровно то,
          // от чего эта сверка защищает.
          if (existingError) {
            return jsonError(`Не удалось сверить аккаунты с базой: ${existingError.message}`, 500);
          }

          const existingRows = (existing ?? []).map((row) => {
            const rowCampaign = (row as { tg_outreach_campaigns?: { name?: string } | null })
              .tg_outreach_campaigns;
            // Пустой tg_user_id обязан остаться null: Number(null) даёт 0, и в
            // сверке появился бы несуществующий аккаунт с id 0.
            const rawUserId = (row as { tg_user_id: number | string | null }).tg_user_id;
            return {
              tg_user_id: rawUserId === null || rawUserId === undefined ? null : Number(rawUserId),
              campaign_name: rowCampaign?.name ?? null,
              session_data: (row as { session_data?: string | null }).session_data ?? null,
            };
          });

          const { fresh, skipped } = splitExistingAccounts(collected.candidates, existingRows);
          tdataSkipped.push(...skipped);

          tdataRows = fresh.map((candidate) => ({
            campaign_id: campaignId,
            session_name: candidate.name,
            api_id: candidate.apiId,
            api_hash: candidate.apiHash,
            phone: '',
            proxy_id: null,
            session_data: candidate.sessionString,
            tg_user_id: candidate.tgUserId,
            is_active: true,
          }));
        }
      }

      // Порядок важен: строки из tdata идут в конец, поэтому первые
      // ordered.length вставленных строк по-прежнему соответствуют парам
      // .session/.json — по ним ниже раскладываются файлы в хранилище.
      const insertRows = [
        ...ordered.map(({ acc }) => ({
          campaign_id: campaignId,
          session_name: acc.session_name,
          api_id: acc.api_id,
          api_hash: acc.api_hash,
          phone: acc.phone ?? '',
          proxy_id: null,
          session_data: '',
          is_active: true,
        })),
        ...tdataRows,
      ];

      let inserted: Array<{ id: string; session_name: string }> = [];
      if (insertRows.length) {
        const { data, error: insertError } = await db
          .from('tg_outreach_accounts')
          .insert(insertRows)
          .select('id, session_name');
        if (insertError) return jsonError(insertError.message, 500);
        inserted = data ?? [];
      }

      const sessionConvertErrors: Array<{ base: string; error: string }> = [];
      if (supabaseAdmin) {
        for (let i = 0; i < ordered.length; i++) {
          const { base, sessionBuf } = ordered[i];
          if (!sessionBuf) continue;
          const row = inserted[i];
          if (!row) continue;
          const path = `${campaignId}/${row.id}.session`;
          const { error: uploadErr } = await supabaseAdmin.storage
            .from(BUCKET)
            .upload(path, sessionBuf, { contentType: 'application/octet-stream', upsert: true });
          if (uploadErr) {
            return jsonError(`Не удалось загрузить .session для ${base}: ${uploadErr.message}`, 500);
          }

          // Convert the SQLite blob to a gramJS StringSession and persist it
          // alongside session_file_path. Without this the worker falls back to
          // re-parsing the SQLite every cycle (gramClient.ts), a code path that
          // empirically caused getDialogs to hang for 180s on multi-DC sessions
          // and triggered the per-account degraded auto-disable. A failed
          // conversion is non-fatal: the row keeps session_file_path so the
          // legacy path remains available, and the error is surfaced in the
          // response so the operator can re-upload via the upload-session route.
          let sessionData = '';
          try {
            sessionData = await sqliteBufferToSessionString(sessionBuf);
          } catch (e) {
            sessionConvertErrors.push({
              base,
              error: e instanceof Error ? e.message : String(e),
            });
          }

          await db
            .from('tg_outreach_accounts')
            .update({ session_file_path: path, session_data: sessionData })
            .eq('id', row.id);
        }
      }

      return NextResponse.json(
        {
          items: inserted,
          count: inserted.length,
          ...(tdataSkipped.length ? { skipped: tdataSkipped } : {}),
          ...(tdataErrors.length ? { errors: tdataErrors } : {}),
          ...(sessionConvertErrors.length
            ? { session_convert_errors: sessionConvertErrors }
            : {}),
        },
        { status: 201 },
      );
    },
  );
}
