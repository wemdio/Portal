'use client';

/**
 * Общие куски шага 3 «Launch» (EngStepLaunch): ИТОГОВЫЕ письма шаблона, только
 * чтение (то, что запуск кладёт в кампанию: FinalLetters — «Preview letters»),
 * ленивое превью базы (GET /eng/bases/[id]/rows, первые 100 строк, компактные
 * колонки: BasePreview) и ЧАСЫ ОТПРАВКИ — редактор (SendingWindowEditor) и их
 * правка у уже запущенного рынка (LaunchedSendingWindow: PATCH
 * /eng/templates/[id]/schedule переставляет окно во всех кампаниях запуска).
 *
 * Прежний шаг ревью с запуском всех шаблонов разом отсюда убран: запуск рынков теперь делает
 * одна кнопка «Launch» шага 3 и автозапуск (S3), а у отдельного готового рынка
 * — «Launch now» на его карточке.
 */

import { useCallback, useEffect, useState } from 'react';
import { Clock, Eye } from 'lucide-react';
import type { HeTemplate } from '@/lib/hypothesisEngine/types';
import { buildLaunchSequence } from '@/lib/hypothesisEngine/launchHandoff';
import {
  engTemplatePlaceholders,
  fetchEngBaseRows,
  fetchEngSendingWindow,
  updateEngSendingWindow,
  type EngBaseSummary,
  type EngSendingWindow,
  type EngSendingWindowTimezoneOption,
  type EngSendingWindowWeekdayOption,
} from './api-client';
import { EngSpinner } from './ui';
import { engPlaceholderText } from './engText';

/** Компактные колонки превью; остальные поля строки — в title строки таблицы. */
const PREVIEW_COLUMNS = ['company', 'website', 'email'] as const;
const PREVIEW_LIMIT = 100;

/* ── Ленивое превью базы (по кнопке) ── */

