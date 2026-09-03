'use client';

import { useCallback, useEffect, useState } from 'react';
import type { VeContactSupplyStatus } from '@/lib/verticalEngineV2/contactSupplyStatus';
import { VE_API, veEngineCall, veEnginePost, type VeDeliveryPlanPreviewRequest } from './api';
import { HE } from './design';

type SupplyResponse = VeContactSupplyStatus & { error?: string };
type ApprovalContext = VeDeliveryPlanPreviewRequest | null;

export function useContactSupply(templateId: string | null, required: boolean, context: ApprovalContext) {
  const [snapshot, setSnapshot] = useState<{ key: string; data: VeContactSupplyStatus } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmedContext, setConfirmedContext] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [reviewed, setReviewed] = useState<{ templateId: string; revision: string | null } | null>(null);
  const presetId = context?.preset_id;
  const projectId = context?.portal_project_id;
  const periodId = context?.expected_portal_period_id;
  const target = context?.target_contacts;
  const auditId = context?.segmentation_audit_id;

  const contextKey = JSON.stringify([templateId, presetId, projectId, periodId, target, auditId]);
  const requestKey = `${templateId}:${revision}`;
  const confirmed = confirmedContext === contextKey;
  const setConfirmed = useCallback((value: boolean) => setConfirmedContext(value ? contextKey : null), [contextKey]);
  const data = required && snapshot?.key === requestKey ? snapshot.data : null;
  const reviewedRevision = reviewed?.templateId === templateId ? reviewed.revision : null;

  useEffect(() => {
    if (!required || !templateId) return;
    let cancelled = false;
    const controller = new AbortController();
    async function refresh() {
      try {
        const response = await veEngineCall<SupplyResponse>(`${VE_API}/templates/${templateId}/supply`, { signal: controller.signal });
        if (cancelled) return;
        if (!response.ok) throw new Error(response.data.error ?? 'Не удалось проверить автопополнение');
        setSnapshot({ key: requestKey, data: response.data });
        setReviewed((previous) => previous?.templateId === templateId ? previous
          : { templateId: templateId!, revision: response.data.preview_revision ?? null });
        setError('');
      } catch (caught) {
        if (cancelled) return;
        setSnapshot(null);
        setError(caught instanceof Error ? caught.message : 'Автопополнение недоступно');
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => { cancelled = true; controller.abort(); clearInterval(timer); };
  }, [required, templateId, requestKey]);

  const act = useCallback(async (action: 'approve' | 'pause' | 'resume') => {
    if (!templateId || busy || (action === 'approve' && (!confirmed || !context))) return;
    setBusy(true);
    setError('');
    try {
      const response = await veEnginePost<{ error?: string }>(`${VE_API}/templates/${templateId}/supply`, {
        ...(action === 'approve' ? context : {}), action, confirm_customer_approval: confirmed,
        expected_preview_revision: reviewedRevision,
      });
      if (!response.ok) throw new Error(response.data.error ?? 'Не удалось сохранить решение');
      setRevision((value) => value + 1);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось сохранить решение');
    } finally { setBusy(false); }
  }, [templateId, busy, confirmed, context, reviewedRevision]);

  const plan = data?.plan;
  const approved = !required || Boolean(plan?.current && ['approved', 'active'].includes(plan.status)
    && (plan.launched || (plan.preset_id === presetId && plan.portal_project_id === projectId
      && plan.portal_period_id === periodId && plan.target_contacts === target)));
  return { required, data, error, busy, confirmed, setConfirmed, act, approved, canApprove: Boolean(context) };
}

export type ContactSupplyController = ReturnType<typeof useContactSupply>;
const STATUS_LABELS: Record<NonNullable<VeContactSupplyStatus['plan']>['status'], string> = {
  approved: 'Согласовано, ожидает запуска', active: 'Автопополнение включено', paused: 'Пополнение на паузе',
  exhausted: 'Источники плана исчерпаны', limited: 'Достигнут защитный лимит', error: 'Нужна проверка сбора',
};
const count = (value: number) => value.toLocaleString('ru-RU');

export function ContactSupplyPanel({ supply }: { supply: ContactSupplyController }) {
  if (!supply.required) return null;
  const { plan, metrics, estimate } = supply.data ?? { plan: null, metrics: null, estimate: null };
  return <section className="ve2-sec border-t pt-4" aria-label="Согласование и автопополнение">
    <p className={HE.eyebrow}>Согласование и автопополнение</p>
    {!plan?.launched ? <>
      <p className={`mt-2 max-w-[70ch] ${HE.muted}`}>
        Покажите заказчику превью и письма. Согласование фиксирует текущую гипотезу, сегменты и условия запуска.
        Кампании создаются отдельно на паузе, отправка здесь не включается.
      </p>
      {!supply.approved ? <div className="mt-3 space-y-3">
        <label className="flex max-w-[70ch] items-start gap-2 text-sm">
          <input type="checkbox" className="ve2-cbx mt-1" checked={supply.confirmed}
            onChange={(event) => supply.setConfirmed(event.target.checked)} disabled={supply.busy || !supply.canApprove} />
          <span>Заказчик согласовал превью, письма и сегментацию</span>
        </label>
        <button type="button" className={HE.btnGhost} onClick={() => void supply.act('approve')}
          disabled={supply.busy || !supply.confirmed || !supply.canApprove}>
          {supply.busy ? 'Сохраняем…' : 'Зафиксировать согласование'}
        </button>
        {!supply.canApprove ? <p className={HE.faint}>Сначала завершите аудит и укажите клиентский пресет, период и обязательство.</p> : null}
      </div> : null}
    </> : null}
    {plan ? <div className="mt-3">
      <p className="text-sm font-medium">{plan.current ? STATUS_LABELS[plan.status] : 'Согласование устарело. Пополнение и загрузка заблокированы.'}</p>
      <p className={`mt-1 ${HE.faint}`}>Согласовано {new Date(plan.approved_at).toLocaleString('ru-RU')}.</p>
      {plan.error ? <p className="mt-2 text-xs ve2-t-dan">{plan.error}</p> : null}
      {plan.launched && plan.current ? <div className="mt-3">
        <button type="button" className={HE.btnQuiet} disabled={supply.busy}
          onClick={() => void supply.act(plan.status === 'active' ? 'pause' : 'resume')}>
          {supply.busy ? 'Сохраняем…' : plan.status === 'active' ? 'Приостановить пополнение' : 'Возобновить пополнение'}
        </button>
        <p className={`mt-1 max-w-[70ch] ${HE.faint}`}>Пауза останавливает новый сбор. Уже готовый запас продолжает поступать по плану. Для остановки писем используйте управление кампанией.</p>
      </div> : null}
    </div> : null}
    {metrics ? <div className="mt-4 space-y-3">
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
        <div><dt className={HE.faint}>Готовый запас этой гипотезы</dt><dd>{count(metrics.ready)}</dd></div>
        <div><dt className={HE.faint}>Ориентир этой гипотезы по текущему весу</dt><dd>{count(metrics.hypothesis_daily_target)} контактов в рабочий день</dd></div>
        <div><dt className={HE.faint}>Загружено в её кампании</dt><dd>{count(metrics.uploaded)} всего, {count(metrics.uploaded_today)} сегодня</dd></div>
        <div><dt className={HE.faint}>План ближайшего рабочего дня, весь проект</dt><dd>{count(metrics.project_daily_plan)} контактов</dd></div>
        <div><dt className={HE.faint}>Факт первых контактов за период, весь проект</dt><dd>{count(metrics.project_first_contacted)}</dd></div>
      </dl>
      <p className={HE.muted}>{metrics.hypothesis_stock_workdays === null
        ? 'Срок запаса гипотезы появится после активации и распределения темпа.'
        : `Проверенного запаса этой гипотезы хватит примерно на ${count(metrics.hypothesis_stock_workdays)} рабочих дней.`}</p>
      <p className={HE.muted}>
        Запас активных гипотез: {count(metrics.project_ready)}.
        {metrics.project_stock_workdays === null ? ' Срок запаса пока не рассчитан: нет рабочего темпа.'
          : ` Хватит примерно на ${count(metrics.project_stock_workdays)} рабочих дней при темпе ${count(metrics.project_required_daily)} в день.`}
      </p>
      {metrics.uncertain > 0 ? <p className="text-xs ve2-t-warn">Для {count(metrics.uncertain)} контактов результат загрузки уточняется. Повторно они не отправляются.</p> : null}
      {metrics.hypothesis_estimated_workdays !== null ? <p className={HE.faint}>С учётом оценки источников: ориентировочно {count(metrics.hypothesis_estimated_workdays)} рабочих дней. Это прогноз, не гарантированный запас.</p> : null}
      <p className={HE.faint}>Дата учёта: {metrics.business_date}, {metrics.timezone}. Загрузка в кампанию не равна первому отправленному письму.</p>
    </div> : null}
    {plan ? <p className={`mt-3 max-w-[70ch] ${HE.muted}`}>
      {estimate ? `В источниках ориентировочно ещё ${count(estimate.contacts)} пригодных контактов. Оценка по выходу превью, уверенность низкая (${new Date(estimate.as_of).toLocaleDateString('ru-RU')}). ${estimate.scope}`
        : 'Остаток контактов в источниках пока неизвестен. Размер рынка не подставляется вместо проверенного запаса.'}
    </p> : null}
    {supply.data?.metrics_error ? <p className="mt-2 text-xs ve2-t-warn">{supply.data.metrics_error}</p> : null}
    {supply.error ? <p className="mt-2 text-xs ve2-t-dan" role="alert">{supply.error}</p> : null}
  </section>;
}
