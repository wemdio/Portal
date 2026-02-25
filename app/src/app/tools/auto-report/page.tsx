'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { FileText, ExternalLink, Loader2, Download } from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';

const RESULTS_SHEET_URL =
  'https://docs.google.com/spreadsheets/d/1I4mQLI2evf1049-pJmX5YU8jwNnOMK5fRz1X6EymRW0/edit?usp=sharing';

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

export default function AutoReportPage() {
  const [urlsOrText, setUrlsOrText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [report, setReport] = useState<ReportResponse | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setReport(null);
    const text = urlsOrText.trim();
    if (!text) {
      setError('Вставьте ссылки на кампании Instantly или текст с UUID.');
      return;
    }
    setLoading(true);
    try {
      const token = await getToken();
      if (!token) {
        setError('Нужна авторизация. Войдите в аккаунт.');
        setLoading(false);
        return;
      }
      const res = await fetch('/api/tools/auto-report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ urlsOrText: text }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((data.error as string) || `Ошибка ${res.status}`);
        setLoading(false);
        return;
      }
      setReport(data as ReportResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка запроса');
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadCsv = () => {
    if (!report?.csvText) return;
    const date = new Date().toISOString().slice(0, 10);
    downloadCsv(report.csvText, `instantly-report-${date}.csv`);
  };

  return (
    <div className="space-y-6 text-left max-w-full">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Автоотчёт по email-кампаниям</h1>
        <p className="text-sm text-gray-500 mt-1">
          Сформируйте отчёт по кампаниям Instantly: статистика по кампаниям, общая сводка и
          детализация по письмам. Вставьте ссылки на кампании — отчёт строится на портале.
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
              Вставьте ссылки на кампании Instantly (по одной в строку или списком). Из текста
              автоматически извлекутся ID кампаний.
            </p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-gray-700">Ссылки или текст с UUID кампаний</span>
            <textarea
              value={urlsOrText}
              onChange={(e) => setUrlsOrText(e.target.value)}
              placeholder={'https://app.instantly.ai/app/campaign/.../analytics\nhttps://app.instantly.ai/app/campaign/.../analytics'}
              rows={5}
              className="mt-1 block w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500"
              disabled={loading}
            />
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={loading}
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
            </div>
            <details className="mt-2">
              <summary className="cursor-pointer text-sm text-gray-600 hover:text-gray-900">
                Показать таблицу
              </summary>
              <div className="mt-2 overflow-x-auto rounded-lg border border-gray-200">
                <pre className="p-3 text-xs text-gray-700 whitespace-pre-wrap font-sans">
                  {report.tableText}
                </pre>
              </div>
            </details>
          </div>
        )}
      </div>

      <div className="rounded-2xl border border-gray-100 bg-gray-50 p-4">
        <p className="text-sm text-gray-600">
          Раньше отчёт можно было запросить через Telegram-бота (тема «Составить отчёт инстантли»).
          Результаты сохранялись в общую таблицу. Сейчас отчёт формируется здесь; при необходимости
          вы можете открыть{' '}
          <a
            href={RESULTS_SHEET_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-indigo-600 hover:text-indigo-800 font-medium"
          >
            таблицу результатов
            <ExternalLink className="h-3.5 w-3.5" />
          </a>{' '}
          или раздел{' '}
          <Link href={'/reglament#instantly-ai-tools' as Route} className="text-indigo-600 hover:text-indigo-800 font-medium underline">
            Регламент
          </Link>
          .
        </p>
      </div>
    </div>
  );
}
