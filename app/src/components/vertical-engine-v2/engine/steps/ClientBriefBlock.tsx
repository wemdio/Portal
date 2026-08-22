'use client';

/**
 * Бриф клиента на шаге «Исследование»: загрузка заполненного шаблона агентства
 * (PDF/DOCX/TXT), разбор по полям стандарта и ручная доводка специалистом.
 *
 * Зачем правка руками: клиенты заполняют бриф дырявым — часть строк пустая,
 * часть закрыта заглушкой. Разбор помечает такие поля как отсутствующие, а
 * специалист дозаполняет то, что знает сам, до запуска исследования.
 *
 * Поля, их лейблы и сборка текста для промптов — общие с брифом клиентского
 * кабинета (lib/clientBrief), здесь только представление в токенах движка.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  ALLOWED_PRICE_TIERS,
  EMPTY_BRIEF_FIELDS,
  PRICE_TIER_LABELS,
  SOCIAL_PROOF_KEYS,
  SOCIAL_PROOF_LABELS,
} from '@/lib/clientBrief';
import type {
  ClientBriefFields,
  ClientBriefPriceTier,
  ClientBriefSocialProofKey,
} from '@/lib/clientBrief';

import {
  VE_API,
  veEngineCall,
  type VeClientBriefIcpDto,
  type VeClientBriefResponse,
} from '../api';
import { HE, Spinner } from '../design';
import { StatusBox } from '../ui';

const ACCEPT = '.pdf,.docx,.txt,.md';

const EMPTY_ICP: VeClientBriefIcpDto = {
  include: [],
  exclude: [],
  size: '',
  geo: '',
  triggers: [],
  qualification: '',
};

/** Списки рамки правятся построчно: одна строка — один пункт. */
const ICP_LISTS: Array<{ key: 'include' | 'exclude' | 'triggers'; label: string; hint: string }> = [
  { key: 'include', label: 'Целевые сегменты', hint: 'одна строка — один пункт' },
  { key: 'exclude', label: 'Исключить', hint: 'эти сегменты движок не предложит вовсе' },
  { key: 'triggers', label: 'Рабочие триггеры для базы', hint: 'поводы, которые клиент считает рабочими' },
];

const ICP_LINES: Array<{ key: 'size' | 'geo' | 'qualification'; label: string }> = [
  { key: 'size', label: 'Размер бизнеса' },
  { key: 'geo', label: 'География' },
  { key: 'qualification', label: 'Минимальная квалификация лида' },
];

type TextField = Exclude<keyof ClientBriefFields, 'social_proof' | 'price_tier'>;

interface FieldDef {
  key: TextField;
  label: string;
  /** Многострочные ответы: перечисления преимуществ, сегменты ЦА и т.п. */
  long?: boolean;
}

