import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';
import { parseBaseRows } from '@/lib/tgOutreach/firstTouch/parseBaseFile';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** Больше за раз не принимаем: одна гипотеза — это порядка 300 контактов. */
const MAX_CONTACTS = 5000;

export async function POST(req: NextRequest, ctx: Ctx) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-outreach.bases.upload.post' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;
      const { id } = await ctx.params;

      const { data: base } = await auth.supabase
        .from('tg_outreach_bases')
        .select('id')
        .eq('id', id)
        .maybeSingle();
      if (!base) return jsonError('База не найдена', 404);

      const form = await req.formData();
      const file = form.get('file') as File | null;
      if (!file) return jsonError('Добавьте файл с контактами', 400);

      let rows: unknown[][];
      try {
        const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        // header: 1 — читаем как массив массивов: заголовок распознаёт parseBaseRows,
        // и делает это по содержимому первой ячейки, а не по вере в него.
        rows = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });
      } catch (e) {
        return jsonError(`Не смог прочитать файл: ${e instanceof Error ? e.message : String(e)}`, 400);
      }

      const parsed = parseBaseRows(rows);
      if (!parsed.contacts.length) {
        return jsonError('В файле нет ни одной пригодной строки: нужны юзернейм в первой колонке и текст во второй', 400);
      }
      if (parsed.contacts.length > MAX_CONTACTS) {
        return jsonError(`Слишком много контактов: ${parsed.contacts.length}, максимум ${MAX_CONTACTS}`, 400);
      }

      // upsert по (base_id, username): повторная загрузка того же файла не
      // плодит дубли и не сбрасывает статусы уже отправленных.
      const { error } = await auth.supabase.from('tg_outreach_base_contacts').upsert(
        parsed.contacts.map((c) => ({
          base_id: id,
          username: c.username,
          message: c.message,
          raw: c.raw,
        })),
        { onConflict: 'base_id,username', ignoreDuplicates: true },
      );
      if (error) return jsonError(error.message, 500);

      return NextResponse.json({ stats: parsed.stats, headers: parsed.headers }, { status: 201 });
    },
  );
}
