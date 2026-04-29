'use client';

import { useCallback, useEffect, useState } from 'react';
import { Check, AlertCircle, Loader2, Save } from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';
import { logAudit, logError } from '@/lib/loggerClient';
import {
  EMPTY_BRIEF_FIELDS,
  PRICE_TIER_LABELS,
  SOCIAL_PROOF_KEYS,
  SOCIAL_PROOF_LABELS,
  ALLOWED_PRICE_TIERS,
  normalizeBriefFields,
} from '@/lib/clientBrief';
import type {
  ClientBriefFields,
  ClientBriefPriceTier,
  ClientBriefSocialProofKey,
} from '@/lib/clientBrief';

interface ClientBriefFormProps {
  /** API endpoint that supports GET/PUT for the brief */
  endpoint: string;
  /** Optional title shown above the form */
  title?: string;
  /** Optional subtitle line */
  subtitle?: string;
  /** Audit-log event prefix, e.g. 'client.brief' or 'admin.client-brief' */
  auditPrefix: string;
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

const SECTION_BASE = 'rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden';
const HEADER_BASE = 'px-6 py-3 border-b border-gray-200 bg-gray-50 text-sm font-semibold text-gray-900';

function HelperText({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] text-gray-500 mt-1">{children}</p>;
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
      <label className="block text-xs font-medium text-gray-700 mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
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
      <label className="block text-xs font-medium text-gray-700 mb-1">{label}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={rows}
        className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white resize-y"
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
      <label className="block text-xs font-medium text-gray-700 mb-2">Ценовая категория</label>
      <div className="flex flex-wrap gap-2">
        {ALLOWED_PRICE_TIERS.map((tier) => {
          const active = value === tier;
          return (
            <button
              key={tier}
              type="button"
              onClick={() => onChange(active ? null : tier)}
              className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                active
                  ? 'bg-blue-600 text-white border-blue-600'
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
                className="mt-2 w-full px-3 py-2 text-xs border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white resize-y"
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

export function ClientBriefForm({ endpoint, title, subtitle, auditPrefix }: ClientBriefFormProps) {
  const [fields, setFields] = useState<ClientBriefFields>(EMPTY_BRIEF_FIELDS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedAt, setSavedAt] = useState<string | null>(null);

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
      try {
        const parsed = JSON.parse(text) as { error?: unknown };
        const msg = typeof parsed?.error === 'string' ? parsed.error : '';
        throw new Error(msg || text || `Request failed: ${res.status}`);
      } catch {
        throw new Error(text || `Request failed: ${res.status}`);
      }
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
    } catch (err) {
      void logError(`${auditPrefix}.save.failed`, err);
      setError(err instanceof Error ? err.message : 'Ошибка сохранения');
    } finally {
      setSaving(false);
    }
  }

  const update = <K extends keyof ClientBriefFields>(key: K, value: ClientBriefFields[K]) => {
    setFields((prev) => ({ ...prev, [key]: value }));
  };

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

      <section className={SECTION_BASE}>
        <header className={HEADER_BASE}>1. О компании</header>
        <div className="p-6 space-y-4">
          <TextField
            label="Сайт"
            value={fields.company_website}
            onChange={(v) => update('company_website', v)}
            placeholder="например, redev.ru"
          />
          <TextAreaField
            label="Краткое описание деятельности / компании / товара"
            value={fields.company_description}
            onChange={(v) => update('company_description', v)}
            placeholder="Группа компаний .redev — технологический партнёр для бизнеса…"
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

      <section className={SECTION_BASE}>
        <header className={HEADER_BASE}>2. Продукт / услуга</header>
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

      <section className={SECTION_BASE}>
        <header className={HEADER_BASE}>3. Целевая аудитория</header>
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

      <section className={SECTION_BASE}>
        <header className={HEADER_BASE}>4. Коммуникация</header>
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

      <section className={SECTION_BASE}>
        <header className={HEADER_BASE}>5. Доказательства</header>
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

      <section className={SECTION_BASE}>
        <header className={HEADER_BASE}>6. Social proof</header>
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

      <section className={SECTION_BASE}>
        <header className={HEADER_BASE}>7. Дополнительный контекст</header>
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

      <div className="sticky bottom-4 bg-white rounded-xl border border-gray-200 shadow-lg p-4 flex items-center justify-end gap-3">
        <span className="text-xs text-gray-500 mr-auto">
          Бриф можно сохранять как черновик — все поля опциональные.
        </span>
        {savedAt && !saving && (
          <span className="inline-flex items-center gap-1 text-xs text-green-700">
            <Check className="h-3.5 w-3.5" /> Сохранено
          </span>
        )}
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 px-6 text-sm font-semibold text-white shadow-sm shadow-blue-600/25 transition-all hover:-translate-y-0.5 hover:shadow-md hover:shadow-blue-600/35 active:translate-y-0 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {saving ? 'Сохранение...' : 'Сохранить бриф'}
        </button>
      </div>
    </div>
  );
}
