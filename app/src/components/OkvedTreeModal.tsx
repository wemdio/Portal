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

  const isSection = /^[A-U]$/.test(node.code);

  return (
    <div>
      <div
        className="flex items-center gap-1 py-0.5 hover:bg-gray-50 rounded"
        style={{ paddingLeft: `${depth * 24}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggleExpand(node.code)}
            className="w-6 h-6 flex items-center justify-center text-gray-400 hover:text-gray-700 flex-shrink-0"
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
          <span className={`text-sm ${isSection ? 'font-bold' : ''}`}>
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
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-lg max-w-3xl w-full max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between p-5">
          <h3 className="text-lg font-bold">
            {t('Виды деятельности по ОКВЭД-2', 'Activity types (OKVED-2)', locale)}
          </h3>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-700 text-xl leading-none"
          >
            &times;
          </button>
        </div>

        <div className="px-5 pb-3">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('Быстрый поиск', 'Quick search', locale)}
            className="w-full border-b border-gray-200 px-2 py-2 text-sm focus:outline-none focus:border-blue-400"
          />
        </div>

        <div className="flex-1 overflow-y-auto px-5 pb-5">
          {filteredTree.length === 0 && (
            <div className="text-sm text-gray-500 py-4">
              {t('Ничего не найдено', 'Nothing found', locale)}
            </div>
          )}
          {filteredTree.map((section) => (
            <TreeNode
              key={section.code}
              node={section}
              selected={selected}
              onToggle={toggleNode}
              expanded={search.trim() ? expandedForSearch : expanded}
              onToggleExpand={toggleExpand}
              depth={0}
            />
          ))}
        </div>

        <div
          className="flex items-center justify-between p-4"
          style={{ boxShadow: '0 -1px 0 rgba(0,0,0,0.06)' }}
        >
          <span className="text-sm text-gray-600">
            {t(
              `Выбрано видов деятельности: ${totalSelected}`,
              `Activity types selected: ${totalSelected}`,
              locale,
            )}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onChange(new Set())}
              className="px-4 py-2 text-sm bg-gray-100 hover:bg-gray-200 rounded"
            >
              {t('Очистить', 'Clear', locale)}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
            >
              {t('Готово', 'Done', locale)}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
