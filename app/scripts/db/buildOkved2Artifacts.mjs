#!/usr/bin/env node
/**
 * Из okved2.scraped.json генерирует:
 *   1) app/src/lib/companiesSearch/okved2.ts  — полный TS-справочник (дерево + плоский лук-ап)
 *   2) supabase/migrations/<ts>_okved2_reference_seed.sql — SQL-сид для public.okved_reference
 *
 * Запуск (из app/):
 *   node scripts/db/buildOkved2Artifacts.mjs
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const JSON_PATH = resolve(__dirname, 'okved2.scraped.json');
const TS_OUT = resolve(__dirname, '..', '..', 'src', 'lib', 'companiesSearch', 'okved2.ts');
const SQL_OUT = resolve(
  __dirname,
  '..',
  '..',
  '..',
  'supabase',
  'migrations',
  '20260512_0001_okved_reference.sql',
);

function pgEscape(s) {
  return s.replace(/'/g, "''");
}

function tsEscape(s) {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function buildTree(rows) {
  const byCode = new Map(rows.map((r) => [r.code, { ...r, children: [] }]));
  const roots = [];
  for (const node of byCode.values()) {
    if (!node.parent_code) {
      roots.push(node);
      continue;
    }
    const parent = byCode.get(node.parent_code);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sortKey = (n) => {
    if (/^[A-U]$/.test(n.code)) return [0, n.code];
    const parts = n.code.split('.').map((p) => Number(p));
    return [1, ...parts];
  };
  const sortRec = (arr) => {
    arr.sort((a, b) => {
      const ka = sortKey(a);
      const kb = sortKey(b);
      for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
        const da = ka[i] ?? 0;
        const db = kb[i] ?? 0;
        if (da < db) return -1;
        if (da > db) return 1;
      }
      return 0;
    });
    for (const n of arr) if (n.children?.length) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}

function renderTreeTs(nodes, indent = 2) {
  const sp = ' '.repeat(indent);
  const items = nodes.map((n) => {
    const head = `${sp}{ code: '${tsEscape(n.code)}', name: '${tsEscape(n.name)}'`;
    if (n.children && n.children.length > 0) {
      const inner = renderTreeTs(n.children, indent + 2);
      return `${head}, children: [\n${inner}\n${sp}] }`;
    }
    return `${head} }`;
  });
  return items.join(',\n');
}

async function main() {
  const raw = await readFile(JSON_PATH, 'utf8');
  const rows = JSON.parse(raw);
  console.log(`loaded ${rows.length} rows`);

  const tree = buildTree(rows);
  const treeBody = renderTreeTs(tree, 2);

  const ts = `// AUTO-GENERATED from regfile.ru/okved2.html via app/scripts/db/scrapeOkved2.mjs.
// Не редактировать вручную. Перегенерация:
//   cd app && node scripts/db/scrapeOkved2.mjs && node scripts/db/buildOkved2Artifacts.mjs

export type OkvedNode = {
  code: string;
  name: string;
  children?: OkvedNode[];
};

export const OKVED2_TREE: OkvedNode[] = [
${treeBody},
];

export type OkvedFlatEntry = {
  code: string;
  name: string;
  parent_code: string | null;
  section: string;
  level: number;
};

let _flat: OkvedFlatEntry[] | null = null;
let _byCode: Map<string, OkvedFlatEntry> | null = null;

function flatten(): OkvedFlatEntry[] {
  if (_flat) return _flat;
  const out: OkvedFlatEntry[] = [];
  const walk = (node: OkvedNode, parent: string | null, section: string, level: number) => {
    out.push({ code: node.code, name: node.name, parent_code: parent, section, level });
    if (node.children) {
      for (const ch of node.children) walk(ch, node.code, section, level + 1);
    }
  };
  for (const root of OKVED2_TREE) walk(root, null, root.code, 0);
  _flat = out;
  return out;
}

export function getOkvedFlat(): OkvedFlatEntry[] {
  return flatten();
}

export function getOkvedByCode(code: string): OkvedFlatEntry | undefined {
  if (!_byCode) {
    _byCode = new Map(flatten().map((e) => [e.code, e]));
  }
  return _byCode.get(code);
}

export function collectDescendantCodes(code: string): string[] {
  const root = OKVED2_TREE.find((n) => n.code === code) ?? findNode(OKVED2_TREE, code);
  if (!root) return [code];
  const codes: string[] = [];
  const walk = (n: OkvedNode) => {
    codes.push(n.code);
    if (n.children) for (const c of n.children) walk(c);
  };
  walk(root);
  return codes;
}

function findNode(nodes: OkvedNode[], code: string): OkvedNode | undefined {
  for (const n of nodes) {
    if (n.code === code) return n;
    if (n.children) {
      const r = findNode(n.children, code);
      if (r) return r;
    }
  }
  return undefined;
}

/**
 * Из произвольного множества выбранных кодов оставить только верхние —
 * то есть те, у которых ни один предок не выбран. Это даёт минимальный набор
 * префиксов для серверного фильтра (один префикс заменяет все вложенные коды).
 */
