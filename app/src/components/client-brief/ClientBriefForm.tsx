'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, AlertCircle, Loader2 } from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';
import { logAudit, logError } from '@/lib/loggerClient';
import { promptDemoRegister } from '@/lib/clientDemo/registerPrompt';
import {
  EMPTY_BRIEF_FIELDS,
  PRICE_TIER_LABELS,
  SOCIAL_PROOF_KEYS,
  SOCIAL_PROOF_LABELS,
  ALLOWED_PRICE_TIERS,
  normalizeBriefFields,
  compileBriefText,
} from '@/lib/clientBrief';
import type {
  ClientBriefFields,
  ClientBriefPriceTier,
  ClientBriefSocialProofKey,
} from '@/lib/clientBrief';
import { mergePatchEmptyOnly } from '@/lib/clientBrief/autofill/mergePatchEmptyOnly';
import { LeadSourceHypothesesView } from '@/components/projects/LeadSourceHypothesesView';
import { BriefAutofillPanel, type BriefAutofillResult } from './BriefAutofillPanel';
import { BriefSectionNav } from './BriefSectionNav';

interface ClientBriefFormProps {
  /** API endpoint that supports GET/PUT for the brief */
  endpoint: string;
  /**
   * Optional API endpoint for hypothesis generation (GET / POST + ?regenerate=1).
   * When provided, renders the «Гипотезы по сбору базы» section under the form,
   * auto-triggers generation on first save and supports manual re-generation.
   */
  hypothesesEndpoint?: string;
  /**
   * Optional API endpoint for AI autofill (POST). When provided, renders the
   * «Заполнить бриф по сайту» panel above the form. Body: { website }. Server
   * returns { ok, fieldsPatch, questions }. The panel only updates local form
   * state — the client still has to press «Сохранить».
   */
  autofillEndpoint?: string;
  /** Optional title shown above the form */
  title?: string;
  /** Optional subtitle line */
  subtitle?: string;
  /** Audit-log event prefix, e.g. 'client.brief' or 'admin.client-brief' */
  auditPrefix: string;
}

interface HypothesesApiResponse {
  ok?: boolean;
  error?: string;
  lead_source_hypotheses: string | null;
  lead_source_hypotheses_generated_at: string | null;
  lead_source_hypotheses_error: string | null;
  lead_source_hypotheses_stale?: boolean;
}

interface BriefApiResponse {
  brief: {
    id: string;
    fields: ClientBriefFields;
    pdf_file_name: string | null;
    pdf_uploaded_at: string | null;
    updated_at: string;
  } | null;
  compiled_brief_text?: string;
}

const SECTION_BASE = 'rounded-lg overflow-hidden';
const SECTION_STYLE: React.CSSProperties = {
  background: 'var(--cp-surface-rest)',
  border: '1px solid var(--cp-divider)',
};

function SectionHeader({ number, title }: { number: number; title: string }) {
  const num = String(number).padStart(2, '0');
  return (
    <header
      className="px-6 py-3 flex items-baseline gap-3"
      style={{
        borderBottom: '1px solid var(--cp-divider)',
        background: 'var(--cp-surface-elev)',
      }}
    >
      <span className="ds-eyebrow shrink-0">
        {num}<span aria-hidden> → </span>
      </span>
      <h2 className="text-sm font-semibold m-0" style={{ color: 'var(--cp-paper)' }}>
        {title}
      </h2>
    </header>
  );
}

function HelperText({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[11px] mt-1" style={{ color: 'var(--cp-paper-faint)' }}>
      {children}
    </p>
  );
}

function TextField({
  label,
  value,
  onChange,
  hint,
  placeholder,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  placeholder?: string;
  type?: 'text' | 'email';
}) {
  return (
    <div>
      <label className="ds-eyebrow block mb-1.5">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="ds-input w-full"
      />
      {hint && <HelperText>{hint}</HelperText>}
    </div>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
  hint,
  placeholder,
  rows = 4,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  hint?: string;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <div>
      <label className="ds-eyebrow block mb-1.5">{label}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        className="ds-input w-full resize-y"
      />
      {hint && <HelperText>{hint}</HelperText>}
    </div>
  );
}

