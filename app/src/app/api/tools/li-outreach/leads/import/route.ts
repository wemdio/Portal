import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

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

export async function POST(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.li-outreach.leads.import' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;

    const formData = await req.formData();
    const file = formData.get('file') as File | null;
    const listId = formData.get('lead_list_id') as string | null;

    if (!file) return jsonError('No file provided', 400);

    const text = await file.text();
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return jsonError('CSV must have a header row and at least one data row', 400);

    const headerFields = parseCsvLine(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, '_'));
    const nameIdx = headerFields.indexOf('name');
    const firstNameIdx = headerFields.indexOf('first_name');
    const lastNameIdx = headerFields.indexOf('last_name');
    const positionIdx = headerFields.indexOf('position');
    const companyIdx = headerFields.indexOf('company');
    const profileUrlIdx = headerFields.indexOf('profile_url');
    const publicIdIdx = headerFields.indexOf('public_identifier');

    const leadsToInsert: Record<string, unknown>[] = [];
    const skipped: string[] = [];

    for (let i = 1; i < lines.length; i++) {
      const fields = parseCsvLine(lines[i]);
      if (fields.length === 0 || fields.every((f) => !f)) continue;

      const val = (idx: number) => (idx >= 0 && idx < fields.length ? fields[idx] : '');

      let name = val(nameIdx);
      const firstName = val(firstNameIdx);
      const lastName = val(lastNameIdx);
      const profileUrl = val(profileUrlIdx);

      if (!name && (firstName || lastName)) {
        name = `${firstName} ${lastName}`.trim();
      }
      if (!name) {
        skipped.push(`Row ${i + 1}: no name`);
        continue;
      }

      leadsToInsert.push({
        user_id: auth.user.id,
        lead_list_id: listId || null,
        name,
        first_name: firstName || null,
        last_name: lastName || null,
        position: val(positionIdx) || null,
        company: val(companyIdx) || null,
        profile_url: profileUrl || null,
        public_identifier: val(publicIdIdx) || null,
        status: 'new',
      });
    }

    if (leadsToInsert.length === 0) {
      return NextResponse.json({ imported: 0, skipped: skipped.length, errors: skipped });
    }

    const BATCH = 200;
    let imported = 0;
    for (let i = 0; i < leadsToInsert.length; i += BATCH) {
      const batch = leadsToInsert.slice(i, i + BATCH);
      const { error } = await auth.supabase.from('li_leads').insert(batch);
      if (error) {
        return jsonError(`Import error at row ~${i + 2}: ${error.message}`, 500);
      }
      imported += batch.length;
    }

    return NextResponse.json({ imported, skipped: skipped.length, total_rows: lines.length - 1 });
  });
}