export function reduceToTopCodes(selected: ReadonlySet<string>): string[] {
  const top: string[] = [];
  for (const code of selected) {
    let cur = code;
    let hasAncestor = false;
    while (true) {
      const entry = getOkvedByCode(cur);
      if (!entry || !entry.parent_code) break;
      cur = entry.parent_code;
      if (selected.has(cur)) {
        hasAncestor = true;
        break;
      }
    }
    if (!hasAncestor) top.push(code);
  }
  return top;
}
`;

  await writeFile(TS_OUT, ts, 'utf8');
  console.log(`✓ wrote ${TS_OUT}`);

  const flat = [];
  const walk = (n, parent, section, level) => {
    flat.push({ code: n.code, name: n.name, parent_code: parent, section, level });
    if (n.children) for (const c of n.children) walk(c, n.code, section, level + 1);
  };
  for (const root of tree) walk(root, null, root.code, 0);

  const valuesPerInsert = 250;
  const inserts = [];
  for (let i = 0; i < flat.length; i += valuesPerInsert) {
    const chunk = flat.slice(i, i + valuesPerInsert);
    const values = chunk
      .map(
        (e) =>
          `('${pgEscape(e.code)}', '${pgEscape(e.name)}', ${
            e.parent_code ? `'${pgEscape(e.parent_code)}'` : 'null'
          }, '${pgEscape(e.section)}', ${e.level})`,
      )
      .join(',\n  ');
    inserts.push(
      `insert into public.okved_reference (code, name, parent_code, section, level) values\n  ${values}\non conflict (code) do update set\n  name = excluded.name,\n  parent_code = excluded.parent_code,\n  section = excluded.section,\n  level = excluded.level;`,
    );
  }

  const sql = `-- AUTO-GENERATED from regfile.ru/okved2.html via app/scripts/db/scrapeOkved2.mjs
-- Перегенерация: cd app && node scripts/db/scrapeOkved2.mjs && node scripts/db/buildOkved2Artifacts.mjs
--
-- Полный справочник ОКВЭД-2 (~2700 записей, разделы A–U + 5 уровней детализации):
--   - 21 раздел (A..U)               level 0
--   - 88 классов (XX)                level 1
--   - подклассы (XX.X)               level 2
--   - группы (XX.XX)                 level 3
--   - подгруппы (XX.XX.X)            level 4
--   - виды (XX.XX.XX)                level 5
--
-- parent_code: для XX → раздел (буква), для XX.X → XX, для XX.XX → XX.X,
-- для XX.XX.X → XX.XX, для XX.XX.XX → XX.XX.X (т.е. отбрасываем последнюю цифру).

create table if not exists public.okved_reference (
  code        text primary key,
  name        text not null,
  parent_code text references public.okved_reference(code) deferrable initially deferred,
  section     text not null,
  level       smallint not null check (level between 0 and 5),
  created_at  timestamptz not null default now()
);

create index if not exists okved_reference_parent_idx  on public.okved_reference(parent_code);
create index if not exists okved_reference_section_idx on public.okved_reference(section);
create index if not exists okved_reference_level_idx   on public.okved_reference(level);
create index if not exists okved_reference_code_prefix_idx
  on public.okved_reference(code text_pattern_ops);

-- READ для всех ролей, WRITE — только service_role.
grant select on public.okved_reference to anon, authenticated;
grant select, insert, update, delete on public.okved_reference to service_role;

${inserts.join('\n\n')}
`;

  await writeFile(SQL_OUT, sql, 'utf8');
  console.log(`✓ wrote ${SQL_OUT}`);
  console.log(`  flat rows: ${flat.length}, inserts: ${inserts.length}`);
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
