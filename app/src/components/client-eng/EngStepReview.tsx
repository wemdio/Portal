'use client';

/**
 * Шаг 5 «Review & Launch»: единое окно приёмки автопилота. По каждой вертикали
 * с готовой цепочкой/базой — письма цепочки (просмотр + инлайн-правка через
 * ChainEditor шага Letters, PATCH /eng/chains/[id]), ленивое превью базы
 * (GET /eng/bases/[id]/rows, первые 100 строк, компактные колонки) и статус
 * шаблона. Вверху — общий селектор пресета, ОКНО ОТПРАВКИ (пояс/часы/дни,
 * уезжает вместе с запуском) и «Launch all (paused)»: последовательный запуск
 * ready-шаблонов, которым есть что запускать, по одному на базу
 * (launchableTemplates), со счётчиком запущенных N/M; ошибка одного шаблона
 * показывается и не останавливает остальные — кроме отказов «идёт повторное
 * исследование», «в пресете нет ящиков» и «классификатор сегментов не
 * ответил», которые получил бы следующий шаблон.
 * Итог прогона (ошибки и предупреждения запуска) остаётся на экране и тогда,
 * когда запускать больше нечего: панель не снимается после первого прогона.
 * Шаблон, чьи письма запуск откажет (`needs_rewrite` проекции), в прогон не
 * берётся, а его карточка говорит, что письма надо переписать.
 *
 * «Есть что запускать» — это шаблон без записи о запуске ИЛИ шаблон, чей запуск
 * НЕ ЗАКОНЧЕН (launch_info.pending: часть аудитории осталась без кампании, без
 * адресов или — у отложенных классификатором сегментов — без сегмента). Второй
 * случай — ДОСТРОЙКА: то же нажатие достраивает недоехавшее
 * и не создаёт вторых кампаний по уже уехавшей аудитории (правило и его цена —
 * `lib/hypothesisEngine/launchTemplate.ts`, шаг 6; предикат один на сервер и на
 * экран — heLaunchIsIncomplete). Отдельной кнопки «дозапустить» нет намеренно:
 * второй способ запустить шаблон — это второй способ ошибиться.
 *
 * У запущенного шаблона окно отправки можно поменять — PATCH
 * /eng/templates/[id]/schedule переставляет его во всех кампаниях этого запуска.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { Clock, Eye, Rocket } from 'lucide-react';
import type { HeTemplate, HeVertical } from '@/lib/hypothesisEngine/types';
import { heLaunchIsIncomplete, parseLaunchInfo } from '@/lib/hypothesisEngine/launchHandoff';
import {
  engTemplateNeedsRewrite,
  fetchEngBaseRows,
  fetchEngLaunchPresets,
  fetchEngSendingWindow,
  launchEngTemplate,
  updateEngSendingWindow,
  type EngBaseSummary,
  type EngSendingWindow,
  type EngSendingWindowTimezoneOption,
  type EngSendingWindowWeekdayOption,
  type HeChainDto,
  type HeLaunchPresetOption,
  type HeJobSummary,
} from './api-client';
import { EngBadge, EngCard, EngSpinner, baseStatusTone } from './ui';
import { engLaunchRunStoppedText, engTemplateNeedsRewriteText } from './engText';
import { ChainEditor } from './EngStepLetters';
import type { EngDetail } from './EngProjectWizard';

/** Компактные колонки превью; остальные поля строки — в title строки таблицы. */
const PREVIEW_COLUMNS = ['company', 'website', 'email'] as const;
const PREVIEW_LIMIT = 100;

/* ── Ленивое превью базы (по кнопке) ── */

