'use client';

import { useCallback, useMemo, useState } from 'react';
import { OKVED2_TREE, type OkvedNode } from '@/lib/companiesSearch/okved2';

type Props = {
  selected: Set<string>;
  onChange: (s: Set<string>) => void;
  onClose: () => void;
  locale?: 'ru' | 'en';
};

function t(ru: string, en: string, locale: 'ru' | 'en') {
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
          className="w-6 h-6 flex items-center justify-center text-gray-400 hover:text-gray-600 flex-shrink-0 text-xs"
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
            className="w-4 h-4 accent-blue-600 flex-shrink-0"
          />
          <span className="text-xs font-bold text-gray-400 uppercase tracking-wide select-none">
            {node.code}
          </span>
          <span className="text-xs font-semibold text-gray-500 truncate">{node.name}</span>
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
        className="flex items-center gap-1 py-0.5 hover:bg-gray-50 rounded"
        style={{ paddingLeft: `${depth * 20 + 8}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggleExpand(node.code)}
            className="w-6 h-6 flex items-center justify-center text-gray-400 hover:text-gray-700 flex-shrink-0 text-xs"
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
            className="w-4 h-4 accent-blue-600 flex-shrink-0"
          />
          <span className="text-sm">
            <span className="font-semibold text-gray-500 mr-1.5">{node.code}</span>
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

export function OkvedTreeModal({ selected, onChange, onClose, locale = 'ru' }: Props) {
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
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-2xl max-w-3xl w-full max-h-[85vh] flex flex-col animate-in fade-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between px-8 pt-6 pb-3">
          <h3 className="text-base font-semibold text-gray-900">
            {t('Виды деятельности по ОКВЭД-2', 'Activity types (OKVED-2)', locale)}
          </h3>
          <button
            onClick={onClose}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-8 pb-4">
          <div className="relative">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-5.197-5.197m0 0A7.5 7.5 0 1 0 5.196 5.196a7.5 7.5 0 0 0 10.607 10.607Z" />
            </svg>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('Быстрый поиск', 'Quick search', locale)}
              className="w-full border border-gray-200 rounded-lg pl-9 pr-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 transition-shadow"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-8 pb-4">
          {filteredTree.length === 0 && (
            <div className="text-sm text-gray-500 py-8 text-center">
              {t('Ничего не найдено', 'Nothing found', locale)}
            </div>
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

        <div className="flex items-center justify-between px-8 py-5 border-t border-gray-100">
          <span className="text-sm text-gray-500">
            {t(
              `Выбрано: ${totalSelected}`,
              `Selected: ${totalSelected}`,
              locale,
            )}
          </span>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => onChange(new Set())}
              className="rounded-xl border border-gray-200 bg-white px-6 py-3 text-base font-medium text-gray-700 hover:bg-gray-50 transition-colors"
            >
              {t('Очистить', 'Clear', locale)}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl bg-gray-900 px-8 py-3 text-base font-medium text-white hover:bg-gray-800 transition-colors"
            >
              {t('Готово', 'Done', locale)}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
