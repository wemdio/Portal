import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/liOutreach/apiHelpers';
import { extractPublicIdentifier } from '@/lib/liOutreach/leadHelpers';
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

function findHeaderIndex(headers: string[], aliases: string[]): number {
  for (const alias of aliases) {
    const idx = headers.indexOf(alias);
    if (idx >= 0) return idx;
  }
  return -1;
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
    const profileUrlIdx = findHeaderIndex(headerFields, [
      'profile_url',
      'linkedin_url',
      'linkedin_profile_url',
      'linkedin_profile',
      'linkedin',
      'linkedin_link',
      'url',
      'profile',
    ]);
    const publicIdIdx = findHeaderIndex(headerFields, ['public_identifier', 'public_id', 'linkedin_public_identifier']);
    const linkedinIdIdx = findHeaderIndex(headerFields, ['linkedin_id', 'provider_id']);

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

      const publicIdentifier = val(publicIdIdx) || extractPublicIdentifier(profileUrl);
      const linkedinId = val(linkedinIdIdx) || null;
      if (!linkedinId && !publicIdentifier && !profileUrl) {
        skipped.push(`Row ${i + 1}: no LinkedIn profile URL / public_identifier / provider_id`);
        continue;
      }

      leadsToInsert.push({
        user_id: auth.user.id,
        lead_list_id: listId || null,
        linkedin_id: linkedinId,
        name,
        first_name: firstName || null,
        last_name: lastName || null,
        position: val(positionIdx) || null,
        company: val(companyIdx) || null,
        profile_url: profileUrl || null,
        public_identifier: publicIdentifier || null,
        status: 'new',
      });
    }

    if (leadsToInsert.length === 0) {
      return NextResponse.json({ imported: 0, skipped: skipped.length, errors: skipped });
    }

    // --- Dedup -----------------------------------------------------------------
    // 1) Drop exact duplicates WITHIN the uploaded file (same public_id /
    //    linkedin_id / profile_url twice) — always, cheap.
    const seenInFile = new Set<string>();
    const fileDeduped: Record<string, unknown>[] = [];
    let dupInFile = 0;
    for (const lead of leadsToInsert) {
      const key = String(lead.public_identifier || lead.linkedin_id || lead.profile_url || '').toLowerCase();
      if (key && seenInFile.has(key)) { dupInFile++; continue; }
      if (key) seenInFile.add(key);
      fileDeduped.push(lead);
    }

    // 2) Skip people THIS USER has already contacted (any list/campaign). Re-importing
    //    them is the root cause of "залил новую базу, а 0 нового охвата": LinkedIn
    //    returns already_invited and no new invite goes out. We skip at import so the
    //    operator sees "N новых, M уже контактированы" up front instead of discovering
    //    it days later. NOTE: dedup is per-user (not per-account) — for a multi-account
    //    user who legitimately wants to re-contact someone from a DIFFERENT account,
    //    pass dedup=false. Default on.
    const dedup = (formData.get('dedup') as string | null) !== 'false';
    const CONTACTED_STATUSES = ['invited', 'already_invited', 'messaged', 'connected', 'replied'];
    let alreadyContacted = 0;
    let toInsert = fileDeduped;

    if (dedup) {
      const pids = [...new Set(fileDeduped.map((l) => l.public_identifier).filter(Boolean) as string[])];
      const lids = [...new Set(fileDeduped.map((l) => l.linkedin_id).filter(Boolean) as string[])];
      const contactedPids = new Set<string>();
      const contactedLids = new Set<string>();
      const CHUNK = 200;
      for (let i = 0; i < pids.length; i += CHUNK) {
        const { data } = await auth.supabase
          .from('li_leads')
          .select('public_identifier')
          .eq('user_id', auth.user.id)
          .in('status', CONTACTED_STATUSES)
          .in('public_identifier', pids.slice(i, i + CHUNK));
        for (const r of (data ?? []) as Array<{ public_identifier: string | null }>) {
          if (r.public_identifier) contactedPids.add(r.public_identifier);
        }
      }
      for (let i = 0; i < lids.length; i += CHUNK) {
        const { data } = await auth.supabase
          .from('li_leads')
          .select('linkedin_id')
          .eq('user_id', auth.user.id)
          .in('status', CONTACTED_STATUSES)
          .in('linkedin_id', lids.slice(i, i + CHUNK));
        for (const r of (data ?? []) as Array<{ linkedin_id: string | null }>) {
          if (r.linkedin_id) contactedLids.add(r.linkedin_id);
        }
      }
      toInsert = fileDeduped.filter((l) => {
        const pid = l.public_identifier ? String(l.public_identifier) : '';
        const lid = l.linkedin_id ? String(l.linkedin_id) : '';
        const contacted = (pid && contactedPids.has(pid)) || (lid && contactedLids.has(lid));
        if (contacted) alreadyContacted++;
        return !contacted;
      });
    }

    const result = {
      skipped: skipped.length,
      already_contacted_skipped: alreadyContacted,
      dup_in_file_skipped: dupInFile,
      total_rows: lines.length - 1,
    };

    if (toInsert.length === 0) {
      return NextResponse.json({ imported: 0, ...result });
    }

    const BATCH = 200;
    let imported = 0;
    for (let i = 0; i < toInsert.length; i += BATCH) {
      const batch = toInsert.slice(i, i + BATCH);
      const { error } = await auth.supabase.from('li_leads').insert(batch);
      if (error) {
        return jsonError(`Import error at row ~${i + 2}: ${error.message}`, 500);
      }
      imported += batch.length;
    }

    return NextResponse.json({ imported, ...result });
  });
}
