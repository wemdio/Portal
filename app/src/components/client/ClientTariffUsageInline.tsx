'use client';

import { useEffect, useState } from 'react';
import { clientApiFetch } from '@/lib/clientFetcher';

export type ClientLimitMetric =
  | 'max_contacts'
  | 'max_rows'
  | 'max_chains_per_month'
  | 'max_domains'
  | 'max_emails';

type LimitUsage = {
  limit: number;
  used: number;
  remaining: number;
};

type TariffUsageResponse = {
  usage?: Partial<Record<ClientLimitMetric, LimitUsage>>;
};

type Props = {
  metric: ClientLimitMetric;
  spent?: number | null;
  unit?: string;
  refreshKey?: string | number | null;
  remainingOnly?: boolean;
  className?: string;
};

function formatNum(value: number) {
  return value.toLocaleString('ru-RU');
}

export function ClientTariffUsageInline({
  metric,
  spent,
  unit = 'запросов',
  refreshKey,
  remainingOnly = false,
  className,
}: Props) {
  const [usage, setUsage] = useState<LimitUsage | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const data = await clientApiFetch<TariffUsageResponse>('/tariff');
        if (cancelled) return;
        setUsage(data.usage?.[metric] ?? null);
      } catch {
        if (!cancelled) setUsage(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [metric, refreshKey]);

  if (!usage) return null;

  const remainingText = `Осталось ${formatNum(usage.remaining)} ${unit} по вашему тарифу`;
  const text = remainingOnly
    ? remainingText
    : `Потрачено: ${formatNum(spent ?? usage.used)} ${unit} · ${remainingText.toLowerCase()}`;

  return (
    <span className={className}>
      {text}
    </span>
  );
}
