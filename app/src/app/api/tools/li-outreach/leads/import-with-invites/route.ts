/**
 * Импорт CSV с персонализированными инвайтами.
 *
 * В отличие от обычного `/leads/import`, здесь ожидается узкий формат с двумя
 * колонками: `LinkedIn ID` (имя/идентификатор лида) и `Invite` (готовый текст
 * инвайта для этого конкретного лида). На каждый импорт автоматически
 * создаётся новый список лидов с `has_custom_invites=true` — это нужно UI'ю,
 * чтобы понять, что у выбранного списка есть колонка `invite_text` и можно
 * показать тумблер `use_custom_invites` в редакторе кампании.
 *
 * Архитектурное решение: новый эндпоинт вместо расширения старого.
 *   Обычный `/leads/import` дедуплицирует уже-контактированных лидов и
 *   делит CSV по имени/компании. Для «CSV с инвайтами» эти эвристики не
 *   применимы: 1) лид однозначно идентифицируется по тексту инвайта, не по
 *   public_identifier, 2) лист с инвайтами всегда создаётся новый (нельзя
 *   доливать в обычный лист — он перестанет соответствовать своему имени).
 *   Поэтому проще иметь отдельный route, чем флагом ветвить логику.
 */

import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

/**
 * Парсер CSV-строки, повторяющий тот, что в `/leads/import/route.ts`. Держим
 * локальную копию, чтобы не плодить shared-модулей ради 30 строк — у двух
 * импортов разные форматы и логически они независимы.
 */
function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

function findHeaderIndex(headers: string[], aliases: string[]): number {
  for (const alias of aliases) {
    const idx = headers.indexOf(alias);
    if (idx >= 0) return idx;
  }
  return -1;
}

export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.li-outreach.leads.import-with-invites' },
    async () => {
      const auth = await authenticateRequest(req.headers.get('authorization'));
      if ('error' in auth) return auth.error;

      const formData = await req.formData();
      const file = formData.get('file') as File | null;
      const listNameRaw = formData.get('list_name') as string | null;
      if (!file) return jsonError('No file provided', 400);

      const text = await file.text();
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length < 2) {
        return jsonError('CSV должен содержать строку заголовков и хотя бы одну строку данных', 400);
      }

      const headerFields = parseCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, '_'));
      // «LinkedIn ID» в этом формате — это имя/идентификатор лида (то, что
      // видно на экране создателя CSV). На LinkedIn ID лида в API-смысле
      // (provider_id / public_identifier) этот столбец не маппится — здесь
      // важен только текст инвайта, остальное доберётся скрапером.
      const nameIdx = findHeaderIndex(headerFields, ['linkedin_id', 'name', 'lead', 'имя']);
      const inviteIdx = findHeaderIndex(headerFields, ['invite', 'invite_text', 'инвайт', 'message']);
      if (nameIdx < 0 || inviteIdx < 0) {
        return jsonError(
          'CSV должен содержать колонки «LinkedIn ID» (имя лида) и «Invite» (текст инвайта)',
          400,
        );
      }
      // Опциональные дополнительные поля — если в файле есть, подхватим.
      // Иначе по сравнению с обычным импортом тут минимум данных, и это ок.
      const positionIdx = findHeaderIndex(headerFields, ['position', 'title', 'должность']);
      const companyIdx = findHeaderIndex(headerFields, ['company', 'компания']);
      const profileUrlIdx = findHeaderIndex(headerFields, [
        'profile_url', 'linkedin_url', 'linkedin_profile_url', 'linkedin_profile',
        'linkedin', 'linkedin_link', 'url', 'profile',
      ]);
      const publicIdIdx = findHeaderIndex(headerFields, [
        'public_identifier', 'public_id', 'linkedin_public_identifier',
      ]);

      const leadsToInsert: Record<string, unknown>[] = [];
      const skipped: string[] = [];

      for (let i = 1; i < lines.length; i++) {
        const fields = parseCsvLine(lines[i]);
        if (fields.length === 0 || fields.every((f) => !f)) continue;
        const val = (idx: number) => (idx >= 0 && idx < fields.length ? fields[idx] : '');

        const name = val(nameIdx);
        const inviteText = val(inviteIdx);
        if (!name) { skipped.push(`Строка ${i + 1}: пустое имя`); continue; }
        if (!inviteText) { skipped.push(`Строка ${i + 1}: пустой текст инвайта`); continue; }

        leadsToInsert.push({
          user_id: auth.user.id,
          // lead_list_id проставим ниже, после создания списка
          name,
          position: val(positionIdx) || null,
          company: val(companyIdx) || null,
          profile_url: val(profileUrlIdx) || null,
          public_identifier: val(publicIdIdx) || null,
          invite_text: inviteText,
          status: 'new',
        });
      }

      if (leadsToInsert.length === 0) {
        return NextResponse.json({
          imported: 0,
          skipped: skipped.length,
          errors: skipped,
          lead_list: null,
        });
      }

      // Имя списка: либо то, что пришло из формы, либо derived из имени
      // файла (без расширения). Если совсем ничего — fallback на дату.
      const fallbackName = (file.name || '').replace(/\.[^.]+$/, '').trim()
        || `Инвайты ${new Date().toISOString().slice(0, 10)}`;
      const listName = (listNameRaw?.trim() || fallbackName).slice(0, 200);

      const { data: leadList, error: listError } = await auth.supabase
        .from('li_lead_lists')
        .insert({
          user_id: auth.user.id,
          name: listName,
          description: `Импорт CSV с персонализированными инвайтами (${leadsToInsert.length} лидов)`,
          has_custom_invites: true,
        })
        .select()
        .single();
      if (listError || !leadList) {
        return jsonError(`Не удалось создать список лидов: ${listError?.message}`, 500);
      }

      // Привязываем все лиды к только что созданному списку.
      for (const lead of leadsToInsert) lead.lead_list_id = leadList.id;

      const BATCH = 200;
      let imported = 0;
      for (let i = 0; i < leadsToInsert.length; i += BATCH) {
        const batch = leadsToInsert.slice(i, i + BATCH);
        const { error } = await auth.supabase.from('li_leads').insert(batch);
        if (error) {
          // Если упали посередине — оставляем уже залитые лиды + список, чтобы
          // пользователь видел частичный результат и мог разобраться. Полный
          // rollback потребовал бы транзакции, которой у supabase-js нет.
          return jsonError(
            `Ошибка импорта на строке ~${i + 2}: ${error.message}. Импортировано ${imported} лидов, остальные пропущены.`,
            500,
          );
        }
        imported += batch.length;
      }

      return NextResponse.json({
        imported,
        skipped: skipped.length,
        total_rows: lines.length - 1,
        lead_list: leadList,
      });
    },
  );
}
