'use client';

import React, { useState, useCallback, useMemo, useRef, memo, useEffect } from 'react';
import { FileText, ExternalLink, Loader2, Download, Search, FileSpreadsheet, Check, History, RefreshCw } from 'lucide-react';
import type * as XLSXTypes from 'xlsx';
import type ExcelJSTypes from 'exceljs';
import { supabase } from '@/lib/supabaseClient';

const ROW_HEIGHT = 44;
const OVERSCAN = 8;
const INSTANTLY_ANALYTICS_URL_BASE = 'https://app.instantly.ai/app/campaign/';

interface InstantlyCampaignItem {
  id: string;
  name: string;
  status?: number;
  timestamp_created?: string;
  timestamp_updated?: string;
}

interface CampaignsListMeta {
  source: 'database' | 'instantly_fallback' | 'instantly_direct';
  lastSyncedAt: string | null;
  stale: boolean;
  backgroundSync: boolean;
}

function formatCampaignTimestamp(value: string | null | undefined): string | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (Number.isFinite(ms)) {
    return new Date(ms).toLocaleString('ru-RU', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  return raw;
}

const CampaignRow = memo(function CampaignRow({
  campaign,
  isChecked,
  onToggle,
}: {
  campaign: InstantlyCampaignItem;
  isChecked: boolean;
  onToggle: (id: string) => void;
}) {
  const createdLabel =
    formatCampaignTimestamp(campaign.timestamp_created) ??
    formatCampaignTimestamp(campaign.timestamp_updated);

  return (
    <li>
      <label
        htmlFor={`camp-${campaign.id}`}
        className={`flex items-center gap-3 rounded-lg px-3 py-2.5 cursor-pointer transition-colors h-[38px] box-border ${
          isChecked
            ? 'bg-indigo-50 border border-indigo-100'
            : 'bg-gray-50/80 border border-transparent hover:bg-gray-100/90 hover:border-gray-200'
        }`}
      >
        <input
          type="checkbox"
          id={`camp-${campaign.id}`}
          checked={isChecked}
          onChange={() => onToggle(campaign.id)}
          className="sr-only"
        />
        <span
          className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 transition-colors ${
            isChecked ? 'border-indigo-600 bg-indigo-600 text-white' : 'border-gray-300 bg-white text-transparent'
          }`}
        >
          <Check className="h-3 w-3 stroke-[3]" />
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-sm font-medium text-gray-800 break-words truncate">
            {campaign.name || campaign.id}
          </span>
          {createdLabel ? (
            <span className="block text-[11px] leading-4 text-gray-500 truncate">
              Добавлено: {createdLabel}
            </span>
          ) : null}
        </span>
        <a
          href={`${INSTANTLY_ANALYTICS_URL_BASE}${campaign.id}/analytics`}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="shrink-0 rounded p-1.5 text-gray-400 hover:bg-gray-200 hover:text-indigo-600 transition-colors"
          title="Открыть аналитику в Instantly"
        >
          <ExternalLink className="h-4 w-4" />
        </a>
      </label>
    </li>
  );
});

interface ReportSummary {
  totalCampaigns: number;
  totalContacts: number;
  totalEmailsSent: number;
  totalOpened: number;
  totalReplies: number;
  totalLeads: number;
  totalBounced: number;
  conversion: { openPctAllEmails: string; replyPctByLeads: string };
}

interface ReportResponse {
  tableText: string;
  csvText: string;
  rows: (string | number)[][];
  summary: ReportSummary;
  campaignData: Record<string, unknown>;
}

const REPORT_HISTORY_KEY = 'portal:auto-report:history';
const REPORT_HISTORY_MAX = 20;

interface SavedReport {
  id: string;
  createdAt: string;
  report: ReportResponse;
}

function loadReportHistory(): SavedReport[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(REPORT_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as SavedReport[]) : [];
  } catch {
    return [];
  }
}

function saveReportHistory(items: SavedReport[]) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(REPORT_HISTORY_KEY, JSON.stringify(items.slice(0, REPORT_HISTORY_MAX)));
  } catch {
    // ignore
  }
}

/** Типы для отображения отчёта (совпадают со структурой из autoReportBuilder). */
interface CampaignStepView {
  stepName: string;
  totalSent: number;
  totalOpened: number;
  totalReplied: number;
  totalClicked: number;
  totalOpportunities: number;
  variants: Record<
    string,
    { letter: string; sent: number; opened: number; replied: number; clicked: number; opportunities: number }
  >;
}

interface CampaignRecordView {
  name: string;
  contacts: number;
  opened: number;
  replies: number;
  leads: number;
  bounced: number;
  totalEmailsSent: number;
  steps: Record<number, CampaignStepView>;
}

const REPORT_COLORS = {
  titleBg: '#1E4E79',
  headerBg: '#5B9BD5',
  sectionSubheaderBg: '#D9E1F2',
  stepRowBg: '#E2EFDA', // оттенок зелёного для строк Step в детализации
  border: '#d1d5db',
} as const;

/** Цвета для выгрузки в Excel (как на образце: зелёный заголовок, светлая полоса периода). */
const EXCEL_COLORS = {
  titleBg: 'FF006400' as const,       // тёмно-зелёный
  periodBg: 'FFD9EAD3' as const,      // светло-зелёный
  tableHeaderBg: 'FFB6D7A8' as const,  // зелёный для заголовков таблиц и названий столбцов
  stepRowBg: 'FFE2EFDA' as const,      // оттенок зелёного для строк Step
  border: 'FFD1D5DB' as const,        // серый
  white: 'FFFFFFFF' as const,
  black: 'FF000000' as const,
};

const thinGrayBorder = {
  top: { style: 'thin' as const, color: { argb: EXCEL_COLORS.border } },
  left: { style: 'thin' as const, color: { argb: EXCEL_COLORS.border } },
  bottom: { style: 'thin' as const, color: { argb: EXCEL_COLORS.border } },
  right: { style: 'thin' as const, color: { argb: EXCEL_COLORS.border } },
};

function setCellStyle(
  cell: ExcelJSTypes.Cell,
  opts: { fill?: string; fontBold?: boolean; fontColor?: string; border?: boolean }
) {
  if (opts.fill) {
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: opts.fill },
    };
  }
  if (opts.fontBold !== undefined || opts.fontColor !== undefined) {
    const current = (cell.font || {}) as { bold?: boolean; color?: { argb: string } };
    cell.font = {
      bold: opts.fontBold ?? current.bold,
      color: opts.fontColor ? { argb: opts.fontColor } : current.color,
    };
  }
  if (opts.border !== false) {
    cell.border = thinGrayBorder;
  }
}

function num(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

function StyledReportView({
  summary,
  campaignData,
  periodText,
}: {
  summary: ReportSummary;
  campaignData: Record<string, CampaignRecordView>;
  periodText: string;
}) {
  const campaigns = Object.values(campaignData);

  const cell = 'px-3 py-2 text-sm border border-gray-300';
  const headerCell = `${cell} font-semibold text-white`;
  const sectionSubheaderCell = `${cell} font-semibold text-gray-900`;

  return (
    <div className="rounded-lg overflow-hidden border border-gray-300">
      {/* Заголовок отчёта — тёмно-синий фон, белый текст */}
      <div
        className="px-4 py-3"
        style={{ backgroundColor: REPORT_COLORS.titleBg }}
      >
        <h2 className="text-xl font-bold text-white">Отчёт по email-кампании</h2>
        <p className="text-sm text-white/90 mt-0.5">{periodText}</p>
      </div>

      <div className="bg-white">
        {/* Статистика по кампаниям */}
        <div className="px-4 pt-4 pb-2">
          <p className="text-sm font-bold text-gray-900 mb-0">Статистика по кампаниям:</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th
                  className={`${headerCell} text-left`}
                  style={{ backgroundColor: REPORT_COLORS.headerBg }}
                >
                  Название кампании
                </th>
                <th
                  className={headerCell}
                  style={{ backgroundColor: REPORT_COLORS.headerBg }}
                >
                  Контактов
                </th>
                <th
                  className={headerCell}
                  style={{ backgroundColor: REPORT_COLORS.headerBg }}
                >
                  Уник. открытий
                </th>
                <th
                  className={headerCell}
                  style={{ backgroundColor: REPORT_COLORS.headerBg }}
                >
                  % открываемости
                </th>
                <th
                  className={headerCell}
                  style={{ backgroundColor: REPORT_COLORS.headerBg }}
                >
                  Ответов
                </th>
                <th
                  className={headerCell}
                  style={{ backgroundColor: REPORT_COLORS.headerBg }}
                >
                  % ответов
                </th>
                <th
                  className={headerCell}
                  style={{ backgroundColor: REPORT_COLORS.headerBg }}
                >
                  Лидов
                </th>
                <th
                  className={headerCell}
                  style={{ backgroundColor: REPORT_COLORS.headerBg }}
                >
                  Отправлено писем
                </th>
                <th
                  className={headerCell}
                  style={{ backgroundColor: REPORT_COLORS.headerBg }}
                >
                  Остаток базы
                </th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c) => {
                const openPct =
                  c.totalEmailsSent > 0
                    ? ((num(c.opened) / c.totalEmailsSent) * 100).toFixed(1)
                    : '0.0';
                const replyPct =
                  c.contacts > 0 ? ((c.replies / c.contacts) * 100).toFixed(1) : '0.0';
                const remainingBase = Math.max(0, c.leads - c.contacts);
                return (
                  <tr key={c.name} className="bg-white">
                    <td className={`${cell} text-gray-900`}>{c.name}</td>
                    <td className={`${cell} text-gray-900 text-right`}>{c.contacts}</td>
                    <td className={`${cell} text-gray-900 text-right`}>{c.opened}</td>
                    <td className={`${cell} text-gray-900 text-right`}>{openPct}%</td>
                    <td className={`${cell} text-gray-900 text-right`}>{c.replies}</td>
                    <td className={`${cell} text-gray-900 text-right`}>{replyPct}%</td>
                    <td className={`${cell} text-gray-900 text-right`}>{c.leads}</td>
                    <td className={`${cell} text-gray-900 text-right`}>{c.totalEmailsSent}</td>
                    <td className={`${cell} text-gray-900 text-right`}>{remainingBase}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Общая статистика */}
        <div className="px-4 pt-6 pb-2">
          <p className="text-sm font-bold text-gray-900 mb-0">Общая статистика:</p>
        </div>
        <div className="overflow-x-auto px-4 pb-4">
          <table className="w-full border-collapse max-w-xl">
            <thead>
              <tr>
                <th
                  className={`${headerCell} text-left`}
                  style={{ backgroundColor: REPORT_COLORS.headerBg }}
                >
                  Показатель
                </th>
                <th
                  className={headerCell}
                  style={{ backgroundColor: REPORT_COLORS.headerBg }}
                >
                  Значение
                </th>
                <th
                  className={headerCell}
                  style={{ backgroundColor: REPORT_COLORS.headerBg }}
                >
                  Конверсия в следующий этап
                </th>
              </tr>
            </thead>
            <tbody>
              <tr className="bg-white">
                <td className={`${cell} font-medium text-gray-900`}>Общее количество контактов</td>
                <td className={`${cell} text-gray-900`}>{summary.totalContacts}</td>
                <td className={cell} />
              </tr>
              <tr className="bg-white">
                <td className={`${cell} font-medium text-gray-900`}>
                  Общее количество отправленных писем
                </td>
                <td className={`${cell} text-gray-900`}>{summary.totalEmailsSent}</td>
                <td className={cell} />
              </tr>
              <tr className="bg-white">
                <td className={`${cell} font-medium text-gray-900`}>
                  Общее количество открытий
                </td>
                <td className={`${cell} text-gray-900`}>{summary.totalOpened}</td>
                <td className={`${cell} text-gray-900`}>{summary.conversion.openPctAllEmails}%</td>
              </tr>
              <tr className="bg-white">
                <td className={`${cell} font-medium text-gray-900`}>
                  Общее количество ответов
                </td>
                <td className={`${cell} text-gray-900`}>{summary.totalReplies}</td>
                <td className={`${cell} text-gray-900`}>{summary.conversion.replyPctByLeads}%</td>
              </tr>
              <tr className="bg-white">
                <td className={`${cell} font-medium text-gray-900`}>Общее количество лидов</td>
                <td className={`${cell} text-gray-900`}>{summary.totalLeads}</td>
                <td className={cell} />
              </tr>
              <tr className="bg-white">
                <td className={`${cell} font-medium text-gray-900`}>
                  Общее количество бракованных
                </td>
                <td className={`${cell} text-gray-900`}>{summary.totalBounced}</td>
                <td className={cell} />
              </tr>
            </tbody>
          </table>
        </div>

        {/* Детализация по письмам */}
        <div className="px-4 pt-2 pb-2">
          <p className="text-sm font-bold text-gray-900 mb-0">Детализация по письмам:</p>
        </div>
        <div className="overflow-x-auto pb-4">
          {campaigns.map((c) => (
            <div key={c.name} className="mb-4">
              <table className="w-full border-collapse">
                <tbody>
                  <tr>
                    <td
                      colSpan={6}
                      className={`${sectionSubheaderCell} border-gray-300`}
                      style={{ backgroundColor: REPORT_COLORS.sectionSubheaderBg }}
                    >
                      {c.name}
                    </td>
                  </tr>
                  <tr>
                    <th
                      className={`${headerCell} text-left`}
                      style={{ backgroundColor: REPORT_COLORS.headerBg }}
                    >
                      STEP
                    </th>
                    <th
                      className={headerCell}
                      style={{ backgroundColor: REPORT_COLORS.headerBg }}
                    >
                      SENT
                    </th>
                    <th
                      className={headerCell}
                      style={{ backgroundColor: REPORT_COLORS.headerBg }}
                    >
                      OPENED
                    </th>
                    <th
                      className={headerCell}
                      style={{ backgroundColor: REPORT_COLORS.headerBg }}
                    >
                      REPLIED
                    </th>
                    <th
                      className={headerCell}
                      style={{ backgroundColor: REPORT_COLORS.headerBg }}
                    >
                      CLICKED
                    </th>
                    <th
                      className={headerCell}
                      style={{ backgroundColor: REPORT_COLORS.headerBg }}
                    >
                      OPPORTUNITIES
                    </th>
                  </tr>
                  {Object.keys(c.steps)
                    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
                    .map((stepKey) => {
                      const step = c.steps[Number(stepKey)];
                      const stepOpenPct =
                        step.totalSent > 0
                          ? ((step.totalOpened / step.totalSent) * 100).toFixed(1)
                          : '0.0';
                      const stepReplyPct =
                        step.totalSent > 0
                          ? ((step.totalReplied / step.totalSent) * 100).toFixed(1)
                          : '0.0';
                      return (
                        <React.Fragment key={`${c.name}-${stepKey}`}>
                          <tr style={{ backgroundColor: REPORT_COLORS.stepRowBg }}>
                            <td className={`${cell} font-semibold text-gray-900`}>
                              {step.stepName}
                            </td>
                            <td className={`${cell} text-gray-900 text-right`}>
                              {step.totalSent}
                            </td>
                            <td className={`${cell} text-gray-900 text-right`}>
                              {step.totalOpened}|{stepOpenPct}%
                            </td>
                            <td className={`${cell} text-gray-900 text-right`}>
                              {step.totalReplied}|{stepReplyPct}%
                            </td>
                            <td className={`${cell} text-gray-900 text-right`}>
                              {step.totalClicked}
                            </td>
                            <td className={`${cell} text-gray-900 text-right`}>
                              {step.totalOpportunities}
                            </td>
                          </tr>
                          {Object.keys(step.variants)
                            .sort()
                            .map((letter) => {
                              const v = step.variants[letter];
                              const vOpen =
                                v.sent > 0 ? ((v.opened / v.sent) * 100).toFixed(0) : '0';
                              const vReply =
                                v.sent > 0 ? ((v.replied / v.sent) * 100).toFixed(0) : '0';
                              return (
                                <tr
                                  key={`${c.name}-${stepKey}-${letter}`}
                                  className="bg-white"
                                >
                                  <td className={`${cell} text-gray-900`}>{v.letter}</td>
                                  <td className={`${cell} text-gray-900 text-right`}>
                                    {v.sent}
                                  </td>
                                  <td className={`${cell} text-gray-900 text-right`}>
                                    {v.opened}|{vOpen}%
                                  </td>
                                  <td className={`${cell} text-gray-900 text-right`}>
                                    {v.replied}|{vReply}%
                                  </td>
                                  <td className={`${cell} text-gray-900 text-right`}>
                                    {v.clicked}
                                  </td>
                                  <td className={`${cell} text-gray-900 text-right`}>
                                    {v.opportunities}
                                  </td>
                                </tr>
                              );
                            })}
                        </React.Fragment>
                      );
                    })}
                  {Object.keys(c.steps).length === 0 && (
                    <tr className="bg-white">
                      <td className={`${cell} font-semibold text-gray-900`}>
                        Общая статистика
                      </td>
                      <td className={`${cell} text-gray-900 text-right`}>
                        {c.totalEmailsSent}
                      </td>
                      <td className={`${cell} text-gray-900 text-right`}>
                        {num(c.opened)}|
                        {c.totalEmailsSent > 0
                          ? ((num(c.opened) / c.totalEmailsSent) * 100).toFixed(1)
                          : '0.0'}
                        %
                      </td>
                      <td className={`${cell} text-gray-900 text-right`}>
                        {c.replies}|
                        {c.contacts > 0
                          ? ((c.replies / c.contacts) * 100).toFixed(1)
                          : '0.0'}
                        %
                      </td>
                      <td className={`${cell} text-gray-900 text-right`}>0</td>
                      <td className={`${cell} text-gray-900 text-right`}>0</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

async function getToken(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? '';
}

function downloadCsv(csvText: string, filename: string) {
  const blob = new Blob(['\uFEFF' + csvText], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function tableTextToRows(tableText: string): string[][] {
  return tableText.split('\n').map((line) => line.split('\t'));
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function buildSheetsHtmlReport({
  summary,
  campaignData,
  periodText,
}: {
  summary: ReportSummary;
  campaignData: Record<string, CampaignRecordView>;
  periodText: string;
}): string {
  const campaigns = Object.values(campaignData);

  const SHEETS_COL_A_WIDTH_PX = 278;

  const css = {
    table: `border-collapse:collapse; table-layout:fixed; width:auto; font-family: Arial, Helvetica, sans-serif;`,
    th: `background:${REPORT_COLORS.headerBg}; color:#ffffff; font-weight:700; font-size:12px; border:1px solid ${REPORT_COLORS.border}; padding:8px 10px;`,
    td: `font-size:12px; border:1px solid ${REPORT_COLORS.border}; padding:8px 10px; color:#111827; white-space:normal; word-break:break-word;`,
    tdRight: `text-align:right;`,
    colA: `width:${SHEETS_COL_A_WIDTH_PX}px; min-width:${SHEETS_COL_A_WIDTH_PX}px; max-width:${SHEETS_COL_A_WIDTH_PX}px;`,
    subheader: `background:${REPORT_COLORS.sectionSubheaderBg}; font-weight:700;`,
    stepRow: `background:${REPORT_COLORS.stepRowBg}; font-weight:700;`,
    titleCell: `background:${REPORT_COLORS.titleBg}; color:#ffffff; font-weight:700; font-size:18px; padding:10px 12px;`,
    periodCell: `background:${REPORT_COLORS.titleBg}; color:rgba(255,255,255,0.9); font-size:12px; padding:0 12px 10px 12px;`,
    sectionCell: `background:#ffffff; font-weight:700; font-size:12px; color:#111827; padding:12px 12px 6px 12px;`,
  } as const;

  const colWidthsPx = [SHEETS_COL_A_WIDTH_PX, 96, 130, 120, 90, 90, 90, 140, 120] as const;
  const colgroup = `<colgroup>${colWidthsPx
    .map((w) => `<col style="width:${w}px" width="${w}">`)
    .join('')}</colgroup>`;

  const rows: string[] = [];

  const tr = (cells: string) => `<tr>${cells}</tr>`;
  const td = (content: string, style: string, colspan?: number) =>
    `<td${colspan ? ` colspan="${colspan}"` : ''} style="${style}">${content}</td>`;
  // Google Sheets часто игнорирует `color` у `<th>` при вставке HTML из буфера,
  // поэтому делаем заголовки как `<td>` со стилем (визуально это то же самое).
  const th = (content: string, style: string, colspan?: number) =>
    `<td${colspan ? ` colspan="${colspan}"` : ''} style="${style}">${content}</td>`;

  // Title + Period (merged across A..I)
  // Важно: `css.td` содержит `color:#111827` и может перетирать белый текст заголовка,
  // поэтому специфичные стили (title/period) должны быть ПОСЛЕ базовых.
  rows.push(tr(td('Отчёт по email-кампании', `${css.td}; ${css.titleCell}`, 9)));
  rows.push(tr(td(escapeHtml(periodText), `${css.td}; ${css.periodCell}`, 9)));

  // Spacer
  rows.push(tr(td('&nbsp;', `${css.td}; padding:6px 0; border-left:1px solid ${REPORT_COLORS.border}; border-right:1px solid ${REPORT_COLORS.border};`, 9)));

  // Campaign stats section
  rows.push(tr(td('Статистика по кампаниям:', `${css.sectionCell}; ${css.td}`, 9)));
  rows.push(
    tr(
      [
        th('Название кампании', `${css.th}; text-align:left; ${css.colA}`),
        th('Контактов', css.th),
        th('Уник. открытий', css.th),
        th('% открываемости', css.th),
        th('Ответов', css.th),
        th('% ответов', css.th),
        th('Лидов', css.th),
        th('Отправлено писем', css.th),
        th('Остаток базы', css.th),
      ].join('')
    )
  );
  for (const c of campaigns) {
    const openPct =
      c.totalEmailsSent > 0 ? ((num(c.opened) / c.totalEmailsSent) * 100).toFixed(1) : '0.0';
    const replyPct = c.contacts > 0 ? ((c.replies / c.contacts) * 100).toFixed(1) : '0.0';
    const remainingBase = Math.max(0, c.leads - c.contacts);
    rows.push(
      tr(
        [
          td(escapeHtml(c.name), `${css.td}; ${css.colA}`),
          td(String(c.contacts), `${css.td}; ${css.tdRight}`),
          td(String(c.opened), `${css.td}; ${css.tdRight}`),
          td(`${openPct}%`, `${css.td}; ${css.tdRight}`),
          td(String(c.replies), `${css.td}; ${css.tdRight}`),
          td(`${replyPct}%`, `${css.td}; ${css.tdRight}`),
          td(String(c.leads), `${css.td}; ${css.tdRight}`),
          td(String(c.totalEmailsSent), `${css.td}; ${css.tdRight}`),
          td(String(remainingBase), `${css.td}; ${css.tdRight}`),
        ].join('')
      )
    );
  }

  // Spacer
  rows.push(tr(td('&nbsp;', `${css.td}; padding:8px 0;`, 9)));

  // Overall section (use A..C; merge D..I as empty)
  rows.push(tr(td('Общая статистика:', `${css.sectionCell}; ${css.td}`, 9)));
  rows.push(
    tr(
      [
        th('Показатель', `${css.th}; text-align:left; ${css.colA}`),
        th('Значение', css.th),
        th('Конверсия в следующий этап', css.th),
        td('&nbsp;', `${css.td}; border-left:none;`, 6),
      ].join('')
    )
  );
  const overallRows: Array<[string, string, string]> = [
    ['Общее количество контактов', String(summary.totalContacts), ''],
    ['Общее количество отправленных писем', String(summary.totalEmailsSent), ''],
    ['Общее количество открытий', String(summary.totalOpened), `${summary.conversion.openPctAllEmails}%`],
    ['Общее количество ответов', String(summary.totalReplies), `${summary.conversion.replyPctByLeads}%`],
    ['Общее количество лидов', String(summary.totalLeads), ''],
    ['Общее количество бракованных', String(summary.totalBounced), ''],
  ];
  for (const [label, value, conv] of overallRows) {
    rows.push(
      tr(
        [
          td(escapeHtml(label), `${css.td}; ${css.colA}; font-weight:600; white-space:normal;`),
          td(escapeHtml(value), css.td),
          td(escapeHtml(conv), css.td),
          td('&nbsp;', `${css.td}; border-left:none;`, 6),
        ].join('')
      )
    );
  }

  // Spacer
  rows.push(tr(td('&nbsp;', `${css.td}; padding:8px 0;`, 9)));

  // Details section (use A..F; merge G..I)
  rows.push(tr(td('Детализация по письмам:', `${css.sectionCell}; ${css.td}`, 9)));

  for (const c of campaigns) {
    rows.push(
      tr([td(escapeHtml(c.name), `${css.td}; ${css.subheader}`, 6), td('&nbsp;', `${css.td}; border-left:none;`, 3)].join(''))
    );
    rows.push(
      tr(
        [
          th('STEP', `${css.th}; text-align:left; ${css.colA}`),
          th('SENT', css.th),
          th('OPENED', css.th),
          th('REPLIED', css.th),
          th('CLICKED', css.th),
          th('OPPORTUNITIES', css.th),
          td('&nbsp;', `${css.td}; border-left:none;`, 3),
        ].join('')
      )
    );

    const stepKeys = Object.keys(c.steps).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    if (stepKeys.length === 0) {
      const openPct =
        c.totalEmailsSent > 0 ? ((num(c.opened) / c.totalEmailsSent) * 100).toFixed(1) : '0.0';
      const replyPct = c.contacts > 0 ? ((c.replies / c.contacts) * 100).toFixed(1) : '0.0';
      rows.push(
        tr(
          [
            td('Общая статистика', `${css.td}; ${css.colA}; font-weight:700;`),
            td(String(c.totalEmailsSent), `${css.td}; ${css.tdRight}`),
            td(`${num(c.opened)}|${openPct}%`, `${css.td}; ${css.tdRight}`),
            td(`${c.replies}|${replyPct}%`, `${css.td}; ${css.tdRight}`),
            td('0', `${css.td}; ${css.tdRight}`),
            td('0', `${css.td}; ${css.tdRight}`),
            td('&nbsp;', `${css.td}; border-left:none;`, 3),
          ].join('')
        )
      );
    } else {
      for (const stepKey of stepKeys) {
        const step = c.steps[Number(stepKey)];
        const stepOpenPct =
          step.totalSent > 0 ? ((step.totalOpened / step.totalSent) * 100).toFixed(1) : '0.0';
        const stepReplyPct =
          step.totalSent > 0 ? ((step.totalReplied / step.totalSent) * 100).toFixed(1) : '0.0';
        rows.push(
          tr(
            [
              td(escapeHtml(step.stepName), `${css.td}; ${css.colA}; ${css.stepRow}`),
              td(String(step.totalSent), `${css.td}; ${css.tdRight}; ${css.stepRow}`),
              td(`${step.totalOpened}|${stepOpenPct}%`, `${css.td}; ${css.tdRight}; ${css.stepRow}`),
              td(`${step.totalReplied}|${stepReplyPct}%`, `${css.td}; ${css.tdRight}; ${css.stepRow}`),
              td(String(step.totalClicked), `${css.td}; ${css.tdRight}; ${css.stepRow}`),
              td(String(step.totalOpportunities), `${css.td}; ${css.tdRight}; ${css.stepRow}`),
              td('&nbsp;', `${css.td}; border-left:none;`, 3),
            ].join('')
          )
        );
        const variantKeys = Object.keys(step.variants).sort();
        for (const letter of variantKeys) {
          const v = step.variants[letter];
          const vOpen = v.sent > 0 ? ((v.opened / v.sent) * 100).toFixed(0) : '0';
          const vReply = v.sent > 0 ? ((v.replied / v.sent) * 100).toFixed(0) : '0';
          rows.push(
            tr(
              [
                td(escapeHtml(v.letter), `${css.td}; ${css.colA}`),
                td(String(v.sent), `${css.td}; ${css.tdRight}`),
                td(`${v.opened}|${vOpen}%`, `${css.td}; ${css.tdRight}`),
                td(`${v.replied}|${vReply}%`, `${css.td}; ${css.tdRight}`),
                td(String(v.clicked), `${css.td}; ${css.tdRight}`),
                td(String(v.opportunities), `${css.td}; ${css.tdRight}`),
                td('&nbsp;', `${css.td}; border-left:none;`, 3),
              ].join('')
            )
          );
        }
      }
    }

    // Spacer between campaigns
    rows.push(tr(td('&nbsp;', `${css.td}; padding:8px 0;`, 9)));
  }

  return `
    <table style="${css.table}">
      ${colgroup}
      <tbody>
        ${rows.join('')}
      </tbody>
    </table>
  `.trim();
}

async function copyStyledReportToSheets({
  summary,
  campaignData,
  periodText,
  fallbackText,
}: {
  summary: ReportSummary;
  campaignData: Record<string, CampaignRecordView>;
  periodText: string;
  fallbackText: string;
}) {
  const html = buildSheetsHtmlReport({ summary, campaignData, periodText });
  const htmlBlob = new Blob([html], { type: 'text/html' });
  const textBlob = new Blob([fallbackText], { type: 'text/plain' });

  if (navigator.clipboard && 'write' in navigator.clipboard && typeof ClipboardItem !== 'undefined') {
    await navigator.clipboard.write([new ClipboardItem({ 'text/html': htmlBlob, 'text/plain': textBlob })]);
    return;
  }

  await navigator.clipboard.writeText(fallbackText);
}

function getColumnWidths(rows: (string | number)[][]): { wch: number }[] {
  if (!rows.length) return [];
  const numCols = rows.reduce((max, r) => (r.length > max ? r.length : max), 0);
  const widths: number[] = Array.from({ length: numCols }, () => 10);
  for (const row of rows) {
    row.forEach((cell, c) => {
      const len = String(cell).length;
      if (c < widths.length && len > widths[c]) widths[c] = Math.min(len, 65);
    });
  }
  return widths.map((w) => ({ wch: Math.max(w + 2, 12) }));
}

function setSheetColumnWidths(ws: XLSXTypes.WorkSheet, rows: (string | number)[][]) {
  const cols = getColumnWidths(rows);
  if (cols.length) ws['!cols'] = cols;
}

async function downloadExcel(tableText: string, summaryRows: (string | number)[][], filename: string) {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  const fullReportRows = tableTextToRows(tableText);
  const wsReport = XLSX.utils.aoa_to_sheet(fullReportRows);
  setSheetColumnWidths(wsReport, fullReportRows);
  XLSX.utils.book_append_sheet(wb, wsReport, 'Отчёт');
  if (summaryRows.length > 0) {
    const wsSummary = XLSX.utils.aoa_to_sheet(summaryRows);
    setSheetColumnWidths(wsSummary, summaryRows);
    XLSX.utils.book_append_sheet(wb, wsSummary, 'Сводка');
  }
  const buffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function downloadExcelFormatted(
  summary: ReportSummary,
  campaignData: Record<string, CampaignRecordView>,
  periodText: string,
  filename: string
) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Отчёт', { views: [{ rightToLeft: false }] });

  ws.columns = [
    { width: 42 },
    { width: 12 },
    { width: 28 },
    { width: 14 },
    { width: 26 },  
    { width: 15 },
    { width: 10 },
    { width: 16 },
    { width: 15 },
  ];

  let row = 1;

  const mergeAndStyle = (r: number, _from: string, _to: string, value: string, fill: string, fontColor: string) => {
    ws.mergeCells(`A${r}:I${r}`);
    const cell = ws.getCell(r, 1);
    cell.value = value;
    setCellStyle(cell, { fill, fontBold: true, fontColor, border: true });
  };

  mergeAndStyle(row, 'A', 'I', 'Отчёт по email-кампании', EXCEL_COLORS.titleBg, EXCEL_COLORS.white);
  row += 1;
  mergeAndStyle(row, 'A', 'I', periodText, EXCEL_COLORS.periodBg, EXCEL_COLORS.black);
  row += 2;

  ws.getCell(row, 1).value = 'Статистика по кампаниям:';
  setCellStyle(ws.getCell(row, 1), { fontBold: true });
  row += 1;

  const campaignHeaders = [
    'Название кампании',
    'Контактов',
    'Отправлено писем',
    'Открытий',
    '% открытий всех писем',
    'Ответов',
    '% ответов',
    'Лидов',
    'Остаток базы',
  ];
  campaignHeaders.forEach((h, c) => {
    const cell = ws.getCell(row, c + 1);
    cell.value = h;
    setCellStyle(cell, { fontBold: true, fill: EXCEL_COLORS.tableHeaderBg });
  });
  row += 1;

  const campaigns = Object.values(campaignData);
  campaigns.forEach((c) => {
    const openPct =
      c.totalEmailsSent > 0 ? ((num(c.opened) / c.totalEmailsSent) * 100).toFixed(1) : '0.0';
    const replyPct = c.contacts > 0 ? ((c.replies / c.contacts) * 100).toFixed(1) : '0.0';
    const remainingBase = Math.max(0, c.leads - c.contacts);
    const values = [
      c.name,
      c.contacts,
      c.totalEmailsSent,
      c.opened,
      `${openPct}%`,
      c.replies,
      `${replyPct}%`,
      c.leads,
      remainingBase,
    ];
    values.forEach((v, col) => {
      const cell = ws.getCell(row, col + 1);
      cell.value = v;
      setCellStyle(cell, {});
    });
    row += 1;
  });

  row += 1;
  ws.getCell(row, 1).value = 'Общая статистика:';
  setCellStyle(ws.getCell(row, 1), { fontBold: true });
  row += 1;

  const overallHeaders = ['Показатель', 'Значение', 'Конверсия в следующий этап'];
  overallHeaders.forEach((h, c) => {
    const cell = ws.getCell(row, c + 1);
    cell.value = h;
    setCellStyle(cell, { fontBold: true, fill: EXCEL_COLORS.tableHeaderBg });
  });
  row += 1;

  const totalOpenPct =
    summary.totalEmailsSent > 0
      ? ((summary.totalOpened / summary.totalEmailsSent) * 100).toFixed(1)
      : '0.0';
  const totalReplyPct =
    summary.totalContacts > 0
      ? ((summary.totalReplies / summary.totalContacts) * 100).toFixed(1)
      : '0.0';
  const overallRows: (string | number)[][] = [
    ['Общее количество контактов', summary.totalContacts, ''],
    ['Общее количество отправленных писем', summary.totalEmailsSent, ''],
    ['Общее количество открытий', summary.totalOpened, `${totalOpenPct}%`],
    ['Общее количество ответов', summary.totalReplies, `${totalReplyPct}%`],
    ['Общее количество лидов', summary.totalLeads, ''],
    ['Общее количество бракованных', summary.totalBounced, ''],
  ];
  overallRows.forEach((rValues) => {
    rValues.forEach((v, col) => {
      const cell = ws.getCell(row, col + 1);
      cell.value = v;
      setCellStyle(cell, {});
    });
    row += 1;
  });

  row += 1;
  ws.getCell(row, 1).value = 'Детализация по письмам:';
  setCellStyle(ws.getCell(row, 1), { fontBold: true });
  row += 2;

  const detailHeaders = ['STEP', 'SENT', 'OPENED', 'REPLIED', 'CLICKED', 'OPPORTUNITIES'];
  campaigns.forEach((c) => {
    ws.getCell(row, 1).value = c.name;
    setCellStyle(ws.getCell(row, 1), { fontBold: true });
    row += 1;
    detailHeaders.forEach((h, col) => {
      const cell = ws.getCell(row, col + 1);
      cell.value = h;
      setCellStyle(cell, { fontBold: true, fill: EXCEL_COLORS.tableHeaderBg });
    });
    row += 1;

    const stepKeys = Object.keys(c.steps).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    if (stepKeys.length === 0) {
      const openPct =
        c.totalEmailsSent > 0 ? ((num(c.opened) / c.totalEmailsSent) * 100).toFixed(1) : '0.0';
      const replyPct = c.contacts > 0 ? ((c.replies / c.contacts) * 100).toFixed(1) : '0.0';
      ws.getCell(row, 1).value = 'Общая статистика';
      setCellStyle(ws.getCell(row, 1), { fontBold: true });
      ws.getCell(row, 2).value = c.totalEmailsSent;
      ws.getCell(row, 3).value = `${num(c.opened)}|${openPct}%`;
      ws.getCell(row, 4).value = `${c.replies}|${replyPct}%`;
      ws.getCell(row, 5).value = 0;
      ws.getCell(row, 6).value = 0;
      for (let col = 1; col <= 6; col++) setCellStyle(ws.getCell(row, col), {});
      row += 1;
    } else {
      stepKeys.forEach((stepKey) => {
        const step = c.steps[Number(stepKey)];
        const stepOpenPct =
          step.totalSent > 0 ? ((step.totalOpened / step.totalSent) * 100).toFixed(1) : '0.0';
        const stepReplyPct =
          step.totalSent > 0 ? ((step.totalReplied / step.totalSent) * 100).toFixed(1) : '0.0';
        ws.getCell(row, 1).value = step.stepName;
        setCellStyle(ws.getCell(row, 1), { fontBold: true, fill: EXCEL_COLORS.stepRowBg });
        ws.getCell(row, 2).value = step.totalSent;
        ws.getCell(row, 3).value = `${step.totalOpened}|${stepOpenPct}%`;
        ws.getCell(row, 4).value = `${step.totalReplied}|${stepReplyPct}%`;
        ws.getCell(row, 5).value = step.totalClicked;
        ws.getCell(row, 6).value = step.totalOpportunities;
        for (let col = 1; col <= 6; col++)
          setCellStyle(ws.getCell(row, col), { fill: EXCEL_COLORS.stepRowBg });
        row += 1;
        Object.keys(step.variants)
          .sort()
          .forEach((letter) => {
            const v = step.variants[letter];
            const vOpen = v.sent > 0 ? ((v.opened / v.sent) * 100).toFixed(0) : '0';
            const vReply = v.sent > 0 ? ((v.replied / v.sent) * 100).toFixed(0) : '0';
            ws.getCell(row, 1).value = v.letter;
            ws.getCell(row, 2).value = v.sent;
            ws.getCell(row, 3).value = `${v.opened}|${vOpen}%`;
            ws.getCell(row, 4).value = `${v.replied}|${vReply}%`;
            ws.getCell(row, 5).value = v.clicked;
            ws.getCell(row, 6).value = v.opportunities;
            for (let col = 1; col <= 6; col++) setCellStyle(ws.getCell(row, col), {});
            row += 1;
          });
      });
    }
    row += 1;
  });

  const buffer = await wb.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function normalizeForSearch(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

interface ProgressState {
  current: number;
  total: number;
  campaignId: string;
  phase: 'fetching' | 'done' | 'error';
}

export default function AutoReportPage() {
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<ProgressState | null>(null);
  const [progressTotal, setProgressTotal] = useState<number>(0);
  const [error, setError] = useState('');
  const [report, setReport] = useState<ReportResponse | null>(null);
  const [reportCreatedAt, setReportCreatedAt] = useState<string | null>(null);
  const [reportHistory, setReportHistory] = useState<SavedReport[]>([]);
  const [copyToSheetsState, setCopyToSheetsState] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle');

  useEffect(() => {
    setReportHistory(loadReportHistory());
  }, []);

  const [campaignsList, setCampaignsList] = useState<InstantlyCampaignItem[]>([]);
  const [campaignsLoading, setCampaignsLoading] = useState(false);
  const [campaignsFetched, setCampaignsFetched] = useState(false);
  const [catalogSyncPending, setCatalogSyncPending] = useState(false);
  const [campaignsMeta, setCampaignsMeta] = useState<CampaignsListMeta | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [searchQuery, setSearchQuery] = useState('');
  const catalogSyncWaitAttemptsRef = useRef(0);

  const loadCampaigns = useCallback(async (opts?: { silent?: boolean; direct?: boolean }) => {
    const silent = opts?.silent === true;
    const direct = opts?.direct === true;
    if (!silent) {
      setCampaignsLoading(true);
    }
    setError('');
    try {
      const token = await getToken();
      if (!token) {
        setError('Нужна авторизация. Войдите в аккаунт.');
        if (!silent) setCampaignsLoading(false);
        return;
      }
      const sourceSuffix = direct ? '?source=instantly' : '';
      const res = await fetch(`/api/tools/auto-report/campaigns${sourceSuffix}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json().catch(() => ({}))) as {
        campaigns?: InstantlyCampaignItem[];
        meta?: CampaignsListMeta;
        error?: string;
      };
      if (!res.ok) {
        setError(data.error || `Ошибка ${res.status}`);
        if (!silent) setCampaignsLoading(false);
        return;
      }
      const sorted = [...(data.campaigns ?? [])].sort((a, b) => {
        const at = a.timestamp_created ?? a.timestamp_updated ?? '';
        const bt = b.timestamp_created ?? b.timestamp_updated ?? '';
        const an = at ? Date.parse(at) : NaN;
        const bn = bt ? Date.parse(bt) : NaN;
        if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return bn - an;
        if (at && bt && at !== bt) return bt.localeCompare(at);
        return (b.name ?? '').localeCompare(a.name ?? '', 'ru');
      });
      setCampaignsList(sorted);
      setCampaignsMeta(data.meta ?? null);
      setSelectedIds(new Set());
      setCampaignsFetched(true);

      const meta = data.meta;
      const empty = sorted.length === 0;
      const bg = meta?.backgroundSync === true;

      if (empty && bg) {
        catalogSyncWaitAttemptsRef.current += 1;
        if (catalogSyncWaitAttemptsRef.current >= 48) {
          setError(
            'Каталог кампаний не подгрузился за ~3 минуты. Проверьте миграцию БД, INSTANTLY_API_KEY и CRON для /api/tools/auto-report/campaigns/sync, затем обновите страницу.',
          );
          setCatalogSyncPending(false);
        } else {
          setCatalogSyncPending(true);
        }
      } else {
        catalogSyncWaitAttemptsRef.current = 0;
        setCatalogSyncPending(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки кампаний');
    } finally {
      if (!silent) {
        setCampaignsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    loadCampaigns();
  }, [loadCampaigns]);

  useEffect(() => {
    if (!catalogSyncPending || campaignsList.length > 0) return;
    const id = window.setInterval(() => {
      void loadCampaigns({ silent: true });
    }, 4000);
    return () => window.clearInterval(id);
  }, [catalogSyncPending, campaignsList.length, loadCampaigns]);
  const listContainerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);

  const filteredCampaigns = useMemo(() => {
    const q = normalizeForSearch(searchQuery);
    if (!q) return campaignsList;
    return campaignsList.filter((c) => normalizeForSearch(c.name || '').includes(q));
  }, [campaignsList, searchQuery]);

  const { startIndex, totalHeight, visibleCampaigns } = useMemo(() => {
    const list = filteredCampaigns;
    const total = list.length;
    if (total === 0) return { startIndex: 0, endIndex: 0, totalHeight: 0, visibleCampaigns: [] };
    const containerHeight = 28 * 16;
    const rowCount = Math.ceil(containerHeight / ROW_HEIGHT) + OVERSCAN * 2;
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
    const end = Math.min(total, start + rowCount);
    return {
      startIndex: start,
      endIndex: end,
      totalHeight: total * ROW_HEIGHT,
      visibleCampaigns: list.slice(start, end),
    };
  }, [filteredCampaigns, scrollTop]);

  const toggleCampaign = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAllCampaigns = () => {
    setSelectedIds(new Set(filteredCampaigns.map((c) => c.id)));
  };

  const clearSelection = () => setSelectedIds(new Set());

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setReport(null);
    setProgress(null);
    setProgressTotal(0);
    const token = await getToken();
    if (!token) {
      setError('Нужна авторизация. Войдите в аккаунт.');
      return;
    }

    const ids = Array.from(selectedIds);
    if (ids.length === 0) {
      setError('Выберите хотя бы одну кампанию для отчёта.');
      return;
    }

    setLoading(true);
    try {
      const res = await fetch('/api/tools/auto-report/stream', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ campaignIds: ids }),
      });

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        setError((data as { error?: string }).error || `Ошибка ${res.status}`);
        setLoading(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() ?? '';

        for (const chunk of lines) {
          const dataLine = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (!dataLine) continue;
          try {
            const event = JSON.parse(dataLine.slice(6)) as {
              type: string;
              total?: number;
              current?: number;
              campaignId?: string;
              phase?: 'fetching' | 'done' | 'error';
              message?: string;
              tableText?: string;
              csvText?: string;
              rows?: (string | number)[][];
              summary?: ReportSummary;
              campaignData?: Record<string, unknown>;
            };

            if (event.type === 'start') {
              setProgressTotal(event.total ?? 0);
            } else if (event.type === 'progress') {
              setProgress({
                current: event.current ?? 0,
                total: event.total ?? 0,
                campaignId: event.campaignId ?? '',
                phase: event.phase ?? 'fetching',
              });
            } else if (event.type === 'result') {
              const reportData: ReportResponse = {
                tableText: event.tableText ?? '',
                csvText: event.csvText ?? '',
                rows: event.rows ?? [],
                summary: event.summary!,
                campaignData: event.campaignData ?? {},
              };
              const now = new Date().toISOString();
              setReport(reportData);
              setReportCreatedAt(now);
              setProgress(null);
              setSelectedIds(new Set());
              setSearchQuery('');
              const saved: SavedReport = {
                id: crypto.randomUUID?.() ?? `report-${Date.now()}`,
                createdAt: now,
                report: reportData,
              };
              setReportHistory((prev) => {
                const next = [saved, ...prev].slice(0, REPORT_HISTORY_MAX);
                saveReportHistory(next);
                return next;
              });
            } else if (event.type === 'error') {
              setError(event.message ?? 'Ошибка формирования отчёта');
              setProgress(null);
            }
          } catch {
            // skip malformed SSE line
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка запроса');
    } finally {
      setLoading(false);
      setProgress(null);
    }
  };

  const getReportFilenamePrefix = () => {
    const d = reportCreatedAt ? new Date(reportCreatedAt) : new Date();
    const date = d.toISOString().slice(0, 10);
    const time = `${String(d.getHours()).padStart(2, '0')}-${String(d.getMinutes()).padStart(2, '0')}`;
    return `instantly-report-${date}-${time}`;
  };

  const selectReportFromHistory = useCallback((item: SavedReport) => {
    setReport(item.report);
    setReportCreatedAt(item.createdAt);
    setError('');
  }, []);

  const handleDownloadCsv = () => {
    if (!report?.csvText) return;
    downloadCsv(report.csvText, `${getReportFilenamePrefix()}.csv`);
  };

  const handleDownloadExcel = async () => {
    if (!report) return;
    const filename = `${getReportFilenamePrefix()}.xlsx`;
    const periodText = `Период: с ${new Date().toLocaleDateString('ru-RU')} по ${new Date().toLocaleDateString('ru-RU')}`;
    const data = report.campaignData as Record<string, CampaignRecordView>;
    if (data && Object.keys(data).length > 0) {
      await downloadExcelFormatted(report.summary, data, periodText, filename);
    } else {
      downloadExcel(report.tableText, report.rows ?? [], filename);
    }
  };

  const handleCopyToGoogleSheets = useCallback(async () => {
    if (!report) return;
    const periodText = reportCreatedAt
      ? `Период: с ${new Date(reportCreatedAt).toLocaleDateString('ru-RU')} по ${new Date(reportCreatedAt).toLocaleDateString('ru-RU')}`
      : `Период: с ${new Date().toLocaleDateString('ru-RU')} по ${new Date().toLocaleDateString('ru-RU')}`;
    const data = report.campaignData as Record<string, CampaignRecordView>;
    if (!data || Object.keys(data).length === 0) return;

    setCopyToSheetsState('copying');
    try {
      await copyStyledReportToSheets({
        summary: report.summary,
        campaignData: data,
        periodText,
        fallbackText: report.tableText || report.csvText || '',
      });
      setCopyToSheetsState('copied');
      window.setTimeout(() => setCopyToSheetsState('idle'), 1500);
    } catch {
      setCopyToSheetsState('error');
      window.setTimeout(() => setCopyToSheetsState('idle'), 2000);
    }
  }, [report, reportCreatedAt]);

  return (
    <div className="flex gap-6 text-left max-w-full">
      <div className="min-w-0 flex-1 max-w-7xl space-y-6">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Автоотчёты</h1>
          <p className="text-sm text-gray-500 mt-1">
            Сформируйте отчёт по кампаниям Instantly: статистика по кампаниям, общая сводка и
            детализация по письмам. Подгрузите кампании, найдите по названию и выберите для отчёта.
          </p>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex items-start gap-3 mb-4">
          <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-indigo-100 flex items-center justify-center">
            <FileText className="h-5 w-5 text-indigo-600" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Сформировать отчёт</h2>
            <p className="text-sm text-gray-600 mt-0.5">
              Подгрузите список кампаний из Instantly, найдите нужные по названию и выберите проекты для отчёта.
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void loadCampaigns()}
                disabled={campaignsLoading}
                className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 disabled:pointer-events-none"
                title="Обновить список кампаний (по умолчанию из БД-каталога)"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${campaignsLoading ? 'animate-spin' : ''}`} />
                Обновить список
              </button>
              {campaignsMeta ? (
                <span className="inline-flex items-center rounded-md bg-gray-100 px-2 py-1 text-xs text-gray-600">
                  Источник:{' '}
                  {campaignsMeta.source === 'database'
                    ? 'БД'
                    : campaignsMeta.source === 'instantly_direct'
                      ? 'Instantly (напрямую)'
                      : 'Instantly (fallback)'}
                </span>
              ) : null}
              {campaignsLoading && campaignsList.length === 0 ? (
                <span className="inline-flex items-center gap-2 text-sm text-gray-500">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Загрузка кампаний…
                </span>
              ) : null}
              {catalogSyncPending && !campaignsLoading && campaignsList.length === 0 ? (
                <span className="inline-flex items-center gap-2 text-sm text-gray-500">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Синхронизация каталога с Instantly… Первая загрузка может занять до 3 минут (много
                  кампаний — дольше). Список появится сам; дальше названия в БД обновляются примерно каждые
                  10–15 мин.
                </span>
              ) : null}
              {campaignsList.length > 0 && (
                <div className="inline-flex items-center gap-2">
                  <label className="inline-flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={filteredCampaigns.length > 0 && selectedIds.size === filteredCampaigns.length}
                      onChange={(e) => (e.target.checked ? selectAllCampaigns() : clearSelection())}
                      className="sr-only"
                    />
                    <span className="text-sm font-medium text-indigo-600">Выбрать все</span>
                    <span
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 transition-colors ${
                        filteredCampaigns.length > 0 && selectedIds.size === filteredCampaigns.length
                          ? 'border-indigo-600 bg-indigo-600 text-white'
                          : 'border-gray-300 bg-white text-transparent'
                      }`}
                    >
                      <Check className="h-3 w-3 stroke-[3]" />
                    </span>
                  </label>
                  <span className="text-sm text-gray-600">
                    Выбрано: {selectedIds.size} из {campaignsList.length}
                  </span>
                </div>
              )}
            </div>

            {campaignsFetched && campaignsList.length === 0 && !catalogSyncPending && !error ? (
              <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                Кампаний не найдено. Убедитесь, что API-ключ Instantly v2 с правом{' '}
                <code className="bg-amber-100 px-1 rounded">campaigns:read</code> и в workspace есть кампании.
              </p>
            ) : null}

            {campaignsList.length > 0 && (
              <div className="space-y-2">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Поиск по названию кампании (например: База Snabb_Руспрофайл_ОКВЭД)"
                    className="block w-full pl-9 pr-3 py-2 rounded-lg border border-gray-300 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500"
                  />
                  {searchQuery && (
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-gray-500">
                      Найдено: {filteredCampaigns.length}
                    </span>
                  )}
                </div>
                <div
                  ref={listContainerRef}
                  onScroll={() => setScrollTop(listContainerRef.current?.scrollTop ?? 0)}
                  className="max-h-[28rem] overflow-y-auto rounded-xl border border-gray-200 bg-white p-1.5 w-full min-w-0 shadow-inner"
                >
                  {filteredCampaigns.length > 0 ? (
                    <div style={{ height: totalHeight, position: 'relative' }}>
                      <ul
                        className="space-y-0.5 absolute left-0 right-0 px-0 list-none"
                        style={{ top: startIndex * ROW_HEIGHT, margin: 0, paddingLeft: 2, paddingRight: 2 }}
                      >
                        {visibleCampaigns.map((c) => (
                          <CampaignRow
                            key={c.id}
                            campaign={c}
                            isChecked={selectedIds.has(c.id)}
                            onToggle={toggleCampaign}
                          />
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </div>
              </div>
            )}
          </div>

          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="submit"
                disabled={loading || selectedIds.size === 0}
                className="inline-flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50 disabled:pointer-events-none"
              >
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Формирую отчёт…
                  </>
                ) : (
                  'Сформировать отчёт'
                )}
              </button>
              {loading && progressTotal > 0 && (
                <span className="text-sm text-gray-500">
                  {progress ? `${progress.current} / ${progress.total}` : `0 / ${progressTotal}`} кампаний
                </span>
              )}
            </div>

            {loading && progressTotal > 0 && (
              <div className="space-y-1.5">
                <div className="w-full bg-gray-100 rounded-full h-2.5 overflow-hidden">
                  <div
                    className="h-2.5 rounded-full bg-indigo-500 transition-all duration-300"
                    style={{
                      width: `${progress ? Math.round((progress.current / progress.total) * 100) : 0}%`,
                    }}
                  />
                </div>
                {progress && (
                  <p className="text-xs text-gray-500 truncate">
                    {progress.phase === 'fetching' && `Загружаю кампанию ${progress.current}…`}
                    {progress.phase === 'done' && `✓ Кампания ${progress.current} готова`}
                    {progress.phase === 'error' && `⚠ Кампания ${progress.current} — ошибка, продолжаю…`}
                  </p>
                )}
              </div>
            )}
          </div>
        </form>

        {error && (
          <div className="mt-4 p-3 rounded-lg bg-red-50 border border-red-200 text-sm text-red-700">
            {error}
          </div>
        )}

        {report && (
          <div className="mt-6 space-y-4 border-t border-gray-200 pt-6">
            <h3 className="font-semibold text-gray-900">Результат</h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <div className="rounded-lg bg-gray-50 p-3">
                <div className="text-xs text-gray-500">Кампаний</div>
                <div className="text-lg font-semibold text-gray-900">{report.summary.totalCampaigns}</div>
              </div>
              <div className="rounded-lg bg-gray-50 p-3">
                <div className="text-xs text-gray-500">Контактов</div>
                <div className="text-lg font-semibold text-gray-900">{report.summary.totalContacts}</div>
              </div>
              <div className="rounded-lg bg-gray-50 p-3">
                <div className="text-xs text-gray-500">Отправлено писем</div>
                <div className="text-lg font-semibold text-gray-900">{report.summary.totalEmailsSent}</div>
              </div>
              <div className="rounded-lg bg-gray-50 p-3">
                <div className="text-xs text-gray-500">% открытий</div>
                <div className="text-lg font-semibold text-gray-900">
                  {report.summary.conversion.openPctAllEmails}%
                </div>
              </div>
              <div className="rounded-lg bg-gray-50 p-3">
                <div className="text-xs text-gray-500">Ответов</div>
                <div className="text-lg font-semibold text-gray-900">{report.summary.totalReplies}</div>
              </div>
              <div className="rounded-lg bg-gray-50 p-3">
                <div className="text-xs text-gray-500">% ответов</div>
                <div className="text-lg font-semibold text-gray-900">
                  {report.summary.conversion.replyPctByLeads}%
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={handleDownloadCsv}
                className="inline-flex items-center gap-2 px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-offset-2"
              >
                <Download className="h-4 w-4" />
                Скачать CSV
              </button>
              <button
                type="button"
                onClick={handleDownloadExcel}
                className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-500 focus:ring-offset-2"
              >
                <FileSpreadsheet className="h-4 w-4" />
                Скачать Excel
              </button>
              <button
                type="button"
                onClick={handleCopyToGoogleSheets}
                disabled={copyToSheetsState === 'copying' || !(report.campaignData && Object.keys(report.campaignData).length > 0)}
                className="inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:pointer-events-none"
                title="Скопирует таблицу в буфер как HTML со стилями. Вставьте в Google Sheets (Ctrl+V)."
              >
                {copyToSheetsState === 'copied' ? <Check className="h-4 w-4" /> : <FileSpreadsheet className="h-4 w-4" />}
                {copyToSheetsState === 'copying'
                  ? 'Копирую…'
                  : copyToSheetsState === 'copied'
                    ? 'Скопировано'
                    : copyToSheetsState === 'error'
                      ? 'Не удалось'
                      : 'Скопировать в Google Sheets'}
              </button>
            </div>
            <details className="mt-2" open>
              <summary className="cursor-pointer text-sm font-medium text-gray-700 hover:text-gray-900">
                Показать таблицу отчёта
              </summary>
              <div className="mt-3">
                <StyledReportView
                  summary={report.summary}
                  campaignData={report.campaignData as Record<string, CampaignRecordView>}
                  periodText={
                    reportCreatedAt
                      ? `Период: с ${new Date(reportCreatedAt).toLocaleDateString('ru-RU')} по ${new Date(reportCreatedAt).toLocaleDateString('ru-RU')}`
                      : `Период: с ${new Date().toLocaleDateString('ru-RU')} по ${new Date().toLocaleDateString('ru-RU')}`
                  }
                />
              </div>
            </details>
          </div>
        )}
        </div>
      </div>

      <aside className="w-80 shrink-0 pt-20">
        <div className="rounded-2xl border border-gray-200 bg-white p-4 shadow-sm sticky top-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-gray-900 mb-3">
            <History className="h-4 w-4 text-indigo-600" />
            История отчётов
          </h2>
          {reportHistory.length === 0 ? (
            <p className="text-xs text-gray-500">Здесь появятся последние 20 отчётов</p>
          ) : (
            <ul className="space-y-1.5 max-h-[calc(100vh-12rem)] overflow-y-auto">
              {reportHistory.map((item) => {
                const date = new Date(item.createdAt);
                const label = `${item.report.summary.totalCampaigns} кампаний · ${date.toLocaleDateString('ru-RU')} ${date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
                const isSelected =
                  report?.summary.totalCampaigns === item.report.summary.totalCampaigns &&
                  report?.summary.totalContacts === item.report.summary.totalContacts &&
                  reportCreatedAt === item.createdAt;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      onClick={() => selectReportFromHistory(item)}
                      className={`w-full text-left rounded-lg px-3 py-2.5 text-sm transition-colors ${
                        isSelected
                          ? 'bg-indigo-50 border border-indigo-200 text-indigo-900'
                          : 'bg-gray-50/80 border border-transparent hover:bg-gray-100 text-gray-800'
                      }`}
                    >
                      <span className="block font-medium truncate">{label}</span>
                      <span className="block text-xs text-gray-500 mt-0.5 truncate">
                        {item.report.summary.totalContacts} контактов, {item.report.summary.totalEmailsSent} писем
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>
    </div>
  );
}
