'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

/**
 * Ячейка копируемой таблицы: строка или несколько строк (разбивка под суммой).
 * Строка-заголовок недели — `{ group }`, растягивается на всю ширину.
 */
export type CopyCell = string | number | string[];
export type CopyRow = CopyCell[] | { group: string };

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Таблица в буфер сразу в двух видах: HTML — в документ (Google Docs, Word)
 * вставится таблицей с рамками, текст с табуляциями — в таблицу (Sheets,
 * Excel) ляжет по ячейкам.
 */
export async function copyTable(headers: string[], rows: CopyRow[]): Promise<void> {
  const td = 'border:1px solid #999;padding:4px 6px;vertical-align:top';
  const htmlRows = rows.map((row) => {
    if (!Array.isArray(row)) {
      return `<tr><td colspan="${headers.length}" style="${td};font-weight:bold">${escapeHtml(row.group)}</td></tr>`;
    }
    return `<tr>${row.map((c) => `<td style="${td}">${
      Array.isArray(c) ? c.map((l) => escapeHtml(l)).join('<br>') : escapeHtml(String(c))
    }</td>`).join('')}</tr>`;
  });
  const html = `<table style="border-collapse:collapse"><thead><tr>${
    headers.map((h) => `<th style="${td};text-align:left">${escapeHtml(h)}</th>`).join('')
  }</tr></thead><tbody>${htmlRows.join('')}</tbody></table>`;

  const plain = [headers.join('\t'), ...rows.map((row) => (Array.isArray(row)
    ? row.map((c) => (Array.isArray(c) ? c.join('; ') : String(c))).join('\t')
    : row.group))].join('\n');

  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([plain], { type: 'text/plain' }),
    })]);
    return;
  }
  await navigator.clipboard.writeText(plain);
}

export function CopyTableButton({ headers, rows }: { headers: string[]; rows: CopyRow[] }) {
  const [state, setState] = useState<'idle' | 'done' | 'error'>('idle');
  const onClick = async () => {
    try {
      await copyTable(headers, rows);
      setState('done');
    } catch {
      setState('error');
    }
    setTimeout(() => setState('idle'), 2000);
  };
  return (
    <button
      type="button"
      onClick={() => { void onClick(); }}
      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-gray-500 hover:bg-gray-100 hover:text-gray-800 transition cursor-pointer"
    >
      {state === 'done' ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Copy className="h-3.5 w-3.5" />}
      {state === 'done' ? 'Скопировано' : state === 'error' ? 'Не удалось' : 'Скопировать'}
    </button>
  );
}
