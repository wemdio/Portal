/** @jest-environment node */

/**
 * Сторож: голый ProxyAgent из undici на ноде, закрывшей CONNECT без ответа,
 * переподключается без конца (шторм 23.09). Агент к прокси создаётся только
 * через createBoundedProxyAgent. Места ниже появились до правки и ещё не
 * переведены; список может только сокращаться: переведённое место удаляется
 * отсюда, новое сюда не добавляется, число упоминаний в старом месте не растёт.
 *
 * Считается каждое упоминание ProxyAgent (и EnvHttpProxyAgent) в коде, а не в
 * комментариях: импорт под другим именем (`{ ProxyAgent as PA }`),
 * деструктуризация и `mod.ProxyAgent` тоже видны.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const APP = path.resolve(__dirname, '../../..');
const ROOTS = ['src', 'worker'];
const FACTORY = 'src/lib/enrich/boundedProxyAgent.ts';
const LEGACY: Record<string, number> = {
  'src/app/api/ai-caller/calls/[id]/recording/route.ts': 2,
  'src/lib/elevenlabs-convai.ts': 2,
  'src/lib/habrCareer/parser.ts': 2,
  'src/lib/jobs/hhAutoParser.ts': 2,
  'src/lib/parsers/searchScraper.ts': 1,
  'src/lib/parsers/sourceCompanyExtractor.ts': 1,
};
const NAMES = new Set(['ProxyAgent', 'EnvHttpProxyAgent']);

function sources(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(full);
    return /\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name) ? [full] : [];
  });
}

/** Упоминания в синтаксическом дереве: имена и строки (`mod['ProxyAgent']`), без комментариев. */
function mentions(file: string, text: string): number {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : /\.[mc]?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, kind);
  let count = 0;
  const visit = (node: ts.Node): void => {
    if ((ts.isIdentifier(node) && NAMES.has(node.text)) || (ts.isStringLiteralLike(node) && NAMES.has(node.text))) count += 1;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return count;
}

it('ProxyAgent — только в фабрике ограниченного агента и в старых местах из списка, не чаще прежнего', () => {
  const found: Record<string, number> = {};
  for (const full of ROOTS.flatMap((root) => sources(path.join(APP, root)))) {
    const file = path.relative(APP, full).split(path.sep).join('/');
    const text = fs.readFileSync(full, 'utf8');
    if (file === FACTORY || !text.includes('ProxyAgent')) continue;
    const count = mentions(file, text);
    if (count > 0) found[file] = count;
  }
  expect(found).toEqual(LEGACY);
});

it('сторож видит импорт под другим именем, деструктуризацию и обращение через модуль', () => {
  expect(mentions('a.ts', "import { ProxyAgent as PA } from 'undici';\nconst agent = new PA(url);")).toBe(1);
  expect(mentions('b.ts', "const { ProxyAgent: PA } = await import('undici');\nnew PA(url);")).toBe(1);
  expect(mentions('c.ts', "const mod = await import('undici');\nnew mod['ProxyAgent'](url);")).toBe(1);
  expect(mentions('d.js', "const { EnvHttpProxyAgent } = require('undici');\nnew EnvHttpProxyAgent();")).toBe(2);
  expect(mentions('e.ts', '// голый ProxyAgent переподключается\n/** ProxyAgent */\nconst x = createBoundedProxyAgent(url);')).toBe(0);
});
