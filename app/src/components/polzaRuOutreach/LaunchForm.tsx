'use client';

import { useState } from 'react';
import { Loader2, Play } from 'lucide-react';
import {
  DEFAULT_FRESHNESS,
  DEFAULT_LIMIT,
  DEFAULT_MIN_CONTRACT_AMOUNT,
  DEFAULT_MIN_SIGNAL_SCORE,
  MAX_LIMIT,
  PROFILE_CODES,
  PROFILE_LABELS,
  PROFILE_SOURCES,
  SOURCE_LABELS,
  type ProfileCode,
  type RelationshipFilter,
  type RuOutreachConfig,
  type SourceCode,
} from '@/lib/polzaRuOutreach/types';

const PROFILE_HINTS: Record<ProfileCode, string> = {
  sdr_hiring_v1:
    'Компании, которые сейчас ищут SDR / менеджера активных продаж. В цепочку попадают только те, у кого в тексте вакансии прямо написано про холодный поиск или привлечение новых клиентов. 3 письма.',
  automated_outreach_v1:
    'Формат «автоматизированный аутрич по нескольким сегментам». Прошлые лиды и клиенты из AMO и компании с несколькими вакансиями продаж. «Мы с вами уже общались» — только если разговор записан в AMO. 3 письма.',
  signals_v1:
    'Свежие коммерческие сигналы: вакансии продаж, госконтракты, участие в выставках, новости на сайте. Сигналы одной компании складываются, выбирается сильнейший. 4 письма.',
};

interface Props {
  busy: boolean;
  senders: Array<{ id: string; sender_name: string; sender_title: string | null; is_default: boolean; status: string }>;
  onStart: (config: Partial<RuOutreachConfig>) => void;
}

const input =
  'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:border-violet-400 focus:outline-none focus:ring-1 focus:ring-violet-400';
const label = 'mb-1 block text-sm font-medium text-gray-700';

export function LaunchForm({ busy, senders, onStart }: Props) {
  const [profile, setProfile] = useState<ProfileCode>('sdr_hiring_v1');
  const [sources, setSources] = useState<SourceCode[]>(PROFILE_SOURCES.sdr_hiring_v1);
  const [freshness, setFreshness] = useState(DEFAULT_FRESHNESS.sdr_hiring_v1);
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [relationship, setRelationship] = useState<RelationshipFilter>('mixed');
  const [minScore, setMinScore] = useState(DEFAULT_MIN_SIGNAL_SCORE);
  const [minContract, setMinContract] = useState(DEFAULT_MIN_CONTRACT_AMOUNT);
  const [includeExported, setIncludeExported] = useState(false);
  const activeSenders = senders.filter((s) => s.status === 'active');
  const [senderId, setSenderId] = useState<string>('');

  const selectProfile = (code: ProfileCode) => {
    setProfile(code);
    setSources(PROFILE_SOURCES[code]);
    setFreshness(DEFAULT_FRESHNESS[code]);
  };

  const toggleSource = (s: SourceCode) =>
    setSources((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  const submit = () =>
    onStart({
      profile_code: profile,
      sources,
      freshness_days: freshness,
      limit,
      relationship_filter: relationship,
      min_signal_score: minScore,
      min_contract_amount: minContract,
      include_previously_exported: includeExported,
      sender_id: senderId || null,
    });

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
      <div className="text-xs uppercase tracking-wide text-gray-500">Оффер</div>
      <div className="mt-2 inline-flex flex-wrap rounded-lg border border-gray-200 bg-gray-50 p-1">
        {PROFILE_CODES.map((code) => (
          <button
            key={code}
            type="button"
            onClick={() => selectProfile(code)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
              profile === code ? 'bg-white text-violet-700 shadow-sm' : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            {PROFILE_LABELS[code]}
          </button>
        ))}
      </div>
      <p className="mt-3 max-w-3xl text-sm text-gray-500">{PROFILE_HINTS[profile]}</p>

      <div className="mt-5">
        <span className={label}>Источники</span>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {PROFILE_SOURCES[profile].map((s) => (
            <label key={s} className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={sources.includes(s)} onChange={() => toggleSource(s)} />
              {SOURCE_LABELS[s]}
            </label>
          ))}
        </div>
        {profile === 'signals_v1' && (
          <p className="mt-2 text-xs text-gray-500">
            Выставки и госконтракты берутся из файлов, загруженных во вкладке «Библиотеки». Новости сайтов проверяются у
            компаний, которые уже встречались в прошлых запусках.
          </p>
        )}
      </div>

      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className={label}>Свежесть сигнала, дней</label>
          <input className={input} type="number" min={1} max={180} value={freshness} onChange={(e) => setFreshness(Number(e.target.value))} />
        </div>
        <div>
          <label className={label}>Сколько готовых компаний</label>
          <input className={input} type="number" min={1} max={MAX_LIMIT} value={limit} onChange={(e) => setLimit(Number(e.target.value))} />
        </div>
        {profile === 'automated_outreach_v1' && (
          <div>
            <label className={label}>Прошлое общение</label>
            <select className={input} value={relationship} onChange={(e) => setRelationship(e.target.value as RelationshipFilter)}>
              <option value="mixed">Все: и холодные, и из AMO</option>
              <option value="prior_contact">Только с кем уже общались</option>
              <option value="cold">Всем писать как холодным</option>
            </select>
          </div>
        )}
        {profile === 'signals_v1' && (
          <>
            <div>
              <label className={label}>Порог скоринга (0–15)</label>
              <input className={input} type="number" min={0} max={15} value={minScore} onChange={(e) => setMinScore(Number(e.target.value))} />
            </div>
            <div>
              <label className={label}>Мин. сумма контракта, ₽</label>
              <input className={input} type="number" min={0} step={100000} value={minContract} onChange={(e) => setMinContract(Number(e.target.value))} />
            </div>
          </>
        )}
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
