'use client';

import { useEffect, useState } from 'react';
import { authFetch } from '@/lib/authFetch';
import { formatForecastDate, type SendForecast } from '@/lib/tgOutreach/baseStats';

/**
 * Одна строка: до какой даты хватит текущей базы и цепочки баз при текущем темпе.
 * Дата — прогноз по среднесуточным отправкам за период; нулевой темп даты не даёт.
 */
export function BasesForecastLine({
  forecast,
  names,
}: {
  forecast: SendForecast | null;
  /** Названия баз по id — для подписи текущего этапа. */
  names?: Record<string, string>;
}) {
  if (!forecast || forecast.remaining <= 0) return null;
  const date = (iso: string | null) => (iso ? `до ${formatForecastDate(iso)}` : 'дату не посчитать — темп нулевой');
  const pending = forecast.stages.filter((st) => st.remaining > 0);
  const current = forecast.currentStage;
  const currentNames = current
    ? current.baseIds.map((id) => names?.[id]).filter(Boolean).join(', ')
    : '';
  return (
    <div className="rounded-xl bg-gray-50 px-3 py-2 text-xs text-gray-700">
      {pending.length > 1 && current ? (
        <>
          Этапа {current.rank}{currentNames ? ` («${currentNames}»)` : ''} хватит <b>{date(current.endsAt)}</b>
          {' · '}
          всех этапов — <b>{date(forecast.endsAt)}</b>
        </>
      ) : (
        <>
          Всех баз хватит <b>{date(forecast.endsAt)}</b>
        </>
      )}
      <span className="ml-1 text-[10px] text-gray-400">
        осталось {forecast.remaining} контактов, темп {forecast.perDay}/день{forecast.accounts !== null && forecast.perAccount !== null ? ` (${forecast.accounts} акк. × ${forecast.perAccount})` : ""}
      </span>
    </div>
  );
}

/** Та же строка для вкладки «Базы»: сама берёт прогноз; `refreshKey` меняется при смене состава или режима цепочки. */
export default function BasesForecast({ campaignId, refreshKey }: { campaignId: string; refreshKey: string }) {
  const [forecast, setForecast] = useState<SendForecast | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});

  useEffect(() => {
    void (async () => {
      try {
        const res = await authFetch(`/api/tools/tg-outreach/campaigns/${campaignId}/bases-stats?period=7d`);
        if (!res.ok) return;
        const body = (await res.json()) as {
          bases: Array<{ baseId: string; name: string }>;
          forecast?: SendForecast | null;
        };
        setForecast(body.forecast ?? null);
        setNames(Object.fromEntries((body.bases ?? []).map((b) => [b.baseId, b.name])));
      } catch {
        setForecast(null);
      }
    })();
  }, [campaignId, refreshKey]);

  return <BasesForecastLine forecast={forecast} names={names} />;
}
