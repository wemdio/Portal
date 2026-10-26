import { NextResponse } from 'next/server';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { ManualEntryDeal, ManualEntryProject } from '@/lib/expenses/types';

/**
 * Серверная часть ручного ввода раздела «Деньги» — общая у расхода
 * (`manual_expenses`) и дохода (`manual_incomes`).
 */

export type ManualTable = 'manual_expenses' | 'manual_incomes';

export const MANUAL_EXPENSE_FIELDS =
  'id, occurred_on, amount, currency, payer, comment, project_id, amo_deal_id, created_by, created_at';

export const MANUAL_INCOME_FIELDS =
  'id, occurred_on, amount, currency, payer, channel, comment, project_id, amo_deal_id, created_by, created_at';

const AMO_BASE = (process.env.AMO_BASE_URL ?? '').replace(/\/$/, '');

/**
 * Править и удалять может автор записи либо админ. Ручной ввод без правки
 * превращается в append-only свалку: опечатку в сумме иначе можно починить
 * только SQL-запросом, то есть на практике никогда.
 *
 * Возвращает готовый ответ с ошибкой или `null`, если менять можно.
 */
export async function checkManualOwner(
  table: ManualTable,
  id: string,
  userId: string,
  role: string | null,
): Promise<NextResponse | null> {
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const { data, error } = await supabaseAdmin.from(table).select('created_by').eq('id', id).maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: 'Запись не найдена' }, { status: 404 });
  if (data.created_by !== userId && role !== 'admin') {
    return NextResponse.json({ error: 'Можно менять только свои записи' }, { status: 403 });
  }
  return null;
}

/**
 * Несуществующий проект ловит внешний ключ; без перевода человек увидел бы
 * текст Postgres про `manual_incomes_project_id_fkey`.
 */
export function humanizeManualError(message: string): string {
  if (/project_id_fkey/.test(message)) return 'Проект не найден — возможно, его удалили';
  return message;
}

type LinkedRow = { project_id: string | null; amo_deal_id: number | string | null };

/**
 * Подписи проекта и сделки к ручным записям.
 *
 * В записи хранятся только ссылки (`project_id`, `amo_deal_id`), названия
 * берутся на чтении: переименованный проект или сделка не должны оставаться в
 * списке под старым именем.
 */
export async function attachLinks<T extends LinkedRow>(
  rows: T[],
): Promise<Array<Omit<T, keyof LinkedRow> & { project: ManualEntryProject | null; deal: ManualEntryDeal | null }>> {
  if (!supabaseAdmin) throw new Error('Server misconfigured');

  const projectIds = [...new Set(rows.map((r) => r.project_id).filter((v): v is string => Boolean(v)))];
  const dealIds = [...new Set(rows.map((r) => r.amo_deal_id).filter((v) => v !== null).map(Number))];

  const [projectsRes, dealsRes] = await Promise.all([
    projectIds.length
      ? supabaseAdmin.from('projects').select('id, name').in('id', projectIds)
      : Promise.resolve({ data: [], error: null }),
    dealIds.length
      ? supabaseAdmin.from('amo_leads').select('amo_id, name').in('amo_id', dealIds)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (projectsRes.error) throw new Error(`projects: ${projectsRes.error.message}`);
  if (dealsRes.error) throw new Error(`amo_leads: ${dealsRes.error.message}`);

  const projectName = new Map((projectsRes.data ?? []).map((p) => [String(p.id), String(p.name)]));
  const dealName = new Map(
    (dealsRes.data ?? []).map((d) => [Number(d.amo_id), (d.name as string | null) ?? null]),
  );

  return rows.map(({ project_id, amo_deal_id, ...rest }) => {
    const amoId = amo_deal_id === null ? null : Number(amo_deal_id);
    return {
      ...rest,
      // Проект удалён — FK сам обнулит ссылку, но до того записи без имени
      // показывать нечего.
      project: project_id && projectName.has(project_id)
        ? { id: project_id, name: projectName.get(project_id) as string }
        : null,
      deal: amoId === null
        ? null
        : {
            amoId,
            name: dealName.get(amoId) ?? null,
            url: AMO_BASE ? `${AMO_BASE}/leads/detail/${amoId}` : null,
          },
    };
  });
}
