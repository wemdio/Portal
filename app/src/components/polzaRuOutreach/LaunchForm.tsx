'use client';

import { useState } from 'react';
import { Loader2, Play } from 'lucide-react';
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

interface Props {
  busy: boolean;
  senders: Array<{ id: string; sender_name: string; sender_title: string | null; is_default: boolean; status: string }>;
  onStart: (config: Partial<RuOutreachConfig>) => void;
}

const input =
  'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-violet-400 focus:outline-none focus:ring-1 focus:ring-violet-400';
const label = 'mb-1 block text-sm font-medium text-gray-700';

const DEFAULT_SOURCES: SourceCode[] = ['hh', 'direct', 'crm', 'site_news'];

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
      <input type="range" className="w-full accent-violet-600" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <p className="mt-1 text-xs text-gray-500">{hint}</p>
    </div>
  );
}

export function LaunchForm({ busy, senders, onStart }: Props) {
  const [sources, setSources] = useState<SourceCode[]>(DEFAULT_SOURCES);
  const [freshness, setFreshness] = useState(DEFAULT_FRESHNESS_DAYS);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [write, setWrite] = useState(DEFAULT_WRITE_THRESHOLD);
  const [minTa, setMinTa] = useState(DEFAULT_MIN_TA_SCORE);
  const [minContract, setMinContract] = useState(1_000_000);
  const [minRevenueM, setMinRevenueM] = useState(30);
  const [maxRevenueM, setMaxRevenueM] = useState(3000);
  const [minEmployees, setMinEmployees] = useState(10);
  const [includeExported, setIncludeExported] = useState(false);
  const [senderId, setSenderId] = useState('');
  const activeSenders = senders.filter((s) => s.status === 'active');

  const toggle = (s: SourceCode) => setSources((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  const submit = () =>
    onStart({
      sources,
      freshness_days: freshness,
      limit,
      write_threshold: write,
      min_ta_score: minTa,
      min_contract_amount: minContract,
      min_revenue: minRevenueM * 1_000_000,
      max_revenue: maxRevenueM * 1_000_000,
      min_employees: minEmployees,
      include_previously_exported: includeExported,
      sender_id: senderId || null,
    });

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
      <p className="max-w-4xl text-sm text-gray-600">
        Система сравнивает все поводы компании и выбирает лучший оффер: {CHAIN_TYPES.map((c) => CHAIN_LABELS[c]).join(', ')}.
        «Возврат» — всегда первый, если с компанией уже говорили. Открытые сделки и клиенты из AMO пропускаются. Спорные компании
        помечаются, очень спорные уходят в отдельную вкладку и в Instantly не попадают.
      </p>

      <div className="mt-5">
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
          Выставки, госконтракты и гранты берутся из файлов вкладки «Библиотеки». Общая база даёт компании без повода — они
          попадут в цепочку «Только профиль», только если сайт получит ЦА-балл от 7. Тендеры — из файлов «Библиотек». Новости и
          рост выручки проверяются у каждой компании и удлиняют запуск.
        </p>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
        <div>
          <label className={label}>Мин. сумма госконтракта, ₽</label>
          <input className={input} type="number" min={0} step={100000} value={minContract} onChange={(e) => setMinContract(Number(e.target.value))} />
        </div>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-3">
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

      <div className="mt-5 flex flex-wrap items-center justify-between gap-4">
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={includeExported} onChange={(e) => setIncludeExported(e.target.checked)} />
          Брать компании, которые уже выгружались раньше
        </label>
        <button
          type="button"
          disabled={busy || sources.length === 0}
          onClick={submit}
          className="inline-flex items-center justify-center rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
        >
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
          Запустить
        </button>
      </div>
      <p className="mt-3 text-xs text-gray-500">Письма не отправляются: результат — таблица и Excel с готовыми цепочками.</p>
    </div>
  );
}