const SECTIONS: Array<{ title: string; fields: FieldDef[] }> = [
  {
    title: 'Компания',
    fields: [
      { key: 'company_website', label: 'Ссылка на сайт (как в брифе)' },
      { key: 'company_description', label: 'Краткое описание деятельности', long: true },
      { key: 'company_contacts', label: 'Контактные данные', long: true },
      { key: 'deal_cycle', label: 'Цикл сделки', long: true },
      { key: 'avg_check', label: 'Средний чек', long: true },
    ],
  },
  {
    title: 'Продукт и оффер',
    fields: [
      { key: 'product_description', label: 'Подробное описание товара/услуги', long: true },
      { key: 'advantages', label: '5 преимуществ', long: true },
      { key: 'usp', label: 'Уникальное торговое предложение', long: true },
      { key: 'competitors_problems', label: '5 проблем в работе с конкурентами', long: true },
      { key: 'impressive_numbers', label: 'Внушительные цифры', long: true },
      { key: 'special_offer', label: 'Акция / специальное предложение', long: true },
    ],
  },
  {
    title: 'Целевая аудитория',
    fields: [
      { key: 'target_audience', label: 'Должности, индустрии, ЛПР, гео', long: true },
      { key: 'client_problems', label: 'С какими проблемами приходят', long: true },
      { key: 'common_questions', label: 'Какие вопросы задают / возражения', long: true },
    ],
  },
  {
    title: 'Коммуникация',
    fields: [
      { key: 'persona_name', label: 'От чьего лица ведём диалог — имя' },
      { key: 'persona_position', label: 'От чьего лица — должность' },
      { key: 'lead_recipient_name', label: 'Кому передаём лидов — имя' },
      { key: 'lead_recipient_email', label: 'Кому передаём лидов — email' },
      { key: 'lead_recipient_position', label: 'Кому передаём лидов — должность' },
      { key: 'lead_magnets', label: 'Лид-магниты', long: true },
      { key: 'guarantees', label: 'Гарантии клиенту', long: true },
    ],
  },
  {
    title: 'Доказательства',
    fields: [
      { key: 'existing_clients', label: 'Действующие клиенты', long: true },
      { key: 'impressive_results', label: 'Результаты, которые впечатлят лида', long: true },
    ],
  },
  {
    title: 'Дополнительно',
    fields: [{ key: 'additional_notes', label: 'Прочий существенный контекст', long: true }],
  },
];

function formatDate(value: string): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
}

