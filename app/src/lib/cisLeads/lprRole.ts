export function guessRoleFromTitle(title: string | null): { role: string | null; score: number } {
  const t = String(title ?? '').toLowerCase();
  if (!t) return { role: null, score: 0 };

  const rules: Array<{ role: string; score: number; kw: string[] }> = [
    { role: 'owner', score: 80, kw: ['собственник', 'владелец', 'owner', 'founder', 'сооснователь', 'основатель'] },
    { role: 'ceo', score: 75, kw: ['генеральный', 'гендир', 'ceo', 'chief executive', 'президент'] },
    { role: 'commercial', score: 65, kw: ['коммерческ', 'cсо', 'cro', 'директор по продаж', 'sales director'] },
    { role: 'sales', score: 55, kw: ['продаж', 'sales', 'bizdev', 'business development', 'аккаунт', 'account'] },
    { role: 'marketing', score: 50, kw: ['маркет', 'marketing', 'growth', 'pr', 'brand'] },
    { role: 'ops', score: 45, kw: ['операц', 'operations', 'coo', 'логист', 'supply'] },
    { role: 'it', score: 45, kw: ['it', 'cto', 'техн', 'разраб', 'engineering', 'security', 'ciso'] },
    { role: 'hr', score: 30, kw: ['hr', 'кадр', 'персонал', 'recruit', 'talent'] },
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
  if (['owner', 'ceo', 'commercial', 'director', 'sales', 'marketing', 'it', 'ops', 'hr'].includes(r)) return true;
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
  ];
  return directTitleHints.some((kw) => t.includes(kw));
}

export function guessLprRoleFromPost(post: string | null | undefined): string {
  const p = String(post ?? '').toLowerCase();
  if (!p) return 'director';
  if (p.includes('собствен') || p.includes('владел') || p.includes('founder') || p.includes('owner')) return 'owner';
  if (p.includes('генераль') || p.includes('гендир') || p.includes('ceo') || p.includes('chief executive')) return 'ceo';
  if (p.includes('коммерчес')) return 'commercial';
  if (p.includes('директор') || p.includes('руковод')) return 'director';
  return 'director';
}

export function normalizeInn(raw: string | null | undefined): string | null {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length === 10 || digits.length === 12) return digits;
  if (digits.length === 9) return `0${digits}`;
  if (digits.length === 11) return `0${digits}`;
  return null;
}
