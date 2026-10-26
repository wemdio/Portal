import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isInternalUser } from '@/lib/auth/internalGuard';
import { withToolTrace } from '@/lib/toolTrace';

const admin = supabaseAdmin!;

/** Предел таблицы: база кампании «Рассылки» укладывается с запасом, мусор в базу не пустим. */
const MAX_ROWS = 200_000;
const MAX_COLUMNS = 200;

/**
 * POST — положить готовую таблицу в конструктор баз без обработки: задача сразу
 * «завершена», без шагов, воркер её не берёт. Так база из «Рассылки» открывается
 * в конструкторе, как любая обработанная.
 *
 * Только сотрудники (аудит 26.10.2026): путь лежит в клиентском разделе
 * middleware, и без проверки любой клиент складывал бы в базу таблицы любого
 * размера в обход тарифа. Зовёт его только окно получателей «Рассылки».
 */
export async function POST(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.base-constructor.import' }, async () => {
    const token = req.headers.get('authorization')?.replace('Bearer ', '');
    if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const { data: auth } = await admin.auth.getUser(token);
    const user = auth.user;
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    if (!(await isInternalUser(admin, user.id))) {
      return NextResponse.json({ error: 'Доступ только для сотрудников' }, { status: 403 });
    }

    let body: { data?: unknown; file_name?: unknown };
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Тело запроса должно быть JSON' }, { status: 400 });
    }
    const { data, file_name } = body;
    if (!Array.isArray(data) || data.length < 2 || !data.every((row) => Array.isArray(row))) {
      return NextResponse.json({ error: 'Нужна таблица: заголовок и хотя бы одна строка' }, { status: 400 });
    }
    if (data.length - 1 > MAX_ROWS || data.some((row) => (row as unknown[]).length > MAX_COLUMNS)) {
      return NextResponse.json(
        { error: `Таблица больше допустимого: до ${MAX_ROWS.toLocaleString('ru-RU')} строк и ${MAX_COLUMNS} колонок` },
        { status: 413 },
      );
    }

    const now = new Date().toISOString();
    const rows = data.length - 1;
    const { data: job, error } = await admin
      .from('base_constructor_jobs')
      .insert({
        user_id: user.id,
        workload_origin: 'manual',
        file_name: typeof file_name === 'string' && file_name ? file_name.slice(0, 200) : null,
        data,
        status: 'completed',
        selected_steps: [],
        step_config: {},
        current_step: 0,
        current_step_key: 'done',
        current_step_progress: 100,
        total_steps: 0,
        initial_row_count: rows,
        started_at: now,
        completed_at: now,
        result_stats: { total_rows: rows, columns: (data[0] as unknown[]).length },
      })
      .select('id')
      .single();
    if (error || !job) {
      return NextResponse.json({ error: error?.message || 'Не удалось создать базу' }, { status: 500 });
    }
    return NextResponse.json({ id: job.id as string });
  });
}
