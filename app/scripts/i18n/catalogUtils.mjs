import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import ts from 'typescript';
import { JSDOM } from 'jsdom';

const CYRILLIC_RE = /[А-Яа-яЁё]/;

export function normalizeUiSource(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function collectSourceFiles(root, output) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const filePath = join(root, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(filePath, output);
      continue;
    }
    if (['.ts', '.tsx', '.js', '.jsx'].includes(extname(entry.name))) output.push(filePath);
  }
}

function addUiSource(output, raw) {
  const value = normalizeUiSource(raw);
  if (value && CYRILLIC_RE.test(value)) output.add(value);
}

export function extractUiSourcesFromCode(source, fileName = 'inline.tsx') {
  const sources = new Set();
  const kind = fileName.endsWith('x')
    ? ts.ScriptKind.TSX
    : fileName.endsWith('.js')
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);

  const concatPattern = (node, state) => {
    if (ts.isParenthesizedExpression(node)) return concatPattern(node.expression, state);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      return concatPattern(node.left, state) + concatPattern(node.right, state);
    }
    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (ts.isTemplateExpression(node)) {
      let pattern = node.head.text;
      node.templateSpans.forEach((span) => {
        pattern += `{${state.index}}${span.literal.text}`;
        state.index += 1;
      });
      return pattern;
    }
    const placeholder = `{${state.index}}`;
    state.index += 1;
    return placeholder;
  };

  const visit = (node) => {
    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      addUiSource(sources, node.text);
    }
    if (ts.isJsxText(node)) addUiSource(sources, node.getText(sourceFile));
    if (ts.isTemplateExpression(node)) {
      let pattern = node.head.text;
      node.templateSpans.forEach((span, index) => {
        pattern += `{${index}}${span.literal.text}`;
      });
      addUiSource(sources, pattern);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.PlusToken &&
      !(ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === ts.SyntaxKind.PlusToken)
    ) {
      addUiSource(sources, concatPattern(node, { index: 0 }));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...sources];
}

export function extractHtmlUiSources(html) {
  const dom = new JSDOM(html);
  const { document, NodeFilter } = dom.window;
  const sources = new Set();

  const title = document.querySelector('title');
  if (title) addUiSource(sources, title.textContent);
  document.querySelectorAll('meta[name="description"]').forEach((meta) => {
    addUiSource(sources, meta.getAttribute('content'));
  });

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const parentTag = node.parentElement?.tagName;
    if (parentTag !== 'SCRIPT' && parentTag !== 'STYLE' && parentTag !== 'NOSCRIPT') {
      addUiSource(sources, node.nodeValue);
    }
    node = walker.nextNode();
  }

  document.body.querySelectorAll('*').forEach((element) => {
    for (const attribute of ['alt', 'title', 'aria-label', 'placeholder']) {
      addUiSource(sources, element.getAttribute(attribute));
    }
  });

  document.querySelectorAll('script:not([src])').forEach((script, index) => {
    for (const source of extractUiSourcesFromCode(script.textContent ?? '', `inline-${index}.js`)) {
      sources.add(source);
    }
  });

  dom.window.close();
  return [...sources].sort((left, right) => left.localeCompare(right, 'ru'));
}

export function extractUiSources({ roots, extraFiles = [], seedSources = [] }) {
  const files = [...extraFiles];
  for (const root of roots) collectSourceFiles(root, files);

  const sources = new Set();
  const add = (raw) => addUiSource(sources, raw);
  for (const source of seedSources) add(source);

  for (const filePath of files) {
    const source = readFileSync(filePath, 'utf8');
    for (const value of extractUiSourcesFromCode(source, filePath)) sources.add(value);
  }

  return [...sources].sort((left, right) => left.localeCompare(right, 'ru'));
}
