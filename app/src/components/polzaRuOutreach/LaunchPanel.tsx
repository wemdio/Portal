'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Play } from 'lucide-react';
import {
  CHAIN_LABELS,
  CHAIN_TYPES,
  DEFAULT_FRESHNESS_DAYS,
  DEFAULT_LIMIT,
  DEFAULT_MIN_TA_SCORE,
  DEFAULT_WRITE_THRESHOLD,
  MAX_FRESHNESS_DAYS,
  MAX_LIMIT,
  SOURCE_CODES,
  SOURCE_LABELS,
  type RuOutreachConfig,
  type SourceCode,
} from '@/lib/polzaRuOutreach/types';
import { SidePanel } from '@/components/ui/SidePanel';

interface Props {
  open: boolean;
  busy: boolean;
  senders: Array<{ id: string; sender_name: string; sender_title: string | null; is_default: boolean; status: string }>;
  /** Настройки прошлого запуска — приходят из кнопки «Повторить». */
  initial?: Partial<RuOutreachConfig> | null;
  onClose: () => void;
  onStart: (config: Partial<RuOutreachConfig>) => void;
}

const input =
  'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-violet-400 focus:outline-none focus:ring-1 focus:ring-violet-400';
const label = 'mb-1 block text-sm font-medium text-gray-700';
const section = 'mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-500';

const DEFAULT_SOURCES: SourceCode[] = ['hh', 'direct', 'crm', 'site_news'];

const MILLION = 1_000_000;

function Slider({
  title,
  hint,
  value,
  min,
  max,
  step = 1,
  suffix = '',
  onChange,
}: {
  title: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (v: number) => void;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-sm font-medium text-gray-700">{title}</span>
        <span className="text-sm font-semibold tabular-nums text-violet-700">
          {value}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        className="w-full accent-violet-600"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <p className="mt-1 text-xs text-gray-500">{hint}</p>
    </div>
  );
}

