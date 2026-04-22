'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Download, Trash2, Sparkles, FileText, AlertCircle } from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';
import { logError } from '@/lib/loggerClient';
import { ProjectBriefUploader } from './ProjectBriefUploader';
import { LeadSourceHypothesesView } from './LeadSourceHypothesesView';

interface BriefFields {
  brief_file_path?: string | null;
  brief_file_name?: string | null;
  brief_uploaded_at?: string | null;
  lead_source_hypotheses?: string | null;
  lead_source_hypotheses_generated_at?: string | null;
  lead_source_hypotheses_error?: string | null;
}

interface ProjectBriefSectionProps {
  projectId: string;
  brief: BriefFields;
  canEdit: boolean;
  onChange: (next: BriefFields) => void;
}

interface BriefApiResponse {
  ok: boolean;
  brief_file_path?: string | null;
  brief_file_name?: string | null;
  brief_uploaded_at?: string | null;
  lead_source_hypotheses?: string | null;
  lead_source_hypotheses_generated_at?: string | null;
  lead_source_hypotheses_error?: string | null;
}

async function authHeaders(): Promise<Record<string, string>> {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
}

function SectionCard({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-400">{title}</h3>
        {action}
      </div>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export function ProjectBriefSection({
  projectId,
  brief,
  canEdit,
  onChange,
}: ProjectBriefSectionProps) {
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [busy, setBusy] = useState<
    'idle' | 'uploading' | 'generating' | 'deleting' | 'downloading'
  >('idle');
  const [error, setError] = useState<string | null>(null);

  const hasBrief = Boolean(brief.brief_file_path);
  const hasHypotheses = Boolean(brief.lead_source_hypotheses);
  const hypothesesError = brief.lead_source_hypotheses_error;
  const autoTriggeredRef = useRef<string | null>(null);

  // Автозапуск генерации, если бриф уже залит, но гипотез нет и нет ошибки.
  // Срабатывает один раз на projectId — повторных циклов «ошибка → авто-ретрай» не будет.
  useEffect(() => {
    if (!canEdit) return;
    if (!hasBrief || hasHypotheses || hypothesesError) return;
    if (busy !== 'idle') return;
    if (autoTriggeredRef.current === projectId) return;
    autoTriggeredRef.current = projectId;
    void generateHypotheses({ regenerate: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, hasBrief, hasHypotheses, hypothesesError, canEdit]);

  async function generateHypotheses(opts: { regenerate?: boolean } = {}): Promise<void> {
    setBusy('generating');
    try {
      const headers = await authHeaders();
      const url = `/api/projects/${projectId}/brief/hypotheses${opts.regenerate ? '?regenerate=1' : ''}`;
      const res = await fetch(url, { method: 'POST', headers });
      const payload = (await res.json().catch(() => ({}))) as BriefApiResponse & { error?: string };
      onChange({
        lead_source_hypotheses: payload.lead_source_hypotheses ?? null,
        lead_source_hypotheses_generated_at: payload.lead_source_hypotheses_generated_at ?? null,
        lead_source_hypotheses_error: payload.lead_source_hypotheses_error ?? null,
      });
      if (!res.ok) {
        throw new Error(payload.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      void logError('projects.brief.hypotheses.client_failed', err, { projectId });
      setError(
        err instanceof Error
          ? `Гипотезы не сгенерированы: ${err.message}`
          : 'Гипотезы не сгенерированы',
      );
    } finally {
      setBusy('idle');
    }
  }

  async function handleUpload() {
    if (!pendingFile) return;
    setError(null);
    setBusy('uploading');

    let payload: (BriefApiResponse & { error?: string; hypotheses_pending?: boolean }) | null = null;
    try {
      const headers = await authHeaders();
      const fd = new FormData();
      fd.append('file', pendingFile);

      const res = await fetch(`/api/projects/${projectId}/brief`, {
        method: 'POST',
        headers,
        body: fd,
      });
      payload = (await res.json().catch(() => ({}))) as BriefApiResponse & {
        error?: string;
        hypotheses_pending?: boolean;
      };
      if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status}`);

      onChange({
        brief_file_path: payload.brief_file_path ?? null,
        brief_file_name: payload.brief_file_name ?? null,
        brief_uploaded_at: payload.brief_uploaded_at ?? null,
        lead_source_hypotheses: payload.lead_source_hypotheses ?? null,
        lead_source_hypotheses_generated_at: payload.lead_source_hypotheses_generated_at ?? null,
        lead_source_hypotheses_error: payload.lead_source_hypotheses_error ?? null,
      });
      setPendingFile(null);
    } catch (err) {
      void logError('projects.brief.upload.client_failed', err, { projectId });
      setError(err instanceof Error ? err.message : 'Ошибка при загрузке брифа');
      setBusy('idle');
      return;
    }

    // Загрузка PDF прошла. Если гипотез ещё нет — запускаем второй запрос
    // (генерация уже в своём собственном setBusy('generating') / 'idle').
    if (payload?.hypotheses_pending) {
      await generateHypotheses();
    } else {
      setBusy('idle');
    }
  }

  async function handleDelete() {
    if (!confirm('Удалить бриф? Гипотезы останутся как историческая запись.')) return;
    setError(null);
    setBusy('deleting');
    try {
      const headers = await authHeaders();
      const res = await fetch(`/api/projects/${projectId}/brief`, { method: 'DELETE', headers });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || `HTTP ${res.status}`);
      }
      onChange({
        brief_file_path: null,
        brief_file_name: null,
        brief_uploaded_at: null,
      });
    } catch (err) {
      void logError('projects.brief.delete.client_failed', err, { projectId });
      setError(err instanceof Error ? err.message : 'Ошибка при удалении брифа');
    } finally {
      setBusy('idle');
    }
  }

  async function handleDownload() {
    setError(null);
    setBusy('downloading');
    try {
      const headers = await authHeaders();
      const res = await fetch(`/api/projects/${projectId}/brief`, { headers });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error || `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { url: string };
      window.open(data.url, '_blank', 'noopener');
    } catch (err) {
      void logError('projects.brief.download.client_failed', err, { projectId });
      setError(err instanceof Error ? err.message : 'Ошибка при создании ссылки');
    } finally {
      setBusy('idle');
    }
  }

  return (
    <div className="space-y-6">
      <SectionCard
        title="Бриф клиента"
        action={
          hasBrief && canEdit ? (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void handleDownload()}
                disabled={busy !== 'idle'}
                className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 disabled:opacity-50"
              >
                <Download className="w-3.5 h-3.5" /> Скачать
              </button>
              <button
                type="button"
                onClick={() => void handleDelete()}
                disabled={busy !== 'idle'}
                className="inline-flex items-center gap-1 text-xs text-red-600 hover:text-red-800 disabled:opacity-50"
              >
                <Trash2 className="w-3.5 h-3.5" /> Удалить
              </button>
            </div>
          ) : null
        }
      >
        {hasBrief ? (
          <div className="flex items-center gap-3">
            <div className="flex-shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-full bg-blue-100 text-blue-600">
              <FileText className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <p className="text-sm font-medium text-gray-900 truncate">{brief.brief_file_name}</p>
              <p className="text-xs text-gray-500">
                Загружен {formatDate(brief.brief_uploaded_at)}
              </p>
            </div>
          </div>
        ) : canEdit ? (
          <div className="space-y-3">
            <ProjectBriefUploader
              file={pendingFile}
              onFileChange={setPendingFile}
              disabled={busy !== 'idle'}
              hint="После загрузки AI один раз сгенерирует гипотезы по сбору базы для этого клиента."
            />
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => void handleUpload()}
                disabled={!pendingFile || busy !== 'idle'}
                className="inline-flex items-center gap-2 bg-blue-600 text-white text-sm px-4 py-2 rounded-md hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {busy === 'uploading' ? (
                  <>Загружаю PDF…</>
                ) : busy === 'generating' ? (
                  <>Генерирую гипотезы…</>
                ) : (
                  <><Sparkles className="w-4 h-4" /> Загрузить и сгенерировать гипотезы</>
                )}
              </button>
            </div>
          </div>
        ) : (
          <p className="text-sm text-gray-400">Бриф не прикреплён.</p>
        )}

        {error && (
          <div className="mt-3 flex items-start gap-2 text-xs text-red-600">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </SectionCard>

      {(hasHypotheses || hypothesesError || (hasBrief && canEdit)) && (
        <SectionCard title="Гипотезы по сбору баз (AI)">
          {hasHypotheses ? (
            <>
              <LeadSourceHypothesesView markdown={brief.lead_source_hypotheses ?? ''} />
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-gray-400">
                  Сгенерировано {formatDate(brief.lead_source_hypotheses_generated_at)} на основе брифа.
                </p>
                {hasBrief && canEdit && (
                  <button
                    type="button"
                    onClick={() => void generateHypotheses({ regenerate: true })}
                    disabled={busy !== 'idle'}
                    className="inline-flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-800 disabled:opacity-50"
                    title="Перегенерировать гипотезы по уже загруженному брифу"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    {busy === 'generating' ? 'Генерирую…' : 'Сгенерировать заново'}
                  </button>
                )}
              </div>
            </>
          ) : busy === 'generating' ? (
            <div className="flex items-center gap-2 text-sm text-gray-600 bg-blue-50 border border-blue-200 rounded-lg p-3">
              <Sparkles className="w-4 h-4 animate-pulse text-blue-500" />
              <span>Генерирую гипотезы… (до ~60 секунд)</span>
            </div>
          ) : hypothesesError ? (
            <div className="flex items-start gap-2 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <div className="flex-1">
                <p className="font-medium">Гипотезы не сгенерированы</p>
                <p className="text-xs mt-0.5">{hypothesesError}</p>
                {canEdit && hasBrief && (
                  <button
                    type="button"
                    onClick={() => void generateHypotheses({ regenerate: true })}
                    disabled={busy !== 'idle'}
                    className="mt-2 inline-flex items-center gap-1.5 text-xs bg-amber-600 text-white px-3 py-1.5 rounded-md hover:bg-amber-700 disabled:opacity-50"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    Сгенерировать ещё раз
                  </button>
                )}
              </div>
            </div>
          ) : hasBrief && canEdit ? (
            <div className="flex items-center justify-between gap-3 text-sm text-gray-600 bg-gray-50 border border-gray-200 rounded-lg p-3">
              <span>Бриф загружен. Запустите AI, чтобы получить идеи по сбору базы.</span>
              <button
                type="button"
                onClick={() => void generateHypotheses({ regenerate: true })}
                disabled={busy !== 'idle'}
                className="inline-flex items-center gap-1.5 text-xs bg-blue-600 text-white px-3 py-1.5 rounded-md hover:bg-blue-700 disabled:opacity-50"
              >
                <Sparkles className="w-3.5 h-3.5" />
                Сгенерировать
              </button>
            </div>
          ) : null}
        </SectionCard>
      )}
    </div>
  );
}
