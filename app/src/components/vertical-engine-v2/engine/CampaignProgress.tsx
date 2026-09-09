'use client';

import type { VeContactSupplyStatus } from '@/lib/verticalEngineV2/contactSupplyStatus';
import { parseLaunchInfo } from '@/lib/verticalEngineV2/launchHandoff';
import type { VeTemplate } from '@/lib/verticalEngineV2/types';
import { useContactSupply } from './ContactSupplyPanel';
import { HE } from './design';
import { StatusBox } from './ui';

interface CampaignProgressProps {
  template: VeTemplate;
  title: string;
  /** False for imported bases and other campaigns without automatic supply. */
  required: boolean;
}

const SUPPLY_LABELS: Record<NonNullable<VeContactSupplyStatus['plan']>['status'], string> = {
  approved: 'Поиск согласован, ожидает запуска кампаний',
  active: 'Автоматический поиск новых контактов включён',
  paused: 'Поиск новых контактов на паузе',
  exhausted: 'Доступные источники плана исчерпаны',
  limited: 'Поиск остановлен: достигнут защитный лимит',
  error: 'Поиск новых контактов остановился из-за ошибки',
};

const count = (value: number) => value.toLocaleString('ru-RU');

export function CampaignProgress({ template, title, required }: CampaignProgressProps) {
  const supply = useContactSupply(template.id, required, null);
  const info = parseLaunchInfo((template as VeTemplate & { launch_info?: unknown }).launch_info);
  const plan = required ? supply.data?.plan : null;
  const metrics = required ? supply.data?.metrics : null;
  const campaigns = info?.campaigns?.length ? info.campaigns : info ? [{
    campaign_id: info.campaign_id,
    campaign_name: info.campaign_name,
    campaign_url: info.campaign_url,
  }] : [];
  const canPause = plan?.launched && plan.current && plan.status === 'active';
  const canResume = plan?.launched && plan.current && ['paused', 'error'].includes(plan.status);

  return (
    <article className="border-t border-[var(--ve2-line)] pt-5 space-y-3">
      <h3 className="ve2-h3">{title}</h3>

      {plan ? (
        <div className="space-y-2">
          <StatusBox tone={!plan.current || plan.status === 'error' ? 'error' : 'info'}>
            {plan.current
              ? SUPPLY_LABELS[plan.status]
              : 'Согласование устарело. Автоматический поиск и загрузка контактов заблокированы.'}
          </StatusBox>
          {plan.error ? <StatusBox tone="error">{plan.error}</StatusBox> : null}
        </div>
      ) : required && supply.data?.required ? (
        <StatusBox tone="info">Автоматический поиск для этих кампаний ещё не согласован.</StatusBox>
      ) : null}

      {metrics ? (
        <>
          <div className="ve2-stats">
            <div className="ve2-stat">
              <p className="ve2-stat-v">{count(metrics.ready)}</p>
              <p className="ve2-stat-k">Готовый запас</p>
            </div>
            <div className="ve2-stat">
              <p className="ve2-stat-v">{count(metrics.uploaded_today)}</p>
              <p className="ve2-stat-k">Добавлено сегодня в Instantly</p>
            </div>
            <div className="ve2-stat">
              <p className="ve2-stat-v">{count(metrics.uploaded)}</p>
              <p className="ve2-stat-k">Всего добавлено в кампании</p>
            </div>
          </div>
          {metrics.hypothesis_stock_workdays !== null ? (
            <p className={HE.muted}>
              Готового запаса хватит примерно на {count(metrics.hypothesis_stock_workdays)} рабочих дней
              при темпе {count(metrics.hypothesis_daily_target)} контактов в день.
            </p>
          ) : null}
          {metrics.uncertain > 0 ? (
            <StatusBox tone="info">
              Для {count(metrics.uncertain)} контактов результат загрузки ещё не подтверждён.
              Повторная загрузка этих контактов заблокирована.
            </StatusBox>
          ) : null}
          <p className={HE.faint}>
            Дата учёта: {metrics.business_date}, {metrics.timezone}.
            {' '}Загрузка в кампанию не означает первое отправленное письмо.
          </p>
        </>
      ) : required && !supply.data && !supply.error ? (
        <p role="status" className={HE.muted}>Загружаем состояние поиска и доставки…</p>
      ) : null}

      {required && supply.data?.metrics_error ? (
        <StatusBox tone="error">{supply.data.metrics_error}</StatusBox>
      ) : null}
      {required && supply.error ? <StatusBox tone="error">{supply.error}</StatusBox> : null}

      {campaigns.map((campaign, index) => campaign.campaign_url ? (
        <a
          key={campaign.campaign_id}
          className="ve2-link block"
          href={campaign.campaign_url}
          target="_blank"
          rel="noreferrer"
        >
          Открыть в Instantly: {campaign.campaign_name || `кампания ${index + 1}`}
        </a>
      ) : (
        <p key={campaign.campaign_id} className={HE.muted}>
          {campaign.campaign_name || `Кампания ${index + 1}`}: ссылка пока недоступна.
        </p>
      ))}

      {canPause || canResume ? (
        <div className="space-y-2">
          <p className={HE.muted}>
            Пауза поиска сохраняет отправку уже готовым контактам.
          </p>
          <button
            type="button"
            className={HE.btnGhost}
            disabled={supply.busy}
            onClick={() => void supply.act(canPause ? 'pause' : 'resume')}
          >
            {supply.busy ? 'Сохраняем…' : canPause ? 'Приостановить поиск'
              : plan?.status === 'error' ? 'Повторить поиск' : 'Возобновить поиск'}
          </button>
        </div>
      ) : null}
    </article>
  );
}
