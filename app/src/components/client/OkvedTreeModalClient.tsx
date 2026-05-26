'use client';

/**
 * Client-portal editorial-dark variant of `OkvedTreeModal`.
 *
 * The original `OkvedTreeModal` is shared with admin tools (/tools/our-bases)
 * and uses a light-theme palette (bg-white, blue checkboxes, gray text). On
 * the client portal that pops up over editorial-dark surfaces and creates a
 * jarring two-aesthetic collision (the «AI made this» smoking gun flagged
 * in /impeccable critique 2026-05-25 of /client/companies-search at 15/40
 * Bad band).
 *
 * Rather than touch the shared file (risk: breaking admin tools used by
 * agency specialists), we clone it here, swap chrome + color tokens for
 * editorial dark, and let `/client/companies-search` import this variant.
 * API is identical so call sites swap by import path only.
 */

import { useCallback, useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import { OKVED2_TREE, type OkvedNode } from '@/lib/companiesSearch/okved2';
import type { Locale } from '@/lib/i18n';

type Props = {
  selected: Set<string>;
  onChange: (s: Set<string>) => void;
  onClose: () => void;
  locale?: Locale;
};

// Falls back to Russian for any non-EN locale.
function t(ru: string, en: string, locale: Locale) {
  return locale === 'en' ? en : ru;
}

function collectAllCodes(node: OkvedNode): string[] {
  const codes = [node.code];
  if (node.children) {
    for (const child of node.children) {
      codes.push(...collectAllCodes(child));
    }
  }
  return codes;
}

function getSelectionState(
  node: OkvedNode,
  selected: Set<string>,
): 'none' | 'all' | 'partial' {
  if (!node.children || node.children.length === 0) {
    return selected.has(node.code) ? 'all' : 'none';
  }

  let allSelected = true;
  let anySelected = selected.has(node.code);

  for (const child of node.children) {
    const state = getSelectionState(child, selected);
    if (state !== 'all') allSelected = false;
    if (state !== 'none') anySelected = true;
  }

  if (allSelected) return 'all';
  if (anySelected) return 'partial';
  return 'none';
}

function matchesSearch(node: OkvedNode, query: string): boolean {
  const text = `${node.code} ${node.name}`.toLowerCase();
  if (text.includes(query)) return true;
  if (node.children) {
    return node.children.some((child) => matchesSearch(child, query));
  }
  return false;
}

function filterTree(nodes: OkvedNode[], query: string): OkvedNode[] {
  if (!query) return nodes;
  return nodes
    .filter((node) => matchesSearch(node, query))
    .map((node) => {
      if (!node.children) return node;
      const filteredChildren = filterTree(node.children, query);
      return { ...node, children: filteredChildren.length > 0 ? filteredChildren : node.children };
    });
}

/** Буквенный раздел (A-U) — нечекабельный заголовок-разделитель */
function SectionHeader({
  node,
  selected,
  onToggle,
  expanded,
  onToggleExpand,
}: {
  node: OkvedNode;
  selected: Set<string>;
  onToggle: (node: OkvedNode) => void;
  expanded: Set<string>;
  onToggleExpand: (code: string) => void;
}) {
  const isExpanded = expanded.has(node.code);
  const selectionState = getSelectionState(node, selected);

  return (
    <div>
      <div className="flex items-center gap-1 pt-3 pb-0.5">
        <button
          type="button"
          onClick={() => onToggleExpand(node.code)}
          className="w-6 h-6 flex items-center justify-center flex-shrink-0 text-xs"
          style={{ color: 'var(--cp-paper-faint)' }}
        >
          {isExpanded ? '−' : '+'}
        </button>
        {/* Checkbox на разделе выделяет всех потомков */}
        <label className="flex items-center gap-2 cursor-pointer min-w-0 flex-1">
          <input
            type="checkbox"
            checked={selectionState === 'all'}
            ref={(el) => { if (el) el.indeterminate = selectionState === 'partial'; }}
            onChange={() => onToggle(node)}
            className="w-4 h-4 flex-shrink-0"
            style={{ accentColor: 'var(--cp-paper)' }}
          />
          <span
            className="ds-mono text-xs font-bold uppercase tracking-wide select-none"
            style={{ color: 'var(--cp-paper-faint)' }}
          >
            {node.code}
          </span>
          <span
            className="text-xs font-semibold truncate"
            style={{ color: 'var(--cp-paper-mute)' }}
          >
            {node.name}
          </span>
        </label>
      </div>
      {isExpanded && node.children && (
        <div>
          {node.children.map((child) => (
            <TreeNode
              key={child.code}
              node={child}
              selected={selected}
              onToggle={onToggle}
              expanded={expanded}
              onToggleExpand={onToggleExpand}
              depth={0}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TreeNode({
  node,
  selected,
  onToggle,
  expanded,
  onToggleExpand,
  depth,
}: {
  node: OkvedNode;
  selected: Set<string>;
  onToggle: (node: OkvedNode) => void;
  expanded: Set<string>;
  onToggleExpand: (code: string) => void;
  depth: number;
}) {
  const hasChildren = node.children && node.children.length > 0;
  const isExpanded = expanded.has(node.code);
  const selectionState = getSelectionState(node, selected);

  return (
    <div>
      <div
        className="flex items-center gap-1 py-0.5 rounded transition-colors"
        style={{ paddingLeft: `${depth * 20 + 8}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggleExpand(node.code)}
            className="w-6 h-6 flex items-center justify-center flex-shrink-0 text-xs"
            style={{ color: 'var(--cp-paper-faint)' }}
          >
            {isExpanded ? '−' : '+'}
          </button>
        ) : (
          <span className="w-6 flex-shrink-0" />
        )}
        <label className="flex items-center gap-2 cursor-pointer min-w-0 flex-1">
          <input
            type="checkbox"
            checked={selectionState === 'all'}
            ref={(el) => {
              if (el) el.indeterminate = selectionState === 'partial';
            }}
            onChange={() => onToggle(node)}
            className="w-4 h-4 flex-shrink-0"
            style={{ accentColor: 'var(--cp-paper)' }}
          />
          <span className="text-sm" style={{ color: 'var(--cp-paper)' }}>
            <span
              className="ds-mono font-semibold mr-1.5"
              style={{ color: 'var(--cp-paper-faint)' }}
            >
              {node.code}
            </span>
            {node.name}
          </span>
        </label>
      </div>
      {hasChildren && isExpanded && (
        <div>
          {node.children!.map((child) => (
            <TreeNode
              key={child.code}
              node={child}
              selected={selected}
              onToggle={onToggle}
              expanded={expanded}
              onToggleExpand={onToggleExpand}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function OkvedTreeModalClient({ selected, onChange, onClose, locale = 'ru' }: Props) {
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const filteredTree = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return OKVED2_TREE;
    return filterTree(OKVED2_TREE, q);
  }, [search]);

  const expandedForSearch = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return expanded;
    const all = new Set(expanded);
    const collectExpandable = (nodes: OkvedNode[]) => {
      for (const node of nodes) {
        if (node.children && node.children.length > 0) {
          all.add(node.code);
          collectExpandable(node.children);
        }
      }
    };
    collectExpandable(filteredTree);
    return all;
  }, [search, filteredTree, expanded]);

  const toggleExpand = useCallback((code: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }, []);

  const toggleNode = useCallback(
    (node: OkvedNode) => {
      const allCodes = collectAllCodes(node);
      const state = getSelectionState(node, selected);
      const next = new Set(selected);

      if (state === 'all') {
        for (const code of allCodes) next.delete(code);
      } else {
        for (const code of allCodes) next.add(code);
      }

      onChange(next);
    },
    [selected, onChange],
  );

  const totalSelected = useMemo(() => {
    return selected.size;
  }, [selected]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0"
        style={{ background: 'var(--cp-scrim)' }}
        onClick={onClose}
      />
      <div
        className="relative max-w-3xl w-full max-h-[85vh] flex flex-col rounded-lg overflow-hidden"
        style={{
          background: 'var(--cp-surface-elev)',
          border: '1px solid var(--cp-divider-strong)',
        }}
      >
        <div
          className="flex items-center justify-between px-6 pt-5 pb-3"
          style={{ borderBottom: '1px solid var(--cp-divider)' }}
        >
          <h3
            className="text-base font-semibold m-0"
            style={{ color: 'var(--cp-paper)' }}
          >
            {t('Виды деятельности по ОКВЭД-2', 'Activity types (OKVED-2)', locale)}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="ds-btn-ghost inline-flex h-8 w-8 items-center justify-center rounded-md"
            aria-label={t('Закрыть', 'Close', locale)}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <div className="px-6 pt-4 pb-3">
          <div className="relative">
            <Search
              className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 pointer-events-none"
              style={{ color: 'var(--cp-paper-faint)' }}
              aria-hidden
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('Быстрый поиск', 'Quick search', locale)}
              className="ds-input w-full pl-9 pr-3 py-2 text-sm"
              style={{ color: 'var(--cp-paper)' }}
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-6 pb-4">
          {filteredTree.length === 0 && (
            <p
              className="text-sm py-8 text-center"
              style={{ color: 'var(--cp-paper-mute)' }}
            >
              {t('Ничего не найдено', 'Nothing found', locale)}
            </p>
          )}
          {filteredTree.map((section) => (
            <SectionHeader
              key={section.code}
              node={section}
              selected={selected}
              onToggle={toggleNode}
              expanded={search.trim() ? expandedForSearch : expanded}
              onToggleExpand={toggleExpand}
            />
          ))}
        </div>

        <div
          className="flex items-center justify-between px-6 py-4 gap-3"
          style={{ borderTop: '1px solid var(--cp-divider)' }}
        >
          <span
            className="ds-mono text-xs"
            style={{ color: 'var(--cp-paper-mute)' }}
          >
            {t(
              `Выбрано: ${totalSelected}`,
              `Selected: ${totalSelected}`,
              locale,
            )}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onChange(new Set())}
              className="ds-btn-ghost px-4 py-2 text-sm"
            >
              {t('Очистить', 'Clear', locale)}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="ds-btn-primary px-5 py-2 text-sm"
            >
              {t('Готово', 'Done', locale)}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