export function ClientBriefBlock({
  projectId,
  onBriefChanged,
}: {
  projectId: string | null;
  /** Обычно тихая перезагрузка деталей проекта. */
  onBriefChanged?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [fields, setFields] = useState<ClientBriefFields>(EMPTY_BRIEF_FIELDS);
  const [icp, setIcp] = useState<VeClientBriefIcpDto>(EMPTY_ICP);
  const [clientTypes, setClientTypes] = useState<string[]>([]);
  const [missing, setMissing] = useState<string[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [uploadedAt, setUploadedAt] = useState('');
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const applyResponse = useCallback((data: VeClientBriefResponse) => {
    setFields(data.brief?.fields ?? EMPTY_BRIEF_FIELDS);
    setIcp(data.brief?.icp ?? EMPTY_ICP);
    setClientTypes(data.brief?.client_types ?? []);
    setMissing(data.brief?.missing ?? []);
    setFileName(data.brief?.file_name ?? null);
    setUploadedAt(data.brief?.uploaded_at ?? '');
    setDirty(false);
  }, []);

  const load = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    setError('');
    try {
      const { ok, data } = await veEngineCall<VeClientBriefResponse>(
        `${VE_API}/projects/${projectId}/brief`,
      );
      if (!ok) {
        setError(data.error || 'Не удалось загрузить бриф');
        return;
      }
      applyResponse(data);
    } finally {
      setLoading(false);
    }
  }, [applyResponse, projectId]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const handleUpload = async (file: File) => {
    if (!projectId || uploading) return;
    setUploading(true);
    setError('');
    try {
      const form = new FormData();
      form.append('file', file);
      const { ok, data } = await veEngineCall<VeClientBriefResponse>(
        `${VE_API}/projects/${projectId}/brief`,
        { method: 'POST', body: form },
      );
      if (!ok) {
        setError(data.error || 'Не удалось разобрать бриф');
        return;
      }
      applyResponse(data);
      onBriefChanged?.();
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleSave = async () => {
    if (!projectId || saving) return;
    setSaving(true);
    setError('');
    try {
      const { ok, data } = await veEngineCall<VeClientBriefResponse>(
        `${VE_API}/projects/${projectId}/brief`,
        { method: 'PUT', body: JSON.stringify({ fields, icp }) },
      );
      if (!ok) {
        setError(data.error || 'Не удалось сохранить бриф');
        return;
      }
      applyResponse(data);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
      onBriefChanged?.();
    } finally {
      setSaving(false);
    }
  };

  const setText = (key: TextField, value: string) => {
    setFields((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
  };

  const filledCount = useMemo(
    () =>
      SECTIONS.flatMap((s) => s.fields).filter((f) => (fields[f.key] as string).trim().length > 0)
        .length,
    [fields],
  );
  const totalCount = useMemo(() => SECTIONS.flatMap((s) => s.fields).length, []);

  return (
    <div className="mt-8 border-t border-gray-100 pt-6 text-left">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className={HE.secTitle}>Бриф клиента</h3>
        <button type="button" onClick={() => setOpen((v) => !v)} className={HE.btnQuiet}>
          {open ? 'Свернуть' : fileName ? 'Открыть бриф' : 'Загрузить бриф'}
        </button>
      </div>
      <p className={`mt-1 text-xs ${HE.muted2}`}>
        Заполненный клиентом бриф — второй источник для исследования рядом с сайтом: цикл сделки,
        чек, возражения и портрет ЛПР сайт обычно не показывает.
        {fileName ? ` Загружен: ${fileName}${uploadedAt ? ` · ${formatDate(uploadedAt)}` : ''}.` : ''}
      </p>

      {!open ? null : (
        <div className="mt-4 space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={fileRef}
              type="file"
              accept={ACCEPT}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void handleUpload(file);
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading || !projectId}
              className={`${HE.btnPrimary} inline-flex items-center gap-2`}
            >
              {uploading ? <Spinner className="h-3.5 w-3.5" /> : null}
              {fileName ? 'Загрузить другой файл' : 'Выбрать файл брифа'}
            </button>
            <span className={`text-xs ${HE.muted}`}>PDF, DOCX или TXT</span>
            {loading ? <Spinner className="h-3.5 w-3.5" /> : null}
          </div>

          {error ? <StatusBox tone="error">{error}</StatusBox> : null}

          {uploading ? (
            <p className={`text-xs ${HE.muted2}`}>
              Читаем файл и раскладываем ответы по полям — обычно меньше минуты.
            </p>
          ) : null}

          <p className={`text-xs ${HE.muted2}`}>
            Заполнено {filledCount} из {totalCount} полей.
            {missing.length
              ? ' Пустые поля движок не выдумывает — допишите то, что знаете сами.'
              : ''}
          </p>

          {SECTIONS.map((section) => (
            <fieldset key={section.title} className={`${HE.card} ${HE.cardPad}`}>
              <legend className={`px-1 text-xs font-semibold ${HE.muted2}`}>{section.title}</legend>
              <div className="mt-2 space-y-3">
                {section.fields.map((field) => {
                  const value = fields[field.key] as string;
                  const isGap = !value.trim();
                  return (
                    <label key={field.key} className="block">
                      <span className={`text-xs ${isGap ? 'text-amber-600' : HE.muted2}`}>
                        {field.label}
                        {isGap ? ' · не заполнено' : ''}
                      </span>
                      {field.long ? (
                        <textarea
                          value={value}
                          rows={3}
                          onChange={(e) => setText(field.key, e.target.value)}
                          className={`${HE.input} mt-1 w-full resize-y`}
                        />
                      ) : (
                        <input
                          type="text"
                          value={value}
                          onChange={(e) => setText(field.key, e.target.value)}
                          className={`${HE.input} mt-1 w-full`}
                        />
                      )}
                    </label>
                  );
                })}

                {section.title === 'Продукт и оффер' ? (
                  <label className="block">
                    <span className={`text-xs ${fields.price_tier ? HE.muted2 : 'text-amber-600'}`}>
                      Ценовая категория{fields.price_tier ? '' : ' · не заполнено'}
                    </span>
                    <select
                      value={fields.price_tier ?? ''}
                      onChange={(e) => {
                        const next = e.target.value as ClientBriefPriceTier | '';
                        setFields((prev) => ({ ...prev, price_tier: next === '' ? null : next }));
                        setDirty(true);
                      }}
                      className={`${HE.input} mt-1 w-full`}
                    >
                      <option value="">Не указана</option>
                      {ALLOWED_PRICE_TIERS.map((tier) => (
                        <option key={tier} value={tier}>
                          {PRICE_TIER_LABELS[tier]}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
              </div>
            </fieldset>
          ))}

          <fieldset className={`${HE.card} ${HE.cardPad}`}>
            <legend className={`px-1 text-xs font-semibold ${HE.muted2}`}>
              Рамка ЦА — ограничение для гипотез
            </legend>
            <p className={`mt-1 text-xs ${HE.muted2}`}>
              Сегменты из «Исключить» движок не предложит вовсе, а не понизит по проценту. Пустая
              рамка ничего не ограничивает.
              {clientTypes.length
                ? ` Типы клиентов для писем: ${clientTypes.join('; ')}.`
                : ''}
            </p>
            <div className="mt-3 space-y-3">
              {ICP_LISTS.map((list) => (
                <label key={list.key} className="block">
                  <span className={`text-xs ${list.key === 'exclude' ? 'text-amber-600' : HE.muted2}`}>
                    {list.label} · {list.hint}
                  </span>
                  <textarea
                    value={icp[list.key].join('\n')}
                    rows={3}
                    onChange={(e) => {
                      const items = e.target.value
                        .split('\n')
                        .map((line) => line.trim())
                        .filter(Boolean);
                      setIcp((prev) => ({ ...prev, [list.key]: items }));
                      setDirty(true);
                    }}
                    className={`${HE.input} mt-1 w-full resize-y`}
                  />
                </label>
              ))}
              {ICP_LINES.map((line) => (
                <label key={line.key} className="block">
                  <span className={`text-xs ${HE.muted2}`}>{line.label}</span>
                  <input
                    type="text"
                    value={icp[line.key]}
                    onChange={(e) => {
                      setIcp((prev) => ({ ...prev, [line.key]: e.target.value }));
                      setDirty(true);
                    }}
                    className={`${HE.input} mt-1 w-full`}
                  />
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className={`${HE.card} ${HE.cardPad}`}>
            <legend className={`px-1 text-xs font-semibold ${HE.muted2}`}>Social proof</legend>
            <div className="mt-2 space-y-2">
              {(SOCIAL_PROOF_KEYS as readonly ClientBriefSocialProofKey[]).map((key) => {
                const item = fields.social_proof[key];
                return (
                  <div key={key} className="flex flex-wrap items-center gap-2">
                    <label className="flex min-w-[240px] items-center gap-2 text-xs text-gray-700">
                      <input
                        type="checkbox"
                        checked={item.has}
                        onChange={(e) => {
                          setFields((prev) => ({
                            ...prev,
                            social_proof: {
                              ...prev.social_proof,
                              [key]: { ...prev.social_proof[key], has: e.target.checked },
                            },
                          }));
                          setDirty(true);
                        }}
                      />
                      {SOCIAL_PROOF_LABELS[key]}
                    </label>
                    <input
                      type="text"
                      value={item.comment}
                      placeholder="Комментарий / ссылка"
                      onChange={(e) => {
                        setFields((prev) => ({
                          ...prev,
                          social_proof: {
                            ...prev.social_proof,
                            [key]: { ...prev.social_proof[key], comment: e.target.value },
                          },
                        }));
                        setDirty(true);
                      }}
                      className={`${HE.input} flex-1`}
                    />
                  </div>
                );
              })}
            </div>
          </fieldset>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving || !dirty}
              className={`${HE.btnPrimary} inline-flex items-center gap-2`}
            >
              {saving ? <Spinner className="h-3.5 w-3.5" /> : null}
              Сохранить бриф
            </button>
            {saved ? <span className="text-xs text-emerald-600">Сохранено</span> : null}
          </div>
        </div>
      )}
    </div>
  );
}
