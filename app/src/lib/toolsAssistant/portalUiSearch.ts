import 'server-only';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TOOLS_CONFIG, ALL_TOOL_IDS, type ToolId } from '@/lib/toolsRegistry';
import { navItems } from '@/lib/navigation';

/**
 * Real-time поиск по интерфейсу инструментов портала. На каждый запрос
 * Portal AI помощник передаёт сюда последнее сообщение пользователя, и мы:
 *
 *   1. Строим (один раз и кешируем) индекс всех «human-readable» строк из
 *      исходников каждого инструмента (page.tsx + его прямые импорты).
 *   2. Токенизируем запрос, для каждого инструмента считаем сколько токенов
 *      встречается в его labels.
 *   3. Возвращаем топ-3 совпавших инструмента с конкретными labels, которые
 *      подтвердили попадание.
 *
 * Модель получает узкий, релевантный кусок («в инструменте X найдены кнопки
 * "Валидация почт", "Найти почты" …»), вместо того чтобы перебирать тысячи
 * строк интерфейса.
 */

const SRC_ROOT = path.join(process.cwd(), 'src');
const INDEX_TTL_MS = 60_000;
const MAX_FILE_BYTES = 2_000_000;
const MAX_RESULTS = 5;
const MAX_LABELS_PER_RESULT = 8;
const MIN_TOKEN_LEN = 3;
/** Префикс для match-логики: «валидатор» и «валидация» совпадают по префиксу
 *  «валид» (5 символов). Без этого пользовательский запрос про «валидатор»
 *  не находит кнопку «Валидация почт» в исходниках. */
const STEM_PREFIX_LEN = 5;

interface ToolEntry {
  /** Технический id (toolId или nav id) — нужен только для дебага. */
  id: string;
  /** Что показывать пользователю в ответе. */
  title: string;
  href: string;
  /** Тексты из самого названия инструмента/раздела. Совпадение с ними весит
   *  больше, потому что пользователь обычно ищет именно по названию. */
  titleLabels: string[];
  /** Тексты с внутренней страницы инструмента (кнопки, лейблы). */
  bodyLabels: string[];
}

const TITLE_WEIGHT = 3;
const BODY_WEIGHT = 1;

interface IndexState {
  ts: number;
  entries: ToolEntry[];
}

let cached: IndexState | null = null;