export function LaunchPanel({ open, busy, senders, initial, onClose, onStart }: Props) {
  const [sources, setSources] = useState<SourceCode[]>(initial?.sources ?? DEFAULT_SOURCES);
  // Ползунок свежести начинается с 7 дней — старый запуск с меньшим окном подтягиваем к нему.
  const [freshness, setFreshness] = useState(Math.min(MAX_FRESHNESS_DAYS, Math.max(7, initial?.freshness_days ?? DEFAULT_FRESHNESS_DAYS)));
  const [limit, setLimit] = useState(initial?.limit ?? DEFAULT_LIMIT);
  const [write, setWrite] = useState(initial?.write_threshold ?? DEFAULT_WRITE_THRESHOLD);
  const [minTa, setMinTa] = useState(initial?.min_ta_score ?? DEFAULT_MIN_TA_SCORE);
  const [minContract, setMinContract] = useState(initial?.min_contract_amount ?? MILLION);
  const [minRevenueM, setMinRevenueM] = useState((initial?.min_revenue ?? 30 * MILLION) / MILLION);
  const [maxRevenueM, setMaxRevenueM] = useState((initial?.max_revenue ?? 3000 * MILLION) / MILLION);
  const [minEmployees, setMinEmployees] = useState(initial?.min_employees ?? 10);
  const [includeExported, setIncludeExported] = useState(initial?.include_previously_exported ?? false);
  const [senderId, setSenderId] = useState(initial?.sender_id ?? '');
  const [advanced, setAdvanced] = useState(false);

  const activeSenders = senders.filter((s) => s.status === 'active');
  const toggle = (s: SourceCode) => setSources((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  const submit = () => {
    onStart({
      sources,
      freshness_days: freshness,
      limit,
      write_threshold: write,
      min_ta_score: minTa,
      min_contract_amount: minContract,
      min_revenue: minRevenueM * MILLION,
      max_revenue: maxRevenueM * MILLION,
      min_employees: minEmployees,
      include_previously_exported: includeExported,
      sender_id: senderId || null,
    });
    onClose();
  };

  return (
    <SidePanel
      open={open}
      title={initial ? 'Повторить запуск' : 'Новый запуск'}
      hint="Письма не отправляются: результат — таблица и Excel с готовыми цепочками."
      onClose={onClose}
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-gray-500">{sources.length === 0 ? 'Выберите хотя бы один источник' : `Источников: ${sources.length}`}</span>
          <span className="flex gap-2">
            <button type="button" onClick={onClose} className="rounded-lg px-3 py-2 text-sm text-gray-600 hover:bg-gray-100">
              Отмена
            </button>
            <button
              type="button"
              disabled={busy || sources.length === 0}
              onClick={submit}
              className="inline-flex items-center rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
            >
              {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
              Запустить
            </button>
          </span>
        </div>
      }
    >
      <p className="text-sm text-gray-600">
        Система сравнивает все поводы компании и выбирает лучший оффер: {CHAIN_TYPES.map((c) => CHAIN_LABELS[c]).join(', ')}. «Возврат» —
        всегда первый, если с компанией уже говорили. Открытые сделки и клиенты из AMO пропускаются. Спорные компании помечаются, очень
        спорные уходят в отдельную вкладку и в Instantly не попадают.
      </p>

      <div className="mt-5">
        <div className={section}>Основное</div>
        <span className={label}>Источники компаний</span>
        <div className="grid grid-cols-1 gap-x-5 gap-y-2 sm:grid-cols-2">
          {SOURCE_CODES.map((s) => (
            <label key={s} className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={sources.includes(s)} onChange={() => toggle(s)} />
              {SOURCE_LABELS[s]}
            </label>
          ))}
        </div>
        <p className="mt-2 text-xs text-gray-500">
          Выставки, госконтракты и гранты берутся из файлов вкладки «Библиотеки». Общая база даёт компании без повода — они попадут в цепочку
          «Только профиль», только если сайт получит ЦА-балл от 7. Тендеры — из файлов «Библиотек». Новости и рост выручки проверяются у
          каждой компании и удлиняют запуск.
        </p>

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className={label}>Сколько готовых компаний</label>
            <input className={input} type="number" min={1} max={MAX_LIMIT} value={limit} onChange={(e) => setLimit(Number(e.target.value))} />
            <p className="mt-1 text-xs text-gray-500">Готовые уходят в Instantly. На 500 запуск идёт несколько часов и заметно дороже по ИИ.</p>
          </div>
          <div>
            <label className={label}>Подпись</label>
            <select className={input} value={senderId} onChange={(e) => setSenderId(e.target.value)}>
              <option value="">По умолчанию</option>
              {activeSenders.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.sender_name}
                  {s.sender_title ? `, ${s.sender_title}` : ''}
                  {s.is_default ? ' (по умолчанию)' : ''}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-5 space-y-5">
          <Slider title="Пишем от оценки" hint="Оценка компании 0–100. Ниже — отсев." value={write} min={0} max={100} onChange={setWrite} />
          <Slider
            title="Похожесть на клиента от"
            hint="Балл 0–10 по сайту. Ниже — отсев из любого источника; «Только профиль» — не ниже 7."
            value={minTa}
            min={0}
            max={10}
            onChange={setMinTa}
          />
          <Slider title="Свежесть повода" hint="Повод старше — не повод." value={freshness} min={7} max={MAX_FRESHNESS_DAYS} suffix=" дн." onChange={setFreshness} />
        </div>

        <div className="mt-5">
          <span className={label}>Размер компаний (для всех источников)</span>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <div className="mb-1 text-xs text-gray-500">Выручка от, млн ₽</div>
              <input className={input} type="number" min={0} value={minRevenueM} onChange={(e) => setMinRevenueM(Number(e.target.value))} />
            </div>
            <div>
              <div className="mb-1 text-xs text-gray-500">Выручка до, млн ₽</div>
              <input className={input} type="number" min={0} value={maxRevenueM} onChange={(e) => setMaxRevenueM(Number(e.target.value))} />
            </div>
            <div>
              <div className="mb-1 text-xs text-gray-500">Сотрудников от</div>
              <input className={input} type="number" min={0} value={minEmployees} onChange={(e) => setMinEmployees(Number(e.target.value))} />
            </div>
          </div>
          <p className="mt-1 text-xs text-gray-500">Известный размер вне рамок — отсев. Неизвестный — компания проходит.</p>
        </div>
      </div>

      <div className="mt-6 border-t border-gray-200 pt-4">
        <button type="button" onClick={() => setAdvanced((v) => !v)} className="flex items-center gap-1 text-sm font-medium text-gray-700 hover:text-gray-900">
          {advanced ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          Тонкая настройка
        </button>
        {!advanced && <p className="mt-1 text-xs text-gray-500">Сумма госконтракта и повторные выгрузки.</p>}

        {advanced && (
          <div className="mt-4 space-y-5">
            <div className="sm:max-w-xs">
              <label className={label}>Мин. сумма госконтракта, ₽</label>
              <input className={input} type="number" min={0} step={100000} value={minContract} onChange={(e) => setMinContract(Number(e.target.value))} />
            </div>

            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={includeExported} onChange={(e) => setIncludeExported(e.target.checked)} />
              Брать компании, которые уже выгружались раньше
            </label>
          </div>
        )}
      </div>
    </SidePanel>
  );
}