function BasePreview({ base }: { base: EngBaseSummary }) {
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
        {open ? 'Hide preview' : 'Preview base'}
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
                    No rows in the base yet.
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

interface SendingWindowConfig {
  value: EngSendingWindow;
  timezones: EngSendingWindowTimezoneOption[];
  weekdays: EngSendingWindowWeekdayOption[];
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
        if (initial && res.timezones && res.timezones.length > 0 && res.weekdays && res.weekdays.length > 0) {
          setConfig({
            value: { ...initial, days: [...initial.days] },
            timezones: res.timezones,
            weekdays: res.weekdays,
          });
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load the sending window');
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

/** Одна строка «когда уходят письма» — её же показываем и без редактора. */
function sendingWindowSummary(config: SendingWindowConfig): string {
  const tz =
    config.timezones.find((o) => o.value === config.value.timezone)?.label ?? config.value.timezone;
  const days = config.weekdays
    .filter((d) => config.value.days.includes(d.value))
    .map((d) => d.label)
    .join(', ');
  if (!days) return `No weekdays selected — nothing would be sent · ${tz}`;
  return `${days} · ${config.value.from}–${config.value.to} · ${tz}`;
}

function SendingWindowEditor({
  config,
  onChange,
  disabled,
}: {
  config: SendingWindowConfig;
  onChange: (next: EngSendingWindow) => void;
  disabled?: boolean;
}) {
  const { value, timezones, weekdays } = config;
  // Сохранённое значение может не совпасть со списком (окно выставили не из
  // кабинета: получас вместо целого часа, пояс шире нашей выборки). Тогда
  // дописываем его пунктом — иначе select нарисует первый вариант, а в
  // состоянии останется другой, и клиент увидел бы не то, что стоит у
  // рассыльщика.
  const hourOptions = HOUR_OPTIONS.includes(value.from) && HOUR_OPTIONS.includes(value.to)
    ? HOUR_OPTIONS
    : [...new Set([...HOUR_OPTIONS, value.from, value.to])].sort();
  const timezoneOptions = timezones.some((o) => o.value === value.timezone)
    ? timezones
    : [...timezones, { value: value.timezone, label: value.timezone }];
  const toggleDay = (day: number) => {
    const next = value.days.includes(day)
      ? value.days.filter((d) => d !== day)
      : [...value.days, day].sort((a, b) => a - b);
    onChange({ ...value, days: next });
  };

  return (
    <div className="mt-3 rounded-md p-3" style={{ border: '1px solid var(--cp-divider)' }}>
      <div className="flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: 'var(--cp-paper)' }}>
        <Clock className="h-3 w-3" /> Sending window
      </div>
      <p className="mt-1 text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
        Emails go out only inside these hours, in this timezone, on these days.
      </p>
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <label className="text-[10px]" style={{ color: 'var(--cp-text-l)' }}>
          Timezone
          <select
            value={value.timezone}
            disabled={disabled}
            onChange={(e) => onChange({ ...value, timezone: e.target.value })}
            className="ds-input mt-1 w-full text-xs"
          >
            {timezoneOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
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
function isSendingWindowUsable(config: SendingWindowConfig | null): boolean {
  if (!config) return true; // редактора нет — сервер применит свой дефолт
  return config.value.days.length > 0 && config.value.from < config.value.to;
}

/**
 * Правка окна у УЖЕ запущенного шаблона. Грузим по кнопке (как превью базы):
 * запущенных вертикалей в проекте бывает много, а окно смотрят по надобности.
 */
function LaunchedSendingWindow({ templateId }: { templateId: string }) {
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
      setSaveError(e instanceof Error ? e.message : 'Failed to update the sending window');
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
        {open ? 'Hide sending window' : 'Sending window'}
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
              The campaigns of this launch may not all use the window shown below right now — save a window
              here to apply it to every one of them.
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
              Save sending window
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

/* ── Карточка вертикали ── */

function VerticalReviewCard({
  vertical,
  chain,
  base,
  template,
  templateBusy,
  onChanged,
}: {
  vertical: HeVertical;
  chain: HeChainDto | undefined;
  base: EngBaseSummary | undefined;
  template: HeTemplate | undefined;
  templateBusy: boolean;
  onChanged: () => void;
}) {
  const launch = template ? parseLaunchInfo((template as { launch_info?: unknown }).launch_info) : null;
  // Частичный запуск нельзя подписывать «launched»: часть аудитории не уехала, и
  // клиенту надо нажать запуск ещё раз (панель выше снова его предлагает).
  const launchUnfinished = launch !== null && heLaunchIsIncomplete(launch);
  // Письма запуск откажет (`needs_rewrite`), а запускать есть что: запуска не
  // было или он не закончен. У законченного запуска шаг 5 ничего не запускает.
  const rewriteBlocksLaunch =
    template !== undefined && engTemplateNeedsRewrite(template) && (launch === null || launchUnfinished);
  return (
    <EngCard>
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-bold m-0" style={{ color: 'var(--cp-paper)' }}>
          {vertical.name}
        </h4>
        {template && (
          <EngBadge
            label={rewriteBlocksLaunch ? 'template: letters need rewriting' : `template: ${template.status}`}
            tone={template.status === 'ready' && !rewriteBlocksLaunch ? 'green' : 'amber'}
          />
        )}
        {launch && (
          <EngBadge
            label={launchUnfinished ? 'launch unfinished' : 'launched (paused)'}
            tone={launchUnfinished ? 'amber' : 'green'}
          />
        )}
        {!template && templateBusy && (
          <span className="inline-flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--cp-amber)' }}>
            <EngSpinner className="h-3 w-3" /> building template…
          </span>
        )}
        {!template && !templateBusy && (
          <span className="text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
            no template yet
          </span>
        )}
      </div>

      {/* Разобранная база БЕЗ шаблона и без идущей джобы — это провалившаяся
          генерация писем: строки `he_templates` при провале не появляется,
          база так и остаётся 'analyzed'. Раньше шаг 5 писал про такую
          вертикаль ровно «no template yet» — подпись, неотличимая от «ещё не
          дошли руки», и без единого следующего шага. Кнопки «построить
          шаблон» здесь нет намеренно: генерация писем — платная стадия, и
          кабинет её клиенту не предлагает. */}
      {!template && !templateBusy && base?.status === 'analyzed' && (
        <p className="mt-2 text-[11px]" style={{ color: 'var(--cp-amber)' }}>
          The base for this vertical is ready, but its template has not been built yet. Nothing
          collected is lost — our team can see it. Contact your manager if this vertical stays this
          way.
        </p>
      )}

      {/* Письма с подстановкой, которую аудитория не наполнит: «Launch all»
          этот шаблон не берёт (launchableTemplates), и без этой фразы карточка
          молча выпадала бы из запуска. */}
      {rewriteBlocksLaunch && (
        <p className="mt-2 text-[11px]" style={{ color: 'var(--cp-amber)' }}>
          {engTemplateNeedsRewriteText(launch === null ? 'none' : 'unfinished')}
        </p>
      )}

      {/* Запущенный шаблон: окно отправки клиент может поменять и после
          запуска — правка едет в те самые кампании, которые он создал. */}
      {launch && template && <LaunchedSendingWindow templateId={template.id} />}

      {chain ? (
        <ChainEditor chain={chain} onSaved={onChanged} />
      ) : (
        <p className="mt-2 text-xs" style={{ color: 'var(--cp-text-l)' }}>
          No ready letters for this vertical yet.
        </p>
      )}

      {base && (
        <div
          className="mt-3 rounded-md p-3"
          style={{ border: '1px solid var(--cp-divider)' }}
        >
          <div className="flex items-center gap-2">
            <span className="truncate text-xs font-semibold" style={{ color: 'var(--cp-paper)' }}>
              {base.filename}
            </span>
            <EngBadge label={base.status} tone={baseStatusTone(base.status)} />
            <span className="ml-auto ds-mono text-[11px]" style={{ color: 'var(--cp-text-m)' }}>
              {base.row_count.toLocaleString('en-US')} rows
            </span>
          </div>
          {(base.status === 'analyzed' || base.status === 'analyzing') && <BasePreview base={base} />}
        </div>
      )}
    </EngCard>
  );
}

/* ── Панель запуска всех готовых шаблонов ── */

function LaunchAllPanel({
  launchable,
  onChanged,
  onRunStart,
}: {
  launchable: HeTemplate[];
  onChanged: () => void;
  /**
   * Прогон начался — родитель держит панель на экране и после того, как
   * запускать станет нечего (см. EngStepReview): иначе перезагрузка деталки
   * в конце прогона (onChanged) снимала панель вместе с её ошибками и
   * предупреждениями, и клиент их не видел вовсе.
   */
  onRunStart: () => void;
}) {
  const [presets, setPresets] = useState<HeLaunchPresetOption[] | null>(null);
  const [presetId, setPresetId] = useState('');
  const [presetsError, setPresetsError] = useState('');
  const [state, setState] = useState<{
    running: boolean;
    /**
     * Сколько шаблонов ЗАПУЩЕНО (ответ 200), а не сколько обработано: строка
     * «Launched N/M» печатает это число, и отказ в нём считаться не может.
     */
    launched: number;
    total: number;
    errors: string[];
    /**
     * Предупреждения запуска (кампания создана, но что-то требует внимания) и
     * пропуск шаблона, у соседа которого запуск уже есть (кампания не создана,
     * и это не сбой — см. onLaunchAll).
     */
    notes: string[];
  }>({
    running: false,
    launched: 0,
    total: 0,
    errors: [],
    notes: [],
  });

  // Пресеты — per-client (GET launch их не привязывает к шаблону), грузим по
  // первому ready-шаблону. Зависим от стабильного id, а не от массива.
  const firstTemplateId = launchable[0]?.id;
  // Сколько из них — ДОСТРОЙКА незакончённого запуска: «Launch» для них значит
  // «закончить», а не «начать заново», и сказать это надо до нажатия.
  const unfinished = launchable.filter((t) => {
    const launch = parseLaunchInfo((t as { launch_info?: unknown }).launch_info);
    return launch !== null && heLaunchIsIncomplete(launch);
  }).length;
  // Окно отправки — тоже одно на пачку: «Launch all» запускает все готовые
  // шаблоны одним пресетом, и часы отправки у них общие. Поменять окно
  // отдельной кампании можно после запуска, в её карточке.
  const { config: windowConfig, setValue: setWindowValue, error: windowError } =
    useSendingWindow(firstTemplateId);
  useEffect(() => {
    if (!firstTemplateId) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await fetchEngLaunchPresets(firstTemplateId);
        if (cancelled) return;
        setPresets(list);
        setPresetId((prev) => prev || (list[0]?.id ?? ''));
      } catch (e) {
        if (!cancelled) setPresetsError(e instanceof Error ? e.message : 'Failed to load presets');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [firstTemplateId]);

  /**
   * Отказы защиты аудитории (`res.refusal`, launchTemplate.ts, шаг 4b′) читаются
   * по коду, и у каждого своё место:
   *  - sibling_template_launched — у другого шаблона той же базы запуск уже есть.
   *    Список launchable по базе уже свёрнут (launchableTemplates), поэтому сюда
   *    это доходит, только если соседа запустили мимо этого экрана (второй таб,
   *    менеджер) или его попытка идёт прямо сейчас (аренда без кампании
   *    кабинету не видна). Это не сбой: кампания не создана ровно затем, чтобы
   *    те же люди не получили вторую цепочку, — поэтому заметкой, а не ошибкой;
   *  - research_running — у проекта идёт повторное исследование. Тот же отказ
   *    получит КАЖДЫЙ следующий шаблон, поэтому цикл останавливается: одна
   *    строка вместо N одинаковых и ни одного лишнего запроса;
   *  - preset_no_mailboxes — в выбранном пресете нет ящиков отправки. Пресет
   *    один на всю пачку, поэтому и здесь цикл останавливается;
   *  - segment_classification_incomplete (503) — классификатор сегментов не
   *    ответил по слишком большой доле адресов. Он общий у всех шаблонов, и
   *    следующий шаблон с сегментами оплатил бы классификацию всей своей
   *    аудитории ради того же отказа, — цикл останавливается, а строка отказа
   *    говорит, сколько шаблонов прогон не попробовал (иначе «Launched 1/4»
   *    не отличить от трёх отказов).
   */
  const onLaunchAll = async () => {
    if (state.running || !presetId || launchable.length === 0) return;
    if (!isSendingWindowUsable(windowConfig)) return;
    const errors: string[] = [];
    const notes: string[] = [];
    let launched = 0;
    onRunStart();
    setState({ running: true, launched: 0, total: launchable.length, errors: [], notes: [] });
    // Последовательно: параллельный запуск уронил бы лимиты Instantly и
    // перемешал бы launch_info опросов.
    for (let i = 0; i < launchable.length; i++) {
      const tpl = launchable[i];
      let stop = false;
      try {
        const res = await launchEngTemplate(tpl.id, {
          preset_id: presetId,
          // Окна нет (списки не загрузились) — не шлём поле вовсе: сервер
          // подставит английский дефолт, а не часы пресета администратора.
          ...(windowConfig ? { schedule: windowConfig.value } : {}),
        });
        if (res.refusal === 'sibling_template_launched') {
          notes.push(res.error ?? `Template ${i + 1}: not launched`);
        } else if (res.refusal === 'research_running' || res.refusal === 'preset_no_mailboxes') {
          errors.push(res.error ?? `Template ${i + 1}: launch failed`);
          stop = true;
        } else if (res.refusal === 'segment_classification_incomplete') {
          const notTried = launchable.length - i - 1;
          const refused = res.error ?? `Template ${i + 1}: launch failed`;
          errors.push(notTried > 0 ? `${refused} ${engLaunchRunStoppedText(notTried)}` : refused);
          stop = true;
        } else if (!res.ok) {
          errors.push(res.error ?? `Template ${i + 1}: launch failed`);
        } else {
          launched += 1;
        }
        // Предупреждения запуска (в т.ч. «окно отправки не доехало») — не
        // ошибки: кампании созданы. Поэтому отдельным списком и другим цветом.
        for (const warning of res.warnings ?? []) notes.push(warning);
      } catch (e) {
        errors.push(e instanceof Error ? e.message : `Template ${i + 1}: launch failed`);
      }
      setState({
        running: true,
        launched,
        total: launchable.length,
        errors: [...errors],
        notes: [...notes],
      });
      if (stop) break;
    }
    setState({ running: false, launched, total: launchable.length, errors, notes });
    onChanged();
  };

  // Итог прогона, когда запускать больше нечего: только результат — ошибки и
  // предупреждения (отложенные адреса, окно, сегменты) остаются на экране.
  if (launchable.length === 0) {
    return (
      <EngCard>
        <div className="text-[11px]" style={{ color: 'var(--cp-text-m)' }}>
          {state.running ? 'Launching…' : 'Nothing else on this step is ready to launch right now.'}
        </div>
        {state.total > 0 && (
          <div className="mt-2 text-[11px] ds-mono" style={{ color: 'var(--cp-text-m)' }}>
            Launched {state.launched}/{state.total}
          </div>
        )}
        {state.errors.map((err, i) => (
          <div key={i} className="mt-1 text-[11px]" style={{ color: 'var(--cp-red)' }}>
            {err}
          </div>
        ))}
        {state.notes.map((note, i) => (
          <div key={i} className="mt-1 text-[11px]" style={{ color: 'var(--cp-amber)' }}>
            {note}
          </div>
        ))}
      </EngCard>
    );
  }

  return (
    <EngCard>
      <div className="flex flex-wrap items-center gap-2">
        {presets === null && !presetsError ? (
          <span className="text-[11px] inline-flex items-center gap-1.5" style={{ color: 'var(--cp-text-m)' }}>
            <EngSpinner className="h-3 w-3" /> Loading presets…
          </span>
        ) : presets && presets.length === 0 ? (
          <span className="text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
            No sending preset configured yet — ask your manager to set one up.
          </span>
        ) : (
          <>
            <select
              value={presetId}
              onChange={(e) => setPresetId(e.target.value)}
              className="ds-input text-xs"
              aria-label="Sending preset"
            >
              {(presets ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void onLaunchAll()}
              disabled={state.running || !presetId || !isSendingWindowUsable(windowConfig)}
              className="ds-btn-primary inline-flex items-center gap-1.5 text-xs"
            >
              {state.running ? <EngSpinner className="h-3 w-3" /> : <Rocket className="h-3 w-3" />}
              Launch all (paused)
            </button>
            <span className="text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
              {launchable.length} template{launchable.length === 1 ? '' : 's'} ready — campaigns stay paused for review
            </span>
          </>
        )}
      </div>
      {/* Достройка: клиент обязан знать, что повтор ЗАКАНЧИВАЕТ прошлый запуск,
          а не начинает второй по той же аудитории. Отдельной кнопки для этого
          нет — это тот же «Launch all (paused)». */}
      {unfinished > 0 && (
        <div className="mt-2 text-[11px]" style={{ color: 'var(--cp-amber)' }}>
          {unfinished === 1
            ? '1 of them has an unfinished launch: part of its audience never went out.'
            : `${unfinished} of them have an unfinished launch: part of their audience never went out.`}{' '}
          Launching again finishes it — the campaigns already created are reused, only the addresses that
          have not gone out are added, and nobody is contacted twice.
        </div>
      )}
      {/* Окно отправки выбирается ДО запуска и уезжает вместе с ним. Списки
          пришли с сервера — значит редактор рисуем; не пришли (или блип сети) —
          говорим, что уедет дефолт, и запуск не блокируем. */}
      {windowConfig ? (
        <>
          <SendingWindowEditor
            config={windowConfig}
            onChange={setWindowValue}
            disabled={state.running}
          />
          <div className="mt-1 text-[11px] ds-mono" style={{ color: 'var(--cp-text-l)' }}>
            {sendingWindowSummary(windowConfig)} — you can change this after the launch
          </div>
        </>
      ) : (
        <div className="mt-2 text-[11px]" style={{ color: 'var(--cp-text-l)' }}>
          {windowError
            ? `${windowError} The default sending window will be used; you can change it after the launch.`
            : 'Loading the sending window…'}
        </div>
      )}
      {state.total > 0 && (
        <div className="mt-2 text-[11px] ds-mono" style={{ color: 'var(--cp-text-m)' }}>
          Launched {state.launched}/{state.total}
        </div>
      )}
      {state.errors.map((err, i) => (
        <div key={i} className="mt-1 text-[11px]" style={{ color: 'var(--cp-red)' }}>
          {err}
        </div>
      ))}
      {state.notes.map((note, i) => (
        <div key={i} className="mt-1 text-[11px]" style={{ color: 'var(--cp-amber)' }}>
          {note}
        </div>
      ))}
      {presetsError && (
        <div className="mt-2 text-[11px]" style={{ color: 'var(--cp-red)' }}>
          {presetsError}
        </div>
      )}
    </EngCard>
  );
}

/**
 * Что запускает «Launch all (paused)» — ПО ОДНОМУ шаблону на базу.
 *
 * К запуску готовы ready-шаблоны без записи о запуске И те, чей запуск НЕ
 * ЗАКОНЧЕН: в записи остались части аудитории без кампании или без адресов
 * (launch_info.pending). Повтор их ДОСТРАИВАЕТ, а не дублирует — кампанию,
 * которая уже приняла адреса, ядро не трогает вовсе (launchTemplate.ts, шаг
 * 6), и force для этого не нужен. Без второй ветки частичный запуск прятал
 * кнопку ровно тогда, когда она нужна: запись у него есть, а половина
 * аудитории не уехала.
 *
 * Шаблонов у одной базы бывает несколько (пересборка, шаблоны до
 * переиспользования в стадии), а ядро запуска us-проекта откажет шаблону, у
 * СОСЕДА которого по базе запуск уже есть (409 sibling_template_launched,
 * launchTemplate.ts, шаг 4b′): вторая кампания написала бы тем же людям вторую
 * цепочку. Поэтому база решается целиком, по всем её шаблонам (статус — любой),
 * и весь набор её форм такой:
 *  - запуск записан у ДВУХ и более шаблонов — не берём ни одного: ядро
 *    откажет любому из них (сосед с запуском есть у каждого);
 *  - запуск записан у одного — берём его, если запуск не закончен и шаблон
 *    ready (достройка); закончен — запускать по базе больше нечего;
 *  - запусков нет — самый новый ready-шаблон базы (свежая пересборка);
 *    ready нет — ничего.
 * Выбранный шаблон с `needs_rewrite` (его письма ядро откажет гейтом писем,
 * шаг 4b″) не берём, и более старым ready-шаблоном той же базы его не
 * подменяем: карточка вертикали показывает самый новый шаблон, и запуск
 * старого отправил бы не те письма, что клиент видит. Почему не берём — пишет
 * карточка (VerticalReviewCard).
 * «Записан» здесь — parseLaunchInfo (кампания в записи). Аренду попытки без
 * кампании проекция кабинету не отдаёт, и такой отказ ядра экран читает по
 * коду (LaunchAllPanel.onLaunchAll). Порядок результата — порядок входа
 * (деталка отдаёт шаблоны свежими первыми).
 */
function launchableTemplates(templates: HeTemplate[]): HeTemplate[] {
  const byBase = new Map<string, HeTemplate[]>();
  for (const t of templates) {
    const list = byBase.get(t.base_id);
    if (list) list.push(t);
    else byBase.set(t.base_id, [t]);
  }
  const picked = new Set<string>();
  for (const list of byBase.values()) {
    const withLaunch = list.filter((t) => parseLaunchInfo((t as { launch_info?: unknown }).launch_info) !== null);
    if (withLaunch.length > 1) continue;
    if (withLaunch.length === 1) {
      const only = withLaunch[0];
      const launch = parseLaunchInfo((only as { launch_info?: unknown }).launch_info);
      if (only.status === 'ready' && heLaunchIsIncomplete(launch) && !engTemplateNeedsRewrite(only)) {
        picked.add(only.id);
      }
      continue;
    }
    let newest: HeTemplate | null = null;
    for (const t of list) {
      if (t.status !== 'ready') continue;
      if (!newest || Date.parse(t.created_at) > Date.parse(newest.created_at)) newest = t;
    }
    if (newest && !engTemplateNeedsRewrite(newest)) picked.add(newest.id);
  }
  return templates.filter((t) => picked.has(t.id));
}

/* ── Основной компонент шага ── */

export function EngStepReview({ detail, onChanged }: { detail: EngDetail; onChanged: () => void }) {
  const verticals = useMemo(() => (detail.verticals ?? []) as HeVertical[], [detail]);
  const chains = useMemo(() => (detail.chains ?? []) as HeChainDto[], [detail]);
  const bases = useMemo(() => (detail.bases ?? []) as EngBaseSummary[], [detail]);
  const templates = useMemo(() => (detail.templates ?? []) as HeTemplate[], [detail]);
  const jobs = useMemo(() => (detail.jobs ?? []) as HeJobSummary[], [detail]);

  // Карточка имеет смысл, только когда есть что ревьюить: готовая цепочка,
  // база или шаблон вертикали.
  // База карточки — та, по которой строится или построен запуск: база шаблона,
  // а без шаблона — самая свежая НЕ доливная. Базы приходят свежими первыми, и
  // у запущенной вертикали первой стоит ночной долив («auto-refill: …»): его
  // строки уходят прямо в идущую кампанию, к запуску он отношения не имеет, и
  // превью его строк здесь выдавало бы себя за аудиторию запуска.
  const cards = verticals
    .map((vertical) => {
      const template = templates.find((t) => t.vertical_id === vertical.id);
      const base =
        (template ? bases.find((b) => b.id === template.base_id) : undefined) ??
        bases.find((b) => b.vertical_id === vertical.id && b.refill !== true);
      return {
        vertical,
        chain: chains.find((c) => c.vertical_id === vertical.id && c.status === 'ready'),
        base,
        template,
      };
    })
    .filter((c) => c.chain || c.base || c.template);

  const launchable = launchableTemplates(templates);
  // Панель запуска остаётся на экране после первого прогона, даже если
  // запускать стало нечего: в ней итог прогона (см. LaunchAllPanel.onRunStart).
  const [launchRunStarted, setLaunchRunStarted] = useState(false);

  if (cards.length === 0) {
    return (
      <EngCard>
        <p className="text-sm" style={{ color: 'var(--cp-text-m)' }}>
          Autopilot is still working — letters, bases and templates will appear here once they are ready.
        </p>
        <Link
          href={'/client/eng/dashboard' as Route}
          prefetch={false}
          className="mt-2 inline-flex items-center gap-1.5 text-xs hover:underline"
          style={{ color: 'var(--cp-paper)' }}
        >
          See Command Center
        </Link>
      </EngCard>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {(launchable.length > 0 || launchRunStarted) && (
        <LaunchAllPanel
          launchable={launchable}
          onChanged={onChanged}
          onRunStart={() => setLaunchRunStarted(true)}
        />
      )}

      {cards.map(({ vertical, chain, base, template }) => {
        const templateBusy = jobs.some(
          (j) =>
            j.stage === 'template' &&
            (j.status === 'pending' || j.status === 'running') &&
            (j.payload as { base_id?: string } | null)?.base_id === base?.id,
        );
        return (
          <VerticalReviewCard
            key={vertical.id}
            vertical={vertical}
            chain={chain}
            base={base}
            template={template}
            templateBusy={templateBusy}
            onChanged={onChanged}
          />
        );
      })}
    </div>
  );
}