function readFileSafe(p: string): string {
  try {
    const stat = fs.statSync(p);
    if (stat.size > MAX_FILE_BYTES) return '';
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

function fileExists(p: string): boolean {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function resolveImport(importPath: string, fromFile: string): string | null {
  let basePath: string;
  if (importPath.startsWith('@/')) basePath = path.join(SRC_ROOT, importPath.slice(2));
  else if (importPath.startsWith('.')) basePath = path.join(path.dirname(fromFile), importPath);
  else return null;
  const candidates = [
    `${basePath}.tsx`,
    `${basePath}.ts`,
    path.join(basePath, 'index.tsx'),
    path.join(basePath, 'index.ts'),
  ];
  for (const c of candidates) if (fileExists(c)) return c;
  return null;
}

/** Покрывает `import ...from '...'` и re-exports `export {default} from '...'`.
 *  Без re-export ветки страницы вида app/board/page.tsx (`export {default}
 *  from '@/app/tasks/page'`) теряют всю внутрянку. */
const IMPORT_RE = /(?:import|export)\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]/g;
const STRING_LITERAL_RE = /['"`]([^'"`\n]{2,120})['"`]/g;
const JSX_TEXT_RE = />([^<>{}\n]{2,120})</g;

const TAILWIND_HINTS = /\b(?:flex|grid|hidden|block|inline|absolute|relative|fixed|sticky|gap-|gap_|p[xytrbl]?-|m[xytrbl]?-|w-|h-|min-|max-|text-(?:xs|sm|base|lg|xl|\d|left|right|center|white|black|gray|zinc|red|blue|green|yellow|amber|emerald|sky)|bg-(?:white|black|gray|zinc|red|blue|green|yellow|amber|emerald|sky|transparent)|border|rounded|shadow|hover:|focus:|active:|disabled:|group|peer|opacity-|cursor-|select-|overflow-|whitespace-|truncate|justify-|items-|self-|font-(?:sans|serif|mono|bold|semibold|medium|normal|light)|leading-|tracking-)\b/;
const URL_RE = /^https?:\/\//;
const FILE_RE = /\.(tsx?|jsx?|css|json|svg|png|jpg|webp)$/i;
const PATH_RE = /^[./\\@]|[/\\]/;
const ALL_LATIN_TECH = /^[a-z][\w-]*$/i;
const CYRILLIC_RE = /[а-яё]/i;

function isHumanLabel(raw: string): boolean {
  const s = raw.trim();
  if (s.length < 2 || s.length > 80) return false;
  if (URL_RE.test(s)) return false;
  if (FILE_RE.test(s)) return false;
  if (PATH_RE.test(s) && !CYRILLIC_RE.test(s)) return false;
  if (TAILWIND_HINTS.test(s)) return false;
  if (!CYRILLIC_RE.test(s) && !/\s/.test(s) && ALL_LATIN_TECH.test(s)) {
    if (!/[A-Z]/.test(s.slice(1))) return false;
  }
  if (/^[A-Z_]{2,}$/.test(s)) return false;
  if (/^aria-|^data-|^use[A-Z]/.test(s)) return false;
  if (/^\d+(\.\d+)?(px|rem|em|%|s|ms)?$/i.test(s)) return false;
  if (s.includes('${')) return false;
  return true;
}

function collectImports(source: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = IMPORT_RE.exec(source))) {
    if (m[1].startsWith('@/') || m[1].startsWith('.')) out.push(m[1]);
  }
  return out;
}

function collectLabels(source: string): string[] {
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = STRING_LITERAL_RE.exec(source))) {
    const s = m[1].trim().replace(/\s+/g, ' ');
    if (isHumanLabel(s)) seen.add(s);
  }
  while ((m = JSX_TEXT_RE.exec(source))) {
    const s = m[1].trim().replace(/\s+/g, ' ');
    if (isHumanLabel(s)) seen.add(s);
  }
  return Array.from(seen);
}

function resolvePageFile(href: string): string | null {
  // /tools/<slug> → app/tools/<slug>/page.tsx
  const toolsMatch = href.match(/^\/tools\/([\w-]+)$/);
  if (toolsMatch) return path.join(SRC_ROOT, 'app', 'tools', toolsMatch[1], 'page.tsx');
  // /foo или /foo/bar → app/foo[/bar]/page.tsx — покрывает /board, /tasks,
  // /team, /finance, /parsers, /instantly и т.д. без захардкоженного списка.
  const navMatch = href.match(/^\/([\w-]+(?:\/[\w-]+)*)$/);
  if (navMatch) {
    const candidate = path.join(SRC_ROOT, 'app', navMatch[1], 'page.tsx');
    if (fileExists(candidate)) return candidate;
  }
  return null;
}

function collectBodyLabelsFor(pageFile: string): string[] {
  const bodyLabels = new Set<string>();
  const pageSource = readFileSafe(pageFile);
  if (!pageSource) return [];
  for (const l of collectLabels(pageSource)) bodyLabels.add(l);
  for (const imp of collectImports(pageSource)) {
    const resolved = resolveImport(imp, pageFile);
    if (!resolved) continue;
    const subSource = readFileSafe(resolved);
    if (!subSource) continue;
    for (const l of collectLabels(subSource)) bodyLabels.add(l);
  }
  return Array.from(bodyLabels);
}

function buildToolEntry(toolId: ToolId): ToolEntry | null {
  const config = TOOLS_CONFIG[toolId];
  if (!config) return null;

  const titleLabels = [config.title];
  if (config.title_en) titleLabels.push(config.title_en);

  const bodyLabels = new Set<string>();
  bodyLabels.add(config.description);
  if (config.description_en) bodyLabels.add(config.description_en);

  const pageFile = resolvePageFile(config.href);
  if (pageFile) {
    for (const l of collectBodyLabelsFor(pageFile)) bodyLabels.add(l);
  }

  return {
    id: toolId,
    title: config.title,
    href: config.href,
    titleLabels,
    bodyLabels: Array.from(bodyLabels),
  };
}

/** Виртуальная запись для пункта верхнего меню (например «Доска» → /board).
 *  Без этого запрос «куда вынести задачи на доску» не имеет шанса попасть в
 *  /board — там нет инструмента в реестре, только пункт навигации. */
function buildNavEntry(item: { id: string; name: string; nameEn: string; href: string }): ToolEntry | null {
  // Пропускаем разделы, которые уже покрыты как «инструменты», и сервисные
  // страницы (профиль/тарифы и т.п. без полезного контекста).
  if (
    item.href === '/'
    || item.href.startsWith('/tools')
    || item.href === '/instantly'
    || item.href === '/parsers'
    || item.href === '/profile'
  ) return null;
  const titleLabels = [item.name, item.nameEn].filter(Boolean);
  const pageFile = resolvePageFile(item.href);
  const bodyLabels = pageFile ? collectBodyLabelsFor(pageFile) : [];
  return {
    id: `nav:${item.id}`,
    title: item.name,
    href: item.href,
    titleLabels,
    bodyLabels,
  };
}

function rebuildIndex(): ToolEntry[] {
  const entries: ToolEntry[] = [];
  for (const toolId of ALL_TOOL_IDS) {
    const entry = buildToolEntry(toolId);
    if (entry) entries.push(entry);
  }
  for (const item of navItems) {
    const entry = buildNavEntry(item);
    if (entry) entries.push(entry);
  }
  return entries;
}

function getIndex(): ToolEntry[] {
  const now = Date.now();
  if (cached && now - cached.ts < INDEX_TTL_MS) return cached.entries;
  cached = { ts: now, entries: rebuildIndex() };
  return cached.entries;
}

/** Достаём из вопроса значимые токены: убираем стоп-слова и короткие. */
function tokenize(query: string): string[] {
  const STOP = new Set([
    'где', 'как', 'это', 'там', 'или', 'для', 'что', 'кто', 'мне', 'нам', 'надо',
    'мочь', 'могу', 'буду', 'будет', 'есть', 'был', 'была', 'было', 'был',
    'найти', 'найду', 'найдёт', 'находится', 'лежит', 'лежать', 'попасть',
    'пользоваться', 'использовать', 'открыть', 'тут', 'портал', 'сайт',
    'инструмент', 'кнопка', 'вкладка', 'функция', 'раздел',
    'который', 'которая', 'который', 'один', 'просто', 'только',
    'where', 'how', 'what', 'who', 'is', 'are', 'was', 'were', 'the', 'a', 'an',
    'find', 'open', 'use', 'tool', 'button', 'tab', 'section', 'in', 'on', 'at',
  ]);
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter((t) => t.length >= MIN_TOKEN_LEN && !STOP.has(t)),
    ),
  );
}

export interface SearchHit {
  toolId: string;
  title: string;
  href: string;
  /** Labels из исходников, которые совпали с токенами запроса. */
  matchedLabels: string[];
  score: number;
}

function stem(token: string): string {
  return token.length > STEM_PREFIX_LEN ? token.slice(0, STEM_PREFIX_LEN) : token;
}

function scanLabels(labels: string[], stems: string[], collector: string[], stemHit: Set<string>): void {
  for (const label of labels) {
    if (collector.length >= MAX_LABELS_PER_RESULT) return;
    const lower = label.toLowerCase();
    const hitStems = stems.filter((s) => lower.includes(s));
    if (hitStems.length === 0) continue;
    collector.push(label);
    for (const s of hitStems) stemHit.add(s);
  }
}

/**
 * Ищем в индексе по префиксам токенов запроса (упрощённый стемминг).
 * Скор: TITLE_WEIGHT × число токенов, совпавших в названии инструмента,
 * плюс BODY_WEIGHT × число токенов, совпавших во внутренних лейблах.
 * Совпадение по названию весит больше — это разруливает омонимы вроде
 * «задачи команды» (раздел «Задачи») vs «задачи парсинга» (вкладка внутри
 * Парсеров).
 */
export function searchPortalUi(query: string): SearchHit[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];
  const stems = tokens.map(stem);

  const idx = getIndex();
  const hits: SearchHit[] = [];

  for (const entry of idx) {
    const titleMatches: string[] = [];
    const titleStemHit = new Set<string>();
    scanLabels(entry.titleLabels, stems, titleMatches, titleStemHit);

    const bodyMatches: string[] = [];
    const bodyStemHit = new Set<string>();
    scanLabels(entry.bodyLabels, stems, bodyMatches, bodyStemHit);

    if (titleMatches.length === 0 && bodyMatches.length === 0) continue;

    // Title-матчи показываем первыми — пользователю важнее увидеть «совпало по
    // названию», а уже потом «совпало по содержимому».
    const matched = [...titleMatches, ...bodyMatches].slice(0, MAX_LABELS_PER_RESULT);
    const score = titleStemHit.size * TITLE_WEIGHT + bodyStemHit.size * BODY_WEIGHT;

    hits.push({
      toolId: entry.id,
      title: entry.title,
      href: entry.href,
      matchedLabels: matched,
      score,
    });
  }

  hits.sort((a, b) => b.score - a.score);
  // Возвращаем топ-N как есть и отдаём модели — она по `matchedLabels`
  // решит, стоит ли отвечать сразу или предложить выбор пользователю.
  // Жёсткий dominant-фильтр оказался вредным: при запросе про «задачи»
  // он съедал /board (там «задача» только во внутренних кнопках), хотя
  // доска — это второй валидный способ управления задачами.
  return hits.slice(0, MAX_RESULTS);
}