export function BasePreview({ base }: { base: EngBaseSummary }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<{ rows: Record<string, unknown>[]; total: number } | null>(null);

  const onToggle = async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (preview || loading) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetchEngBaseRows(base.id, { limit: PREVIEW_LIMIT });
      setPreview({ rows: res.rows ?? [], total: res.total ?? 0 });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load the preview');
    } finally {
      setLoading(false);
    }
  };

  // Только компактные колонки, реально присутствующие в базе; email-статус —
  // служебное поле строки (_email_status), в columns его нет.
  const columns = (base.columns ?? []).filter((c) => (PREVIEW_COLUMNS as readonly string[]).includes(c));

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => void onToggle()}
        className="ds-btn-secondary inline-flex items-center gap-1.5 text-[11px]"
      >
        {loading ? <EngSpinner className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
        {open ? 'Hide contacts' : 'Preview contacts'}
      </button>
      {error && (
        <div className="mt-2 text-[11px]" style={{ color: 'var(--cp-red)' }}>
          {error}
        </div>
      )}
      {open && preview && (
        <div
          className="mt-2 overflow-x-auto rounded-md"
          style={{ border: '1px solid var(--cp-divider)' }}
        >
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left" style={{ color: 'var(--cp-text-l)' }}>
                {columns.map((c) => (
                  <th key={c} className="px-3 py-2 font-semibold">
                    {c}
                  </th>
                ))}
                <th className="px-3 py-2 font-semibold">email status</th>
              </tr>
            </thead>
            <tbody>
              {preview.rows.map((row, i) => (
                <tr
                  key={i}
                  title={JSON.stringify(row).slice(0, 600)}
                  style={{ borderTop: '1px solid var(--cp-divider)' }}
                >
                  {columns.map((c) => (
                    <td key={c} className="px-3 py-1.5 truncate max-w-[220px]" style={{ color: 'var(--cp-paper)' }}>
                      {typeof row[c] === 'string' || typeof row[c] === 'number' ? String(row[c]) : ''}
                    </td>
                  ))}
                  <td
                    className="px-3 py-1.5 ds-mono"
                    style={{
                      color:
                        row._email_status === 'ok'
                          ? 'var(--cp-green)'
                          : row._email_status
                            ? 'var(--cp-amber)'
                            : 'var(--cp-text-l)',
                    }}
                  >
                    {typeof row._email_status === 'string' ? row._email_status : ''}
                  </td>
                </tr>
              ))}
              {preview.rows.length === 0 && (
                <tr style={{ borderTop: '1px solid var(--cp-divider)' }}>
                  <td className="px-3 py-2" colSpan={columns.length + 1} style={{ color: 'var(--cp-text-l)' }}>
                    No contacts collected yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="px-3 py-2 text-[10px] ds-mono" style={{ color: 'var(--cp-text-l)' }}>
            Showing {preview.rows.length} of {preview.total.toLocaleString('en-US')} rows
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Окно отправки (sending window) ── */

/**
 * Часы для выпадашек. Рассыльщик принимает 'ЧЧ:ММ'; целого часа достаточно, а
 * свободный ввод времени дал бы клиенту способ отправить то, что API отклонит.
 */
const HOUR_OPTIONS: string[] = Array.from(
  { length: 24 },
  (_, h) => `${String(h).padStart(2, '0')}:00`,
);

export interface SendingWindowConfig {
  value: EngSendingWindow;
  /**
   * Пункты выпадашки поясов — `timezone_options ?? timezones` ответа (план
   * §1C): полный список с группами, когда сервер его отдаёт, иначе прежние 8.
   * Из него же подпись пояса в сводке (sendingWindowSummary).
   */
  timezones: EngSendingWindowTimezoneOption[];
  weekdays: EngSendingWindowWeekdayOption[];
}

/**
 * Пункты выпадашки из ответа GET: полный список (`timezone_options`), если он
 * непустой, иначе прежние 8 (`timezones`). Подбор по поясу браузера — только
 * по `timezones` (EngStepLaunch, browserTimezoneIn), не отсюда.
 */
export function engTimezoneOptionsOf(res: {
  timezones?: EngSendingWindowTimezoneOption[];
  timezone_options?: EngSendingWindowTimezoneOption[];
}): EngSendingWindowTimezoneOption[] {
  if (Array.isArray(res.timezone_options) && res.timezone_options.length > 0) return res.timezone_options;
  return Array.isArray(res.timezones) ? res.timezones : [];
}

/** Смещение пояса от UTC в минутах на момент `at`; null — пояс не читается. */
export function tzOffsetMinutes(timeZone: string, at: Date): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(at);
    const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'));
    return Number.isFinite(asUtc) ? Math.round((asUtc - at.getTime()) / 60_000) : null;
  } catch {
    return null;
  }
}

/** 60 → «UTC+1», -210 → «UTC-3:30», 0 → «UTC+0» (как подписи списка сервера). */
function utcOffsetText(minutes: number): string {
  const abs = Math.abs(minutes);
  const mm = abs % 60;
  return `UTC${minutes < 0 ? '-' : '+'}${Math.floor(abs / 60)}${mm ? `:${String(mm).padStart(2, '0')}` : ''}`;
}

/**
 * «UTC+1, UTC+2 in summer» / «UTC+3» по Intl браузера (январь и июль; летнее —
 * большее из двух, так верно и для южного полушария); null — пояс браузер не
 * знает.
 */
function utcOffsetsText(timeZone: string): string | null {
  const year = new Date().getUTCFullYear();
  const jan = tzOffsetMinutes(timeZone, new Date(Date.UTC(year, 0, 15, 12)));
  const jul = tzOffsetMinutes(timeZone, new Date(Date.UTC(year, 6, 15, 12)));
  if (jan === null || jul === null) return null;
  if (jan === jul) return utcOffsetText(jan);
  return `${utcOffsetText(Math.min(jan, jul))}, ${utcOffsetText(Math.max(jan, jul))} in summer`;
}

/**
 * Подпись пояса, которого нет среди пунктов сервера, — вместо голого
 * идентификатора: сохранённое окно, выставленное не из кабинета, или пояс,
 * подсказанный странами проекта, пока полный список выключен (EngStepLaunch).
 * Подсказанный — «Suggested for your countries (UTC+1, UTC+2 in summer)»: город
 * из идентификатора тут сбил бы с толку (Arctic/Longyearbyen, Africa/Ceuta —
 * канонические id рассыльщика для Берлина и Парижа). Прочие — город из
 * последнего сегмента id и смещения; у Etc/GMT±N — только смещения (знак в
 * имени обратный).
 */
export function engTimezoneFallbackLabel(timeZone: string, opts: { suggested?: boolean } = {}): string {
  const offsets = utcOffsetsText(timeZone);
  if (opts.suggested) return offsets ? `Suggested for your countries (${offsets})` : 'Suggested for your countries';
  if (timeZone.startsWith('Etc/')) return offsets ?? timeZone;
  const city = (timeZone.split('/').pop() ?? '').replace(/_/g, ' ') || timeZone;
  return offsets ? `${city} (${offsets})` : city;
}

/**
 * Пункты подряд с одной группой — один `<optgroup>`; пункт без группы (прежние
 * 8, сохранённый пояс вне списка) — сам по себе. Группы не сортируем и не
 * сливаем: порядок задаёт сервер.
 */
function groupTimezoneOptions(
  options: readonly EngSendingWindowTimezoneOption[],
): Array<{ group: string | null; options: EngSendingWindowTimezoneOption[] }> {
  const out: Array<{ group: string | null; options: EngSendingWindowTimezoneOption[] }> = [];
  for (const o of options) {
    const group = typeof o.group === 'string' && o.group ? o.group : null;
    const last = out[out.length - 1];
    if (last && group !== null && last.group === group) last.options.push(o);
    else out.push({ group, options: [o] });
  }
  return out;
}

/**
 * Окно отправки шаблона: сохранённый выбор клиента (или дефолт) плюс списки
 * поясов и дней, КОТОРЫЕ ПРИНИМАЕТ рассыльщик.
 *
 * Списки приходят с сервера намеренно: набор допустимых поясов — серверный
 * контракт (`api/client/eng/_launchWindow.ts`), и вторая копия на фронте
 * разъехалась бы с первой — клиент выбрал бы пояс, на который запуск отвечает
 * отказом. Ответ без списков (демо-вкладка отдаёт `{}` на неизвестный путь) →
 * config остаётся null: редактор не рисуем, запуск уедет с серверным дефолтом.
 */
function useSendingWindow(templateId: string | undefined) {
  const [config, setConfig] = useState<SendingWindowConfig | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // Кампании запуска сейчас не все на окне `schedule` (ответ GET, `mixed`).
  const [mixed, setMixed] = useState(false);

  useEffect(() => {
    if (!templateId) return;
    let cancelled = false;
    // setState — внутри асинхронной функции, а не в теле эффекта: синхронный
    // вызов в теле эффекта запрещён правилом react-hooks (каскадный рендер).
    void (async () => {
      setLoading(true);
      try {
        const res = await fetchEngSendingWindow(templateId);
        if (cancelled) return;
        const initial = res.schedule ?? res.default;
        setMixed(res.mixed === true);
        const timezones = engTimezoneOptionsOf(res);
        if (initial && timezones.length > 0 && res.weekdays && res.weekdays.length > 0) {
          setConfig({
            value: { ...initial, days: [...initial.days] },
            timezones,
            weekdays: res.weekdays,
          });
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load the sending hours');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [templateId]);

  const setValue = useCallback((next: EngSendingWindow) => {
    setConfig((prev) => (prev ? { ...prev, value: next } : prev));
  }, []);

  return { config, setValue, loading, error, mixed };
}

/** «09:00» → «9:00»: в строке-сводке без ведущего нуля. */
function shortHour(hhmm: string): string {
  return hhmm.replace(/^0(\d)/, '$1');
}

/**
 * Одна строка «когда уходят письма» — её же показываем и без редактора:
 * «Mon–Fri, 9:00–17:00 · Eastern time — New York, Toronto». Дни подряд (в
 * порядке списка сервера, Mon … Sun) — диапазоном, иначе через запятую. Пояс —
 * подписью списка целиком: у «Pacific» в ней оговорка про зиму, и короткая
 * подпись её бы спрятала.
 */
export function sendingWindowSummary(config: SendingWindowConfig): string {
  const tz =
    config.timezones.find((o) => o.value === config.value.timezone)?.label ??
    engTimezoneFallbackLabel(config.value.timezone);
  const order = config.weekdays.map((d) => d.value);
  const picked = config.weekdays.filter((d) => config.value.days.includes(d.value));
  if (picked.length === 0) return `No weekdays selected — nothing would be sent · ${tz}`;
  const first = order.indexOf(picked[0].value);
  const contiguous = picked.every((d, i) => order.indexOf(d.value) === first + i);
  const days =
    contiguous && picked.length >= 3
      ? `${picked[0].label}–${picked[picked.length - 1].label}`
      : picked.map((d) => d.label).join(', ');
  return `${days}, ${shortHour(config.value.from)}–${shortHour(config.value.to)} · ${tz}`;
}

export function SendingWindowEditor({
  config,
  onChange,
  disabled,
  hint,
}: {
  config: SendingWindowConfig;
  onChange: (next: EngSendingWindow) => void;
  disabled?: boolean;
  /** Подсказка под выпадашкой поясов (шаг 3: страны проекта в разных поясах). */
  hint?: string;
}) {
  const { value, timezones, weekdays } = config;
  // Сохранённое значение может не совпасть со списком (окно выставили не из
  // кабинета: получас вместо целого часа, пояс шире нашей выборки). Тогда
  // дописываем его пунктом — иначе select нарисует первый вариант, а в
  // состоянии останется другой, и клиент увидел бы не то, что стоит у
  // рассыльщика. Дописанный пункт — без группы, отдельно от <optgroup>.
  const hourOptions = HOUR_OPTIONS.includes(value.from) && HOUR_OPTIONS.includes(value.to)
    ? HOUR_OPTIONS
    : [...new Set([...HOUR_OPTIONS, value.from, value.to])].sort();
  const timezoneOptions = timezones.some((o) => o.value === value.timezone)
    ? timezones
    : [...timezones, { value: value.timezone, label: engTimezoneFallbackLabel(value.timezone) }];
  const toggleDay = (day: number) => {
    const next = value.days.includes(day)
      ? value.days.filter((d) => d !== day)
      : [...value.days, day].sort((a, b) => a - b);
    onChange({ ...value, days: next });
  };

  return (
    <div className="mt-3 rounded-md p-3" style={{ border: '1px solid var(--cp-divider)' }}>
      <div className="flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: 'var(--cp-paper)' }}>
        <Clock className="h-3 w-3" /> Sending hours
      </div>
      <p className="mt-1 text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
        Emails go out only inside these hours, in this timezone, on these days.
      </p>
      {/* Пояс — на всю строку: подписи полного списка длинные («Amsterdam,
          Berlin, … (UTC+1, UTC+2 in summer)»), в трети строки они резались. */}
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <label className="text-[10px] sm:col-span-3" style={{ color: 'var(--cp-text-l)' }}>
          Timezone
          <select
            value={value.timezone}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, timezone: e.target.value })}
            className="ds-input mt-1 w-full text-xs"
          >
            {groupTimezoneOptions(timezoneOptions).flatMap((segment) =>
              segment.group === null
                ? segment.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))
                : [
                    <optgroup key={`${segment.group}:${segment.options[0].value}`} label={segment.group}>
                      {segment.options.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </optgroup>,
                  ],
            )}
          </select>
          {hint && (
            <span className="mt-1 block text-[11px]" style={{ color: 'var(--cp-amber)' }}>
              {hint}
            </span>
          )}
        </label>
        <label className="text-[10px]" style={{ color: 'var(--cp-text-l)' }}>
          Start
          <select
            value={value.from}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, from: e.target.value })}
            className="ds-input ds-mono mt-1 w-full text-xs"
          >
            {hourOptions.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
        </label>
        <label className="text-[10px]" style={{ color: 'var(--cp-text-l)' }}>
          End
          <select
            value={value.to}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, to: e.target.value })}
            className="ds-input ds-mono mt-1 w-full text-xs"
          >
            {hourOptions.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {weekdays.map((d) => {
          const checked = value.days.includes(d.value);
          return (
            <button
              key={d.value}
              type="button"
              disabled={disabled}
              onClick={() => toggleDay(d.value)}
              aria-pressed={checked}
              className={`ds-nav-item px-2.5 py-1 text-[11px] ${checked ? 'active' : ''}`}
            >
              {d.label}
            </button>
          );
        })}
      </div>
      {value.from >= value.to && (
        <div className="mt-2 text-[11px]" style={{ color: 'var(--cp-red)' }}>
          The end time must be later than the start time.
        </div>
      )}
      {value.days.length === 0 && (
        <div className="mt-2 text-[11px]" style={{ color: 'var(--cp-red)' }}>
          Pick at least one weekday — otherwise nothing is sent.
        </div>
      )}
    </div>
  );
}

/** Окно выбрано корректно — кнопку запуска/сохранения можно не блокировать. */
export function isSendingWindowUsable(config: SendingWindowConfig | null): boolean {
  if (!config) return true; // редактора нет — сервер применит свой дефолт
  return config.value.days.length > 0 && config.value.from < config.value.to;
}

/**
 * Правка окна у УЖЕ запущенного шаблона. Грузим по кнопке (как превью базы):
 * запущенных вертикалей в проекте бывает много, а окно смотрят по надобности.
 */
export function LaunchedSendingWindow({ templateId }: { templateId: string }) {
  const [open, setOpen] = useState(false);
  const { config, setValue, loading, error, mixed } = useSendingWindow(open ? templateId : undefined);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState('');
  const [saveError, setSaveError] = useState('');
  const [warnings, setWarnings] = useState<string[]>([]);
  // После сохранения «разные окна» знает ответ PATCH (сколько кампаний из
  // скольких приняли окно), а не загрузка формы. null — сохранения не было.
  const [mixedAfterSave, setMixedAfterSave] = useState<boolean | null>(null);
  const showMixed = mixedAfterSave ?? mixed;

  const onSave = async () => {
    if (!config || saving || !isSendingWindowUsable(config)) return;
    setSaving(true);
    setSaved('');
    setSaveError('');
    setWarnings([]);
    try {
      const res = await updateEngSendingWindow(templateId, config.value);
      if (res.error) {
        setSaveError(res.error);
      } else {
        const updated = res.campaigns_updated;
        const total = res.campaigns_total;
        const partial = typeof updated === 'number' && typeof total === 'number' && updated < total;
        // Часть кампаний окно не приняла — «Saved» было бы неправдой: кабинет
        // выбор в этом случае не сохраняет, а часть кампаний на прежних часах.
        setSaved(
          partial
            ? `Applied to ${updated} of ${total} campaigns`
            : updated && updated > 1
              ? `Saved — applied to ${updated} campaigns`
              : 'Saved',
        );
        setMixedAfterSave(typeof updated === 'number' && typeof total === 'number' ? partial : null);
        setWarnings(res.warnings ?? []);
      }
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : 'Failed to update the sending hours');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => {
          // Повторное открытие перечитывает окно с сервера — прежний ответ
          // сохранения про «разные окна» к нему уже не относится.
          setMixedAfterSave(null);
          setOpen((v) => !v);
        }}
        className="ds-btn-secondary inline-flex items-center gap-1.5 text-[11px]"
      >
        {loading ? <EngSpinner className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
        {open ? 'Hide sending hours' : 'Sending hours'}
      </button>
      {open && error && (
        <div className="mt-2 text-[11px]" style={{ color: 'var(--cp-red)' }}>
          {error}
        </div>
      )}
      {open && config && (
        <>
          {/* Сводка «когда уходят письма» — только когда окно одно у всех
              кампаний запуска. Иначе (окно встало у части, часть не
              прочиталась) она выдала бы окно одной кампании за окно всех. */}
          {showMixed ? (
            <div className="mt-2 text-[11px]" style={{ color: 'var(--cp-amber)' }}>
              The campaigns of this launch may not all use the hours shown below right now — save the hours
              here to apply them to every one of them.
            </div>
          ) : (
            <div className="mt-2 text-[11px] ds-mono" style={{ color: 'var(--cp-text-m)' }}>
              {sendingWindowSummary(config)}
            </div>
          )}
          <SendingWindowEditor config={config} onChange={setValue} disabled={saving} />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void onSave()}
              disabled={saving || !isSendingWindowUsable(config)}
              className="ds-btn-primary inline-flex items-center gap-1.5 text-[11px]"
            >
              {saving && <EngSpinner className="h-3 w-3" />}
              Save sending hours
            </button>
            {saved && (
              <span className="text-[11px]" style={{ color: 'var(--cp-green)' }}>
                {saved}
              </span>
            )}
          </div>
          {saveError && (
            <div className="mt-1 text-[11px]" style={{ color: 'var(--cp-red)' }}>
              {saveError}
            </div>
          )}
          {warnings.map((w, i) => (
            <div key={i} className="mt-1 text-[11px]" style={{ color: 'var(--cp-amber)' }}>
              {w}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

/* ── Итоговые письма шаблона (то, что уходит в кампанию) ── */

/**
 * Что сейчас значат письма шаблона рынка — одна фраза над ними. Состояние
 * считает карточка рынка шага 3 (EngStepLaunch) по тем же предикатам, что и
 * запуск:
 *  - `launched` — запуск записан и закончен: кампании созданы с этими
 *    письмами (письма шаблона после запуска не меняются — правки итоговых
 *    писем в кабинете нет);
 *  - `unfinished` — запуск записан, но часть аудитории не уехала: достройка
 *    (автозапуск или «Launch now») берёт письма того же шаблона;
 *  - `next_launch` — запуска нет, письма проходят проверку: кампании рынка
 *    создаст с ними и автозапуск, и «Launch now»;
 *  - `rewrite_none` / `rewrite_unfinished` — письма запуск откажет
 *    (`needs_rewrite`), причину пишет фраза engTemplateNeedsRewriteText прямо
 *    над письмами.
 */
export type FinalLettersState = 'launched' | 'unfinished' | 'next_launch' | 'rewrite_none' | 'rewrite_unfinished';

const FINAL_LETTERS_STATE_TEXT: Record<FinalLettersState, string> = {
  launched: 'The campaigns of this market were created with these letters.',
  unfinished:
    'The campaigns of this market already use these letters; finishing its launch adds the rest of its audience with the same letters.',
  next_launch: 'When sending for this market starts, its campaigns are created with these letters.',
  rewrite_none: 'These letters cannot be sent as they are — see the note above.',
  rewrite_unfinished:
    'The campaigns already created use these letters, but they cannot finish the launch as they are — see the note above.',
};

/** «waits N days after letter M» — пауза письма так, как её получает кампания. */
function waitText(days: number, previousLetter: number): string {
  return `waits ${days} day${days === 1 ? '' : 's'} after letter ${previousLetter}`;
}

/**
 * Письма шаблона ТАК, КАК ИХ ОТДАЁТ ЗАПУСК: последовательность собирает та же
 * buildLaunchSequence (launchHandoff.ts), что и запуск, — тема только у
 * письма 1 и его вариантов (у писем 2+ запуск тему обнуляет, и они идут в той
 * же ветке), варианты B — те же и в том же числе, пауза — wait_days письма
 * (у кампании это задержка перед ним). Сегментные варианты запуск ставит на
 * место основного текста (версии A) в кампании сегмента — здесь они показаны
 * под письмом именно так. Подстановки и их замены — из проекции
 * (`placeholders`), без маппинга: null — сервер их не посчитал, тогда о
 * подстановках экран ничего не утверждает.
 */
export function FinalLetters({ template, state }: { template: HeTemplate; state: FinalLettersState }) {
  const letters = Array.isArray(template.letters) ? template.letters : [];
  const sequence = buildLaunchSequence(letters);
  const placeholders = engTemplatePlaceholders(template);
  return (
    <div className="mt-3 rounded-md p-3" style={{ border: '1px solid var(--cp-divider)' }}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold" style={{ color: 'var(--cp-paper)' }}>
          Final letters
        </span>
        <span className="text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
          read-only
        </span>
      </div>
      <p className="mt-1 mb-0 text-[11px]" style={{ color: 'var(--cp-text-m)' }}>
        {FINAL_LETTERS_STATE_TEXT[state]}
      </p>
      {!sequence ? (
        <p className="mt-2 mb-0 text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
          This template has no letters.
        </p>
      ) : (
        <div className="mt-2 flex flex-col gap-2">
          {sequence.steps.map((step, i) => {
            // jsonb шаблона формы не гарантирует: тема и тело — строкой.
            const versions = [
              { subject: String(step.subject ?? ''), body: String(step.body ?? '') },
              ...(step.variants ?? []).map((v) => ({ subject: String(v.subject ?? ''), body: String(v.body ?? '') })),
            ];
            const segments = (Array.isArray(letters[i]?.segment_variants) ? letters[i].segment_variants! : []).filter(
              (v) => typeof v?.when === 'string' && v.when.trim() !== '' && typeof v.text === 'string',
            );
            return (
              <div key={i} className="rounded-md p-3" style={{ border: '1px solid var(--cp-divider)' }}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="ds-mono text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
                    Letter {i + 1}
                  </span>
                  {i > 0 && (
                    <span className="ml-auto text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
                      {waitText(step.wait_days, i)}
                    </span>
                  )}
                </div>
                {i > 0 && (
                  <div className="mt-1 text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
                    Same thread as letter 1 — no subject line of its own.
                  </div>
                )}
                {versions.length > 1 && (
                  <div className="mt-1 text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
                    Each recipient gets one of these {versions.length} versions.
                  </div>
                )}
                {versions.map((v, k) => (
                  <div key={k} className="mt-2">
                    {versions.length > 1 && (
                      <div className="ds-mono text-[10px]" style={{ color: 'var(--cp-text-l)' }}>
                        Version {String.fromCharCode(65 + k)}
                      </div>
                    )}
                    {i === 0 && (
                      <div className="text-xs font-semibold" style={{ color: 'var(--cp-paper)' }}>
                        Subject: {v.subject.trim() ? v.subject : '(empty)'}
                      </div>
                    )}
                    <div className="mt-1 whitespace-pre-wrap text-xs" style={{ color: 'var(--cp-paper)' }}>
                      {v.body}
                    </div>
                  </div>
                ))}
                {segments.map((seg, k) => (
                  <div key={`s${k}`} className="mt-2 rounded-md p-2" style={{ border: '1px dashed var(--cp-divider)' }}>
                    <div className="text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
                      Companies sorted into «{seg.when.trim()}» get this text in place of{' '}
                      {versions.length > 1 ? 'version A' : 'the text above'}:
                    </div>
                    <div className="mt-1 whitespace-pre-wrap text-xs" style={{ color: 'var(--cp-paper)' }}>
                      {seg.text}
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      )}
      {placeholders && placeholders.length > 0 && (
        <div className="mt-2">
          <div className="text-[11px] font-semibold" style={{ color: 'var(--cp-paper)' }}>
            Placeholders
          </div>
          <p className="mt-1 mb-0 text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
            Words in double curly braces are placeholders:
          </p>
          <ul className="mt-1 mb-0 flex flex-col gap-0.5 pl-4 text-[11px]" style={{ color: 'var(--cp-text-m)' }}>
            {placeholders.map((p) => (
              <li key={p.name}>{engPlaceholderText(p)}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
