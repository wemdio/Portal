export function guessRoleFromTitle(title: string | null): { role: string | null; score: number } {
  const t = String(title ?? '').toLowerCase();
  if (!t) return { role: null, score: 0 };

  const rules: Array<{ role: string; score: number; kw: string[] }> = [
    { role: 'owner', score: 80, kw: ['собственник', 'владелец', 'owner', 'founder', 'сооснователь', 'основатель'] },
    { role: 'ceo', score: 75, kw: ['генеральный', 'гендир', 'ceo', 'chief executive', 'президент'] },
    { role: 'commercial', score: 65, kw: ['коммерческ', 'cсо', 'cro', 'директор по продаж', 'sales director'] },
    { role: 'sales', score: 55, kw: ['продаж', 'sales', 'bizdev', 'business development', 'аккаунт', 'account', 'менеджер по работе с клиент'] },
    { role: 'finance', score: 50, kw: ['финанс', 'cfo', 'chief financial', 'бухгалтер', 'главный бухгалтер', 'главбух', 'казначе'] },
    { role: 'marketing', score: 50, kw: ['маркет', 'marketing', 'growth', 'pr', 'brand'] },
    { role: 'procurement', score: 45, kw: ['закуп', 'снабжен', 'procurement', 'purchasing', 'тендер', 'поставк'] },
    { role: 'ops', score: 45, kw: ['операц', 'operations', 'coo', 'логист', 'supply'] },
    { role: 'it', score: 45, kw: ['it', 'cto', 'техн', 'разраб', 'engineering', 'security', 'ciso'] },
    { role: 'legal', score: 40, kw: ['юрист', 'юридическ', 'legal', 'counsel', 'правов'] },
    { role: 'hr', score: 35, kw: ['hr', 'кадр', 'персонал', 'recruit', 'talent'] },
  ];

  for (const r of rules) {
    if (r.kw.some((k) => t.includes(k))) return { role: r.role, score: r.score };
  }
  if (t.includes('директор') || t.includes('head') || t.includes('руководит')) return { role: 'director', score: 40 };
  return { role: 'other', score: 10 };
}

export function isLikelyLpr(title: string | null, role: string | null): boolean {
  const t = String(title ?? '').toLowerCase();
  const r = String(role ?? '').toLowerCase();
  if (['owner', 'ceo', 'commercial', 'director', 'sales', 'marketing', 'it', 'ops', 'hr', 'finance', 'procurement', 'legal'].includes(r)) return true;
  if (/\b(coo|cto|cfo|ceo|cmo|ciso|cpo)\b/.test(t)) return true;
  const directTitleHints = [
    'собственник',
    'владел',
    'генераль',
    'гендир',
    'коммерческ',
    'операцион',
    'директор',
    'руководител',
    'head of',
    'chief',
    'founder',
    'owner',
    'учредител',
    'основател',
    'управляющ',
    'начальник',
    'заместител',
    'замдиректор',
    'вице-президент',
    'продаж',
    'маркетинг',
    'партнёр',
    'партнер',
    'бухгалтер',
    'главбух',
    'финанс',
    'закуп',
    'снабжен',
    'юрист',
    'юридическ',
  ];
  return directTitleHints.some((kw) => t.includes(kw));
}

export function guessLprRoleFromPost(post: string | null | undefined): string {
  const p = String(post ?? '').toLowerCase();
  if (!p) return 'director';
  if (p.includes('собствен') || p.includes('владел') || p.includes('founder') || p.includes('owner')) return 'owner';
  if (p.includes('генераль') || p.includes('гендир') || p.includes('ceo') || p.includes('chief executive')) return 'ceo';
  if (p.includes('коммерчес')) return 'commercial';
  if (p.includes('продаж') || p.includes('sales')) return 'sales';
  if (p.includes('бухгалтер') || p.includes('главбух') || p.includes('финанс') || p.includes('cfo')) return 'finance';
  if (p.includes('закуп') || p.includes('снабжен') || p.includes('procurement')) return 'procurement';
  if (p.includes('юрист') || p.includes('юридическ') || p.includes('legal')) return 'legal';
  if (p.includes('маркет') || p.includes('marketing')) return 'marketing';
  if (p.includes('hr') || p.includes('кадр') || p.includes('персонал')) return 'hr';
  if (p.includes('it') || p.includes('cto') || p.includes('техн')) return 'it';
  if (p.includes('директор') || p.includes('руковод')) return 'director';
  return 'director';
}

/**
 * Returns true if the name looks like a legal entity (ООО, ОАО, ЗАО, ПАО, etc.)
 * rather than a person's name. Used to filter out company names from contact lists.
 */
export function isLegalEntityName(name: string | null | undefined): boolean {
  const n = String(name ?? '').trim();
  if (!n) return true;
  const upper = n.toUpperCase();

  // Direct prefixes
  const legalPrefixes = [
    'ООО', 'ОАО', 'ЗАО', 'ПАО', 'АО', 'НКО', 'НП',
    'ФГУП', 'МУП', 'ГУП', 'ИП',
    'ОБЩЕСТВО', 'АКЦИОНЕРНОЕ', 'ТОВАРИЩЕСТВО', 'КООПЕРАТИВ',
    'ПРЕДПРИЯТИЕ', 'УЧРЕЖДЕНИЕ', 'ФОНД', 'АССОЦИАЦИЯ',
  ];
  for (const prefix of legalPrefixes) {
    if (upper.startsWith(prefix + ' ') || upper.startsWith('"' + prefix) || upper === prefix) return true;
  }

  // Quoted company names
  if (/^["«]/.test(n) && /["»]$/.test(n)) return true;

  // All-caps words longer than typical names → likely a company name
  if (n === n.toUpperCase() && n.length > 20) return true;

  return false;
}

export function normalizeInn(raw: string | null | undefined): string | null {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length === 10 || digits.length === 12) return digits;
  if (digits.length === 9) return `0${digits}`;
  if (digits.length === 11) return `0${digits}`;
  return null;
}
