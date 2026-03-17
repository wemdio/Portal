import { normalizeInn } from '@/lib/cisLeads/lprRole';

function normalizeHeaderKey(key: string): string {
  return String(key ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r/g, ' ')
    .replace(/\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function pickFromRow(row: Record<string, unknown>, candidates: string[]): string {
  const keys = Object.keys(row);
  const normalizedToActual = new Map<string, string>();
  for (const k of keys) normalizedToActual.set(normalizeHeaderKey(k), k);

  for (const c of candidates) {
    const actual = normalizedToActual.get(normalizeHeaderKey(c));
    if (actual) {
      const v = row[actual];
      const s = String(v ?? '').trim();
      if (s) return s;
    }
  }
  return '';
}

function extractInnFromText(value: string): string | null {
  if (!value) return null;
  const match = value.match(/(?:^|[^0-9])(\d{10}|\d{12})(?:$|[^0-9])/);
  if (match?.[1]) return match[1];
  const digits = value.replace(/\D/g, '');
  return normalizeInn(digits);
}

export function extractInnFromRow(row: Record<string, unknown>): string | null {
  const rawInn = pickFromRow(row, [
    'инн',
    'inn',
    'инн компании',
    'инн организация',
    'инн организации',
    'инн (организации)',
    'инн (компании)',
    'inn company',
    'inn number',
    'tax id',
    'tax_id',
    'tin',
    'инн/кпп',
    'inn/kpp',
  ]);
  const inn = normalizeInn(rawInn);
  if (inn) return inn;

  for (const value of Object.values(row)) {
    const extracted = extractInnFromText(String(value ?? '').trim());
    if (extracted) return extracted;
  }
  return null;
}

export function extractLeadFields(row: Record<string, unknown>) {
  const raw_inn = extractInnFromRow(row);
  const raw_company_name = pickFromRow(row, [
    'компания',
    'название',
    'краткое название',
    'наименование',
    'наименование организации',
    'company',
    'company_name',
    'organization',
    'организация',
  ]);
  const raw_site = pickFromRow(row, ['сайт', 'site', 'website', 'домен', 'domain']);
  const raw_city = pickFromRow(row, ['город', 'city']);
  const raw_region = pickFromRow(row, ['регион', 'область', 'region']);
  const raw_phone = pickFromRow(row, ['телефон', 'телефоны', 'phone', 'номер', 'mobile', 'тел', 'тел.']);
  const raw_email = pickFromRow(row, ['email', 'e-mail', 'почта', 'почта компании']);
  const raw_contact_name = pickFromRow(row, ['контакт', 'контактное лицо', 'фио', 'name', 'contact_name']);
  const raw_position = pickFromRow(row, ['должность', 'позиция', 'position', 'title']);
  const raw_notes = pickFromRow(row, ['комментарий', 'notes', 'note', 'примечание']);

  return {
    raw_inn,
    raw_company_name,
    raw_site,
    raw_city,
    raw_region,
    raw_phone,
    raw_email,
    raw_contact_name,
    raw_position,
    raw_notes,
  };
}
