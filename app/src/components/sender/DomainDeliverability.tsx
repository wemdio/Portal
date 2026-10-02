'use client';

import { useMemo, useState } from 'react';
import {
  BLACKLIST_LABELS,
  evaluateDomainReputation,
  type DomainHealth,
  type Reputation,
  type ReputationGrade,
} from '@/lib/sender/domainReputation';
import type { SenderStatsDto } from './api';

/**
 * «Доставляемость по доменам»: напротив каждого домена отправки — репутация
 * и то, из чего она сложилась (правила — lib/sender/domainReputation.ts).
 * Попадание в спам у получателя напрямую не видно никому, поэтому здесь
 * косвенные, но боевые признаки: отказы «как спам», подписи домена, чёрные
 * списки и молчание на фоне остальных доменов.
 */

type DomainStat = SenderStatsDto['domains'][number];
type Row = DomainStat & { reputation: Reputation };

const GRADE_ORDER: Record<ReputationGrade, number> = { bad: 0, warn: 1, unknown: 2, good: 3 };

const GRADE_BADGE: Record<ReputationGrade, { label: string; cls: string }> = {
  good: { label: 'Хорошая', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  warn: { label: 'Есть риски', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  bad: { label: 'Плохая', cls: 'bg-red-50 text-red-700 border-red-200' },
  unknown: { label: 'Нет данных', cls: 'bg-zinc-50 text-zinc-500 border-zinc-200' },
};

const nf = (value: number) => value.toLocaleString('ru-RU');

function pct(part: number, whole: number): string {
  return whole > 0 ? `${(Math.round((part / whole) * 1000) / 10).toLocaleString('ru-RU')}%` : '—';
}

function Chip({ ok, warn, label, title }: { ok: boolean | null; warn?: boolean; label: string; title: string }) {
  const cls = ok === null
    ? 'bg-zinc-50 text-zinc-400 border-zinc-200'
    : ok
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : warn
        ? 'bg-amber-50 text-amber-700 border-amber-200'
        : 'bg-red-50 text-red-700 border-red-200';
  return (
    <span title={title} className={`cursor-help rounded border px-1.5 py-0.5 text-[11px] font-medium ${cls}`}>
      {label}
    </span>
  );
}

function Signatures({ health }: { health: DomainHealth | null }) {
  if (!health || health.error) {
    return <span className="text-xs text-zinc-400" title={health?.error ?? undefined}>не проверены</span>;
  }
  return (
    <div className="flex justify-end gap-1">
      <Chip
        label="SPF"
        ok={health.spf === 'ok'}
        warn={health.spf === 'soft'}
        title={{
          ok: 'SPF настроен',
          soft: 'SPF разрешает слать от домена кому угодно (+all / ?all)',
          missing: 'SPF нет — письма чаще уходят в спам',
          multiple: 'Две записи SPF — почтовики считают это ошибкой',
        }[health.spf ?? 'missing']}
      />
      <Chip
        label="DKIM"
        ok={Boolean(health.dkim_selector)}
        warn
        title={health.dkim_selector
          ? `DKIM найден (селектор ${health.dkim_selector})`
          : 'Не нашли под обычными именами — подпись может быть под другим; уточните у провайдера'}
      />
      <Chip
        label="DMARC"
        ok={health.dmarc !== 'missing' && health.dmarc !== null}
        warn
        title={health.dmarc === 'missing' ? 'DMARC нет' : `DMARC: p=${health.dmarc}`}
      />
    </div>
  );
}

function Blacklists({ health }: { health: DomainHealth | null }) {
  if (!health || health.error) return <span className="text-xs text-zinc-400">не проверены</span>;
  const entries = Object.entries(health.blacklists);
  const listed = entries.filter(([, s]) => s === 'listed').map(([l]) => BLACKLIST_LABELS[l] ?? l);
  if (listed.length) return <span className="text-xs font-medium text-red-600">{listed.join(', ')}</span>;
  const unknown = entries.filter(([, s]) => s === 'unknown').map(([l]) => BLACKLIST_LABELS[l] ?? l);
  if (!entries.length || unknown.length === entries.length) {
    return <span className="text-xs text-zinc-400" title="Списки не ответили на запрос">не проверены</span>;
  }
  return (
    <span
      className="text-xs text-emerald-700"
      title={unknown.length ? `Не ответили: ${unknown.join(', ')}` : 'Spamhaus, SURBL, URIBL — домена нет'}
    >
      чисто{unknown.length ? '*' : ''}
    </span>
  );
}

export function DomainDeliverability({ domains }: { domains: SenderStatsDto['domains'] }) {
  const [onlyProblems, setOnlyProblems] = useState(false);

  const rows: Row[] = useMemo(() => {
    const totalReached = domains.reduce((sum, d) => sum + d.reached, 0);
    const totalReplied = domains.reduce((sum, d) => sum + d.replied, 0);
    return domains
      .map((d) => {
        const othersReached = totalReached - d.reached;
        return {
          ...d,
          reputation: evaluateDomainReputation({
            health: d.health,
            reached: d.reached,
            replied: d.replied,
            bounceKinds: d.bounceKinds ?? {},
            othersReplyRate: othersReached > 0 ? (totalReplied - d.replied) / othersReached : null,
          }),
        };
      })
      .sort((a, b) => GRADE_ORDER[a.reputation.grade] - GRADE_ORDER[b.reputation.grade] || b.sent - a.sent);
  }, [domains]);

  const counts = rows.reduce<Record<ReputationGrade, number>>(
    (acc, r) => ({ ...acc, [r.reputation.grade]: acc[r.reputation.grade] + 1 }),
    { good: 0, warn: 0, bad: 0, unknown: 0 },
  );
  const visible = onlyProblems ? rows.filter((r) => r.reputation.grade === 'bad' || r.reputation.grade === 'warn') : rows;

  return (
    <div className="rounded-xl border border-zinc-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200 px-5 py-3">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900">Доставляемость по доменам</h3>
          <p className="text-xs text-zinc-400">
            Хорошая — {counts.good} · есть риски — {counts.warn} · плохая — {counts.bad}
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-zinc-500">
          <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} />
          Только с проблемами
        </label>
      </div>
      {visible.length === 0 ? (
        <p className="px-5 py-10 text-center text-sm text-zinc-400">
          {onlyProblems ? 'Проблемных доменов нет.' : 'Доменов отправки пока нет.'}
        </p>
      ) : (
        <div className="max-h-[560px] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white text-left text-xs uppercase text-zinc-500">
              <tr className="border-b border-zinc-200">
                <th className="px-5 py-2 font-medium">Домен</th>
                <th className="px-3 py-2 font-medium">Репутация</th>
                <th className="px-3 py-2 text-right font-medium">Писем</th>
                <th className="px-3 py-2 text-right font-medium" title="Доля ответивших из получателей">Ответили</th>
                <th className="px-3 py-2 text-right font-medium" title="Сервер получателя отказал, назвав письмо спамом">Как спам</th>
                <th className="px-3 py-2 text-right font-medium" title="Адреса не существует — это про базу, не про репутацию">Адреса нет</th>
                <th className="px-3 py-2 text-right font-medium">Подписи</th>
                <th className="px-3 py-2 text-right font-medium">Чёрные списки</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => {
                const badge = GRADE_BADGE[row.reputation.grade];
                const spam = row.bounceKinds?.spam ?? 0;
                const noUser = row.bounceKinds?.no_user ?? 0;
                return (
                  <tr key={row.domain} className="border-b border-zinc-100 align-top last:border-0">
                    <td className="px-5 py-2 font-medium text-zinc-900">{row.domain}</td>
                    <td className="max-w-[280px] px-3 py-2">
                      <span className={`inline-block rounded-md border px-2 py-0.5 text-xs font-medium ${badge.cls}`}>
                        {badge.label}
                      </span>
                      {row.reputation.issues.length ? (
                        <div className="mt-1 truncate text-xs text-zinc-500" title={row.reputation.issues.join('\n')}>
                          {row.reputation.issues[0]}
                          {row.reputation.issues.length > 1 ? ` (+${row.reputation.issues.length - 1})` : ''}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-600">{nf(row.sent)}</td>
                    <td
                      className={`px-3 py-2 text-right tabular-nums ${row.reputation.silent ? 'text-amber-600' : 'text-zinc-700'}`}
                      title={row.reputation.expectedReplies !== null
                        ? `Ответили ${row.replied} из ${row.reached}; по другим доменам ждали бы около ${Math.round(row.reputation.expectedReplies * 10) / 10}`
                        : undefined}
                    >
                      {pct(row.replied, row.reached)}
                      {row.replied ? <span className="ml-1 text-xs text-zinc-400">({nf(row.replied)})</span> : null}
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums ${spam ? 'font-medium text-red-600' : 'text-zinc-400'}`}>
                      {nf(spam)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-600">{nf(noUser)}</td>
                    <td className="px-3 py-2 text-right"><Signatures health={row.health} /></td>
                    <td className="px-3 py-2 text-right"><Blacklists health={row.health} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