function PriceTierSelector({
  value,
  onChange,
}: {
  value: ClientBriefPriceTier | null;
  onChange: (v: ClientBriefPriceTier | null) => void;
}) {
  return (
    <div>
      <label className="ds-eyebrow block mb-2">Ценовая категория</label>
      <div className="flex flex-wrap gap-2">
        {ALLOWED_PRICE_TIERS.map((tier) => {
          const active = value === tier;
          return (
            <button
              key={tier}
              type="button"
              onClick={() => onChange(active ? null : tier)}
              className={`price-tier-btn px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                active
                  ? 'active bg-blue-600 text-white border-blue-600'
                  : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
              }`}
            >
              {PRICE_TIER_LABELS[tier]}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SocialProofGrid({
  value,
  onChange,
}: {
  value: ClientBriefFields['social_proof'];
  onChange: (next: ClientBriefFields['social_proof']) => void;
}) {
  const setItem = (key: ClientBriefSocialProofKey, patch: Partial<ClientBriefFields['social_proof'][ClientBriefSocialProofKey]>) => {
    onChange({
      ...value,
      [key]: { ...value[key], ...patch },
    });
  };

  return (
    <div className="space-y-3">
      {SOCIAL_PROOF_KEYS.map((key) => {
        const item = value[key];
        return (
          <div key={key} className="rounded-lg border border-gray-200 p-3">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={item.has}
                onChange={(e) => setItem(key, { has: e.target.checked })}
                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 shrink-0"
              />
              <span className="text-sm font-medium text-gray-900">{SOCIAL_PROOF_LABELS[key]}</span>
            </label>
            {item.has && (
              <textarea
                value={item.comment}
                onChange={(e) => setItem(key, { comment: e.target.value })}
                placeholder="Подробности (опционально): ссылки, описание, цифры…"
                rows={2}
                className="ds-input mt-2 w-full resize-y text-xs"
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

interface HypothesesSectionProps {
  text: string | null;
  generatedAt: string | null;
  error: string | null;
  generating: boolean;
  briefSaved: boolean;
  stale: boolean;
  onGenerate: () => void;
}

function HypothesesSection({
  text,
  generatedAt,
  error,
  generating,
  briefSaved,
  stale,
  onGenerate,
}: HypothesesSectionProps) {
  const hasResult = !!text;
  const formattedAt = generatedAt
    ? new Date(generatedAt).toLocaleString('ru-RU', {
        day: '2-digit',
        month: 'long',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;
  // Shared style for the four status messages (generating / error /
  // not-saved-yet / generated-at). Editorial dark: surface-elev background,
  // hairline border, paper text. State signaled by 6px status dot, not by
  // tinted backgrounds. Same recipe as BriefAutofillPanel.
  const statusBoxStyle = {
    background: 'var(--cp-surface-elev)',
    border: '1px solid var(--cp-divider)',
    color: 'var(--cp-paper)',
  };

  return (
    <section className={SECTION_BASE} style={SECTION_STYLE}>
      <header
        className="px-6 py-3 flex items-baseline gap-3"
        style={{
          borderBottom: '1px solid var(--cp-divider)',
          background: 'var(--cp-surface-elev)',
        }}
      >
        <span className="ds-eyebrow shrink-0">AI ассистент</span>
        <h2 className="text-sm font-semibold m-0" style={{ color: 'var(--cp-paper)' }}>
          Гипотезы по сбору базы
        </h2>
      </header>
      <div className="p-6 space-y-4">
        <p className="text-xs" style={{ color: 'var(--cp-paper-mute)' }}>
          На основе сохранённого брифа AI предлагает 5–10 конкретных гипотез по сбору
          базы потенциальных клиентов: какой источник использовать, какие фильтры/запросы
          задать и какой объём ожидать.
        </p>

        {generating && (
          <div
            className="flex items-center gap-2.5 rounded-md px-4 py-3 text-sm"
            style={statusBoxStyle}
          >
            <Loader2
              className="h-4 w-4 animate-spin shrink-0"
              style={{ color: 'var(--cp-paper-faint)' }}
              aria-hidden
            />
            <span style={{ color: 'var(--cp-paper-mute)' }}>
              Генерируем гипотезы — это занимает 30–60 секунд…
            </span>
          </div>
        )}

        {error && !generating && (
          <div
            className="flex items-start gap-2.5 rounded-md px-4 py-3 text-sm"
            style={statusBoxStyle}
            role="alert"
          >
            <span
              aria-hidden
              className="ds-status-dot shrink-0"
              style={{ background: 'var(--cp-red)', marginTop: '7px' }}
            />
            <span>{error}</span>
          </div>
        )}

        {!briefSaved && !hasResult && !generating && (
          <p className="text-xs" style={{ color: 'var(--cp-paper-faint)' }}>
            Сначала сохраните бриф — после первого сохранения генерация запустится автоматически.
          </p>
        )}

        {hasResult && (
          <div className="space-y-2">
            {stale && (
              <div
                className="flex items-start gap-2.5 rounded-md px-4 py-3 text-sm"
                style={statusBoxStyle}
                role="alert"
              >
                <span
                  aria-hidden
                  className="ds-status-dot shrink-0"
                  style={{ background: 'var(--cp-amber)', marginTop: '7px' }}
                />
                <span style={{ color: 'var(--cp-paper)' }}>
                  Бриф изменился после генерации — рекомендации устарели. Нажмите
                  «Сгенерировать заново», чтобы обновить их под текущий бриф.
                </span>
              </div>
            )}
            {formattedAt && (
              <p className="text-[11px]" style={{ color: 'var(--cp-paper-faint)' }}>
                Сгенерировано: {formattedAt}
              </p>
            )}
            <LeadSourceHypothesesView markdown={text!} />
          </div>
        )}

        {briefSaved && (hasResult || error) && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              onClick={onGenerate}
              disabled={generating}
              className="ds-btn-secondary inline-flex h-9 items-center gap-2 px-4 text-xs disabled:cursor-not-allowed disabled:opacity-50"
            >
              {generating && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />}
              {hasResult ? 'Сгенерировать заново' : 'Сгенерировать ещё раз'}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

export function ClientBriefForm({
  endpoint,
  hypothesesEndpoint,
  autofillEndpoint,
  title,
  subtitle,
  auditPrefix,
}: ClientBriefFormProps) {
  const [fields, setFields] = useState<ClientBriefFields>(EMPTY_BRIEF_FIELDS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState('');
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // Hypotheses (only used when hypothesesEndpoint is provided).
  const [hypothesesText, setHypothesesText] = useState<string | null>(null);
  const [hypothesesAt, setHypothesesAt] = useState<string | null>(null);
  const [hypothesesError, setHypothesesError] = useState<string | null>(null);
  const [hypothesesGenerating, setHypothesesGenerating] = useState(false);
  const [hypothesesStale, setHypothesesStale] = useState(false);
  // Tracks "we already auto-triggered after a save" to avoid loops on errors.
  const autoTriggeredRef = useRef(false);

  const apiFetch = useCallback(async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) throw new Error('Not authenticated');
    const res = await fetch(path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let parsed: { error?: unknown; code?: unknown } | null = null;
      try {
        parsed = JSON.parse(text) as { error?: unknown; code?: unknown };
      } catch {
        parsed = null;
      }
      // Демо-аккаунт: мутации центрально режутся 403 + code DEMO_READONLY.
      // Локальный apiFetch идёт мимо authFetch (где живёт общий перехват),
      // поэтому зеркалим его здесь — иначе демо-юзер видит сырую inline-ошибку
      // вместо глобальной модалки «зарегистрируйтесь».
      if (res.status === 403 && parsed?.code === 'DEMO_READONLY') {
        promptDemoRegister();
      }
      const msg = typeof parsed?.error === 'string' ? parsed.error : '';
      throw new Error(msg || text || `Request failed: ${res.status}`);
    }
    return (await res.json()) as T;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await apiFetch<BriefApiResponse>(endpoint);
        if (cancelled) return;
        if (data.brief) {
          setFields(normalizeBriefFields(data.brief.fields));
          setSavedAt(data.brief.updated_at);
        }
      } catch (err) {
        void logError(`${auditPrefix}.load.failed`, err);
        if (!cancelled) setError(err instanceof Error ? err.message : 'Ошибка загрузки');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [endpoint, apiFetch, auditPrefix]);

  // Load existing hypotheses on mount (read-only — won't generate).
  useEffect(() => {
    if (!hypothesesEndpoint) return;
    let cancelled = false;
    void (async () => {
      try {
        const data = await apiFetch<HypothesesApiResponse>(hypothesesEndpoint);
        if (cancelled) return;
        setHypothesesText(data.lead_source_hypotheses);
        setHypothesesAt(data.lead_source_hypotheses_generated_at);
        setHypothesesError(data.lead_source_hypotheses_error);
        setHypothesesStale(data.lead_source_hypotheses_stale ?? false);
      } catch (err) {
        if (!cancelled) {
          void logError(`${auditPrefix}.hypotheses.load.failed`, err);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hypothesesEndpoint, apiFetch, auditPrefix]);

  const generateHypotheses = useCallback(
    async (opts: { regenerate?: boolean } = {}) => {
      if (!hypothesesEndpoint) return;
      setHypothesesGenerating(true);
      setHypothesesError(null);
      try {
        const url = opts.regenerate ? `${hypothesesEndpoint}?regenerate=1` : hypothesesEndpoint;
        const data = await apiFetch<HypothesesApiResponse>(url, { method: 'POST' });
        setHypothesesText(data.lead_source_hypotheses);
        setHypothesesAt(data.lead_source_hypotheses_generated_at);
        setHypothesesError(data.lead_source_hypotheses_error);
        setHypothesesStale(data.lead_source_hypotheses_stale ?? false);
        if (data.lead_source_hypotheses) {
          void logAudit(`${auditPrefix}.hypotheses.generated`, 'Hypotheses generated', {
            regenerate: !!opts.regenerate,
          });
        }
      } catch (err) {
        void logError(`${auditPrefix}.hypotheses.generate.failed`, err);
        setHypothesesError(err instanceof Error ? err.message : 'Не удалось сгенерировать гипотезы');
      } finally {
        setHypothesesGenerating(false);
      }
    },
    [hypothesesEndpoint, apiFetch, auditPrefix],
  );

  async function handleSave() {
    setSaving(true);
    setError('');
    try {
      const data = await apiFetch<BriefApiResponse>(endpoint, {
        method: 'PUT',
        body: JSON.stringify({ fields }),
      });
      if (data.brief) {
        setFields(normalizeBriefFields(data.brief.fields));
        setSavedAt(data.brief.updated_at);
      }
      void logAudit(`${auditPrefix}.save.success`, 'Brief saved');

      // Keep the recommendations panel in sync with what the server just did:
      // an EMPTY save wipes them (mirror handleClearAll) — otherwise a
      // hand-cleared «Сохранить» would leave deleted recs on screen under a
      // misleading «устарели» banner until reload; a NON-empty edit marks
      // existing recs stale and, on the first one, kicks off generation.
      if (!compileBriefText(fields).trim()) {
        setHypothesesText(null);
        setHypothesesAt(null);
        setHypothesesError(null);
        setHypothesesStale(false);
        autoTriggeredRef.current = false;
      } else {
        if (hypothesesText) setHypothesesStale(true);
        if (
          hypothesesEndpoint &&
          !hypothesesText &&
          !hypothesesError &&
          !autoTriggeredRef.current
        ) {
          autoTriggeredRef.current = true;
          void generateHypotheses();
        }
      }
    } catch (err) {
      void logError(`${auditPrefix}.save.failed`, err);
      setError(err instanceof Error ? err.message : 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  }

  // Wipe the whole brief in one click — for when the client repurposes the slot
  // for a new project (e.g. changed the website) and wants a clean slate instead
  // of clearing each field by hand. Saving an empty brief also clears the stored
  // lead-source recommendations server-side, so old suggestions don't linger.
  async function handleClearAll() {
    if (
      typeof window !== 'undefined' &&
      !window.confirm('Очистить весь бриф? Все поля и сгенерированные рекомендации будут удалены. Действие необратимо.')
    ) {
      return;
    }
    setClearing(true);
    setError('');
    try {
      const data = await apiFetch<BriefApiResponse>(endpoint, {
        method: 'PUT',
        body: JSON.stringify({ fields: EMPTY_BRIEF_FIELDS }),
      });
      setFields(data.brief ? normalizeBriefFields(data.brief.fields) : EMPTY_BRIEF_FIELDS);
      if (data.brief) setSavedAt(data.brief.updated_at);
      // Recommendations are wiped server-side on an empty save — clear the display too.
      setHypothesesText(null);
      setHypothesesAt(null);
      setHypothesesError(null);
      setHypothesesStale(false);
      autoTriggeredRef.current = false;
      void logAudit(`${auditPrefix}.clear.success`, 'Brief cleared');
    } catch (err) {
      void logError(`${auditPrefix}.clear.failed`, err);
      setError(err instanceof Error ? err.message : 'Не удалось очистить бриф');
    } finally {
      setClearing(false);
    }
  }

  const update = <K extends keyof ClientBriefFields>(key: K, value: ClientBriefFields[K]) => {
    setFields((prev) => ({ ...prev, [key]: value }));
  };

  const handleAutofillRequest = useCallback(
    async (website: string): Promise<BriefAutofillResult> => {
      if (!autofillEndpoint) {
        return { ok: false, fieldsPatch: {}, questions: [], error: 'Autofill endpoint не настроен' };
      }
      try {
        const data = await apiFetch<{
          ok?: boolean;
          fieldsPatch?: Partial<ClientBriefFields>;
          questions?: string[];
          error?: string;
        }>(autofillEndpoint, {
          method: 'POST',
          body: JSON.stringify({ website }),
        });
        return {
          ok: data?.ok !== false,
          fieldsPatch: data?.fieldsPatch ?? {},
          questions: Array.isArray(data?.questions) ? data!.questions! : [],
          error: data?.error,
        };
      } catch (err) {
        void logError(`${auditPrefix}.autofill.failed`, err);
        return {
          ok: false,
          fieldsPatch: {},
          questions: [],
          error: err instanceof Error ? err.message : 'Не удалось получить черновик',
        };
      }
    },
    [autofillEndpoint, apiFetch, auditPrefix],
  );

  const handleApplyAutofillPatch = useCallback((patch: Partial<ClientBriefFields>) => {
    setFields((prev) => mergePatchEmptyOnly(prev, patch));
    void logAudit(`${auditPrefix}.autofill.applied`, 'Autofill patch applied', {
      fields: Object.keys(patch),
    });
  }, [auditPrefix]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {(title || subtitle) && (
        <div>
          {title && <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">{title}</h1>}
          {subtitle && <p className="mt-1 text-sm text-gray-500">{subtitle}</p>}
          {savedAt && (
            <p className="mt-1 text-[11px] text-gray-400">
              Сохранено: {new Date(savedAt).toLocaleString('ru-RU')}
            </p>
          )}
        </div>
      )}

      {error && (
        <div className="p-4 bg-red-50 border border-red-200 rounded-lg flex items-center text-red-700 text-sm">
          <AlertCircle className="h-4 w-4 mr-2 shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError('')} className="ml-2" aria-label="Закрыть">✕</button>
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_300px] xl:gap-6 xl:items-start">
        <div className="min-w-0 space-y-6">
      {autofillEndpoint && (
        <BriefAutofillPanel
          initialWebsite={fields.company_website}
          onAutofill={handleAutofillRequest}
          onApplyPatch={handleApplyAutofillPatch}
        />
      )}

      <section id="brief-section-1" className={`${SECTION_BASE} scroll-mt-4`} style={SECTION_STYLE}>
        <SectionHeader number={1} title="О компании" />
        <div className="p-6 space-y-4">
          <TextField
            label="Сайт"
            value={fields.company_website}
            onChange={(v) => update('company_website', v)}
            placeholder="например, roga-kopyta.example"
          />
          <TextAreaField
            label="Краткое описание деятельности / компании / товара"
            value={fields.company_description}
            onChange={(v) => update('company_description', v)}
            placeholder="ООО «Рога и Копыта» — поставщик товаров для бизнеса…"
            rows={5}
          />
          <TextField
            label="Контактные данные (телефон, WhatsApp, email, telegram)"
            value={fields.company_contacts}
            onChange={(v) => update('company_contacts', v)}
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <TextField
              label="Цикл сделки (от первого касания до оплаты)"
              value={fields.deal_cycle}
              onChange={(v) => update('deal_cycle', v)}
              placeholder="например, 6-10 мес"
            />
            <TextField
              label="Средний чек"
              value={fields.avg_check}
              onChange={(v) => update('avg_check', v)}
              placeholder="например, 6-8 млн ₽"
            />
          </div>
        </div>
      </section>

      <section id="brief-section-2" className={`${SECTION_BASE} scroll-mt-4`} style={SECTION_STYLE}>
        <SectionHeader number={2} title="Продукт / услуга" />
        <div className="p-6 space-y-4">
          <TextAreaField
            label="Подробное описание товара/услуги"
            hint="Укажите свойства, ассортимент, статистику. Чем подробнее — тем лучше результаты AI."
            value={fields.product_description}
            onChange={(v) => update('product_description', v)}
            rows={6}
          />
          <PriceTierSelector
            value={fields.price_tier}
            onChange={(v) => update('price_tier', v)}
          />
          <TextAreaField
            label="5 преимуществ компании / товара"
            hint="Опишите 5 причин обратиться именно к вам. Главное преимущество — выделите явно."
            value={fields.advantages}
            onChange={(v) => update('advantages', v)}
            rows={5}
          />
          <TextAreaField
            label="Уникальное торговое предложение (УТП)"
            value={fields.usp}
            onChange={(v) => update('usp', v)}
            rows={3}
          />
          <TextAreaField
            label="5 проблем при работе с конкурентами"
            hint="С какими проблемами клиенты сталкиваются у конкурентов и как ваша компания их закрывает."
            value={fields.competitors_problems}
            onChange={(v) => update('competitors_problems', v)}
            rows={4}
          />
          <TextAreaField
            label="Внушительные цифры"
            hint="Возраст компании, количество проектов, клиенты, награды — то, что произведёт впечатление."
            value={fields.impressive_numbers}
            onChange={(v) => update('impressive_numbers', v)}
            rows={3}
          />
          <TextField
            label="Акция / специальное предложение (или «-», если не релевантно)"
            value={fields.special_offer}
            onChange={(v) => update('special_offer', v)}
          />
        </div>
      </section>

      <section id="brief-section-3" className={`${SECTION_BASE} scroll-mt-4`} style={SECTION_STYLE}>
        <SectionHeader number={3} title="Целевая аудитория" />
        <div className="p-6 space-y-4">
          <TextAreaField
            label="Описание ЦА"
            hint="Должности, индустрия, ЛПР, локация. Можно по сегментам (e-commerce, логистика…)."
            value={fields.target_audience}
            onChange={(v) => update('target_audience', v)}
            rows={6}
          />
          <TextAreaField
            label="С какими проблемами к вам приходят"
            value={fields.client_problems}
            onChange={(v) => update('client_problems', v)}
            rows={4}
          />
          <TextAreaField
            label="Какие вопросы / возражения вам задают"
            value={fields.common_questions}
            onChange={(v) => update('common_questions', v)}
            rows={3}
          />
        </div>
      </section>

      <section id="brief-section-4" className={`${SECTION_BASE} scroll-mt-4`} style={SECTION_STYLE}>
        <SectionHeader number={4} title="Коммуникация" />
        <div className="p-6 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <TextField
              label="От чьего лица ведём диалог — имя"
              value={fields.persona_name}
              onChange={(v) => update('persona_name', v)}
              placeholder="Александр Тычков"
            />
            <TextField
              label="Должность"
              value={fields.persona_position}
              onChange={(v) => update('persona_position', v)}
              placeholder="Директор по развитию (CBDO)"
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <TextField
              label="Кому передаём лидов — имя"
              value={fields.lead_recipient_name}
              onChange={(v) => update('lead_recipient_name', v)}
            />
            <TextField
              label="Email"
              type="email"
              value={fields.lead_recipient_email}
              onChange={(v) => update('lead_recipient_email', v)}
              placeholder="name@company.ru"
            />
            <TextField
              label="Должность"
              value={fields.lead_recipient_position}
              onChange={(v) => update('lead_recipient_position', v)}
            />
          </div>
          <TextAreaField
            label="Лид-магниты"
            hint="Что даёте взамен на ответ: бесплатный аудит, отчёт, исследование, бонус?"
            value={fields.lead_magnets}
            onChange={(v) => update('lead_magnets', v)}
            rows={2}
          />
          <TextField
            label="Гарантии (или «-»)"
            value={fields.guarantees}
            onChange={(v) => update('guarantees', v)}
          />
        </div>
      </section>

      <section id="brief-section-5" className={`${SECTION_BASE} scroll-mt-4`} style={SECTION_STYLE}>
        <SectionHeader number={5} title="Доказательства" />
        <div className="p-6 space-y-4">
          <TextAreaField
            label="Ваши действующие клиенты (3-5 примеров)"
            hint="Достаточно сайта / названия / ИНН. Поможем провести их анализ."
            value={fields.existing_clients}
            onChange={(v) => update('existing_clients', v)}
            rows={3}
          />
          <TextAreaField
            label="Какие результаты вашей работы могут впечатлить лида"
            hint="«Увеличили MAU в 115 раз», «100 лидов за месяц», «прибыль +80%»."
            value={fields.impressive_results}
            onChange={(v) => update('impressive_results', v)}
            rows={4}
          />
        </div>
      </section>

      <section id="brief-section-6" className={`${SECTION_BASE} scroll-mt-4`} style={SECTION_STYLE}>
        <SectionHeader number={6} title="Social proof" />
        <div className="p-6">
          <p className="text-[11px] text-gray-500 mb-3">
            Отметьте, что у вас есть. Под каждым пунктом можно добавить детали.
          </p>
          <SocialProofGrid
            value={fields.social_proof}
            onChange={(v) => update('social_proof', v)}
          />
        </div>
      </section>

      <section id="brief-section-7" className={`${SECTION_BASE} scroll-mt-4`} style={SECTION_STYLE}>
        <SectionHeader number={7} title="Дополнительный контекст" />
        <div className="p-6">
          <TextAreaField
            label="Любая дополнительная информация для AI"
            hint="Всё, что не попало в поля выше: тон голоса, табу, специфика ниши, лайфхаки."
            value={fields.additional_notes}
            onChange={(v) => update('additional_notes', v)}
            rows={5}
          />
        </div>
      </section>

      {hypothesesEndpoint && (
        <HypothesesSection
          text={hypothesesText}
          generatedAt={hypothesesAt}
          error={hypothesesError}
          generating={hypothesesGenerating}
          briefSaved={!!savedAt}
          stale={hypothesesStale}
          onGenerate={() => void generateHypotheses({ regenerate: !!hypothesesText })}
        />
      )}

      {/* Мобильный/планшетный сейв-бар: на xl+ действия уезжают в правый
          навигатор (BriefSectionNav). */}
      <div
        className="xl:hidden sticky bottom-4 rounded-xl p-4 flex items-center justify-end gap-3"
        style={{
          background: 'var(--cp-surface-elev)',
          border: '1px solid var(--cp-divider)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
        }}
      >
        <span className="text-xs mr-auto" style={{ color: 'var(--cp-paper-mute)' }}>
          Все поля опциональны — можно как черновик.
        </span>
        {savedAt && !saving && (
          <span className="inline-flex items-center gap-1 text-xs" style={{ color: 'var(--cp-green)' }}>
            <Check className="h-3.5 w-3.5" /> Сохранено
          </span>
        )}
        <button
          type="button"
          onClick={() => void handleClearAll()}
          disabled={saving || clearing}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors disabled:opacity-50"
          style={{ color: 'var(--cp-paper-mute)', border: '1px solid var(--cp-divider)' }}
        >
          {clearing && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {clearing ? 'Очистка…' : 'Очистить'}
        </button>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving || clearing}
          className="ds-btn-primary inline-flex h-10 items-center justify-center gap-2 px-6"
        >
          {saving && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {saving ? 'Сохранение…' : 'Сохранить'}
        </button>
      </div>
        </div>

        {/* Правый липкий навигатор (кольцо прогресса + карта разделов) — xl+. */}
        <aside className="hidden xl:block">
          <BriefSectionNav
            fields={fields}
            savedAt={savedAt}
            saving={saving}
            clearing={clearing}
            onSave={() => void handleSave()}
            onClear={() => void handleClearAll()}
          />
        </aside>
      </div>
    </div>
  );
}
