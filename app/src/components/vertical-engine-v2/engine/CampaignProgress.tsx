'use client';

import type { ReactNode } from 'react';
import type { VeContactSupplyStatus } from '@/lib/verticalEngineV2/contactSupplyStatus';
import { isVeRequestyBillingError } from '@/lib/verticalEngineV2/collectionErrors';
import { veRequestyBillingWaitState } from '@/lib/verticalEngineV2/requestyBillingState';
import { parseLaunchInfo } from '@/lib/verticalEngineV2/launchHandoff';
import { senderOpenLabel } from '@/lib/verticalEngineV2/senderTransport/labels';
import type { VeTemplate } from '@/lib/verticalEngineV2/types';
import { useContactSupply } from './ContactSupplyPanel';
import { ContactUploadNotice } from './ContactUploadNotice';
import { HE } from './design';
import type { ContactUploadMode } from './ContactUploadModePanel';
import { StatusBox } from './ui';

interface CampaignProgressProps {
  template: VeTemplate;
  title: string;
  /** False for imported bases and other campaigns without automatic supply. */
  required: boolean;
  headerAction?: ReactNode;
  uploadMode?: ContactUploadMode;
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

export function CampaignProgress({ template, title, required, headerAction, uploadMode = 'daily' }: CampaignProgressProps) {
  const supply = useContactSupply(template.id, required, null);
  const info = parseLaunchInfo((template as VeTemplate & { launch_info?: unknown }).launch_info);
  const sender = info?.transport === 'sender';
  const plan = required ? supply.data?.plan : null;
  const metrics = required ? supply.data?.metrics : null;
  const stock = metrics ?? (required ? supply.data?.stock : null);
  const campaigns = info?.campaigns?.length ? info.campaigns : info ? [{
    campaign_id: info.campaign_id,
    campaign_name: info.campaign_name,
    campaign_url: info.campaign_url,
  }] : [];
  const canPause = plan?.launched && plan.current && plan.status === 'active';
  const canResume = plan?.launched && plan.current && ['paused', 'error'].includes(plan.status);
  const billingStopped = plan?.status === 'error' && isVeRequestyBillingError(plan.error);
  const billingWait = plan?.current && plan.status === 'active'
    ? veRequestyBillingWaitState({ requesty_billing_wait: plan.billing_wait }) : null;

  return (
    <article id={`ve-campaign-${template.id}`} tabIndex={-1}
      aria-label={`Добор контактов: ${title}`} className="border-t border-[var(--ve2-line)] pt-5 space-y-3 scroll-mt-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3 className="ve2-h3">{title}</h3>
        {headerAction}
      </div>
      <ContactUploadNotice key={template.id} templateId={template.id} />

      {plan ? (
        <div className="space-y-2">
          <StatusBox tone={!plan.current || plan.status === 'error' || billingWait?.requiresAdmin ? 'error' : 'info'}>
            {plan.current
              ? billingWait
                ? <><span className="block">{billingWait.title}</span><span className="block">{billingWait.description}</span></>
                : billingStopped
                ? 'Поиск остановился из-за нехватки средств в Requesty. Результаты сохранены.'
                : SUPPLY_LABELS[plan.status]
              : 'Согласование устарело. Автоматический поиск и загрузка контактов заблокированы.'}
          </StatusBox>
          {plan.error && !billingStopped && !billingWait ? <StatusBox tone="error">{plan.error}</StatusBox> : null}
        </div>
      ) : required && supply.data?.required ? (
        <StatusBox tone="info">Автоматический поиск для этих кампаний ещё не согласован.</StatusBox>
      ) : null}

      {stock ? (
        <>
          <div className="ve2-stats">
            <div className="ve2-stat">
              <p className="ve2-stat-v">{count(stock.ready)}</p>
              <p className="ve2-stat-k">Готовый запас</p>
            </div>
            <div className="ve2-stat">
              <p className="ve2-stat-v">{count(stock.uploaded_today)}</p>
              <p className="ve2-stat-k">{sender ? 'Добавлено сегодня в «Рассылку»' : 'Добавлено сегодня в Instantly'}</p>
            </div>
            <div className="ve2-stat">
              <p className="ve2-stat-v">{count(stock.uploaded)}</p>
              <p className="ve2-stat-k">Всего добавлено в кампании</p>
            </div>
          </div>
          {uploadMode === 'daily' && metrics && metrics.hypothesis_stock_workdays !== null ? (
            <p className={HE.muted}>
              Готового запаса хватит примерно на {count(metrics.hypothesis_stock_workdays)} рабочих дней
              при темпе {count(metrics.hypothesis_daily_target)} контактов в день.
            </p>
          ) : null}
          {stock.uncertain > 0 ? (
            <StatusBox tone="info">
              Для {count(stock.uncertain)} контактов результат загрузки ещё не подтверждён.
              Повторная загрузка заблокирована до автоматической сверки с {sender ? '«Рассылкой»' : 'Instantly'}.
            </StatusBox>
          ) : null}
          <p className={HE.faint}>
            Дата учёта: {stock.business_date}, {stock.timezone}.
            {' '}Загрузка в кампанию не означает первое отправленное письмо.
          </p>
        </>
      ) : required && !supply.data && !supply.error ? (
        <p role="status" className={HE.muted}>Загружаем состояние поиска и доставки…</p>
      ) : null}

      {required && supply.data?.metrics_error ? (
        <StatusBox tone={supply.data.analytics_pending ? 'info' : 'error'}>{supply.data.metrics_error}</StatusBox>
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
          {sender
            ? senderOpenLabel(campaign.campaign_name || `кампания ${index + 1}`)
            : <>Открыть в Instantly: {campaign.campaign_name || `кампания ${index + 1}`}</>}
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
            aria-label={`${canPause ? 'Приостановить поиск' : 'Продолжить поиск'}: ${title}`}
            onClick={() => void supply.act(canPause ? 'pause' : 'resume')}
          >
            {supply.busy ? 'Сохраняем…' : canPause ? 'Приостановить поиск'
              : 'Продолжить поиск'}
          </button>
        </div>
      ) : null}
    </article>
  );
}
