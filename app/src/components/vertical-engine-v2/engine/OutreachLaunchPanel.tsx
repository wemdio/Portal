'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { VeTemplate } from '@/lib/verticalEngineV2/types';
import type { VeOutreachSetupResponse } from '@/lib/verticalEngineV2/outreachSetup';
import type { VeOutreachLaunchRequest, VeOutreachRun } from '@/lib/verticalEngineV2/outreachLaunch';
import { VE_API, veEnginePost, type VeDeliveryPlanPreviewDto } from './api';
import { HE } from './design';
import { StatusBox } from './ui';
import { CreateClientPresetInline, DeliveryPlanBlock, useTemplateLaunch } from './steps/Step5Template';

type PreflightItem = VeOutreachLaunchRequest['items'][number] & {
  status: 'ready' | 'working' | 'blocked';
  error?: string;
  summary?: { segments?: Array<{ count: number; name?: string }>; defaultGroup?: { count: number } };
  preview?: VeDeliveryPlanPreviewDto & { prospective_ready: number };
};
interface Preflight {
  ready: boolean;
  items: PreflightItem[];
  error?: string;
}
export function OutreachLaunchPanel({
  projectId,
  snapshot,
  templates,
  titles,
  onStarted,
  onPresetChange,
}: {
  projectId: string;
  snapshot: VeOutreachSetupResponse;
  templates: VeTemplate[];
  titles: Record<string, string>;
  onStarted: (run: VeOutreachRun) => void;
  onPresetChange: (presetId: string) => void;
}) {
  const firstPreparation = snapshot.preparations.find(
    (p) => p.hypothesis_id === snapshot.setup.selected_hypothesis_ids[0],
  );
  const first = templates.find((t) => t.id === firstPreparation?.template_id) ?? null;
  const [preflightState, setPreflightState] = useState<{ key: string; result: Preflight } | null>(null);
  const [confirmedKey, setConfirmedKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const retryRequest = useRef(0);
  const idempotency = useRef<{ key: string; id: string } | null>(null);
  const onAuditRejected = useCallback(() => setPreflightState(null), []);
  const launch = useTemplateLaunch(
    first,
    preflightState?.result.items[0]?.segmentation_audit_id ?? null,
    onAuditRejected,
  );
  const openForm = launch.openForm;
  useEffect(() => {
    const timer = setTimeout(() => {
      if (first) openForm();
    }, 0);
    return () => clearTimeout(timer);
  }, [first, openForm]);
  useEffect(() => {
    onPresetChange(launch.presetId);
  }, [launch.presetId, onPresetChange]);
  const request = useMemo<VeOutreachLaunchRequest | null>(() => {
    if (!launch.presetId || !launch.portalProjectId || !launch.activePortalPeriod?.id || !launch.targetContacts)
      return null;
    const ids = snapshot.setup.selected_hypothesis_ids;
    if (!ids.length) return null;
    const items: VeOutreachLaunchRequest['items'] = [];
    for (const id of ids) {
      const p = snapshot.preparations.find((row) => row.hypothesis_id === id);
      if (!p?.base_id || !p.template_id || p.status !== 'ready') return null;
      const review = snapshot.reviews[p.base_id],
        approval = snapshot.setup.approved_bases[p.base_id];
      if (!review || approval?.revision !== review.revision || approval.template_id !== p.template_id) return null;
      items.push({
        hypothesis_id: id,
        base_id: p.base_id,
        template_id: p.template_id,
        preview_revision: review.revision,
      });
    }
    return {
      setup_revision: snapshot.setup.revision,
      preset_id: launch.presetId,
      portal_project_id: launch.portalProjectId,
      expected_portal_period_id: launch.activePortalPeriod.id,
      target_contacts: launch.targetContacts,
      items,
    };
  }, [snapshot, launch.presetId, launch.portalProjectId, launch.activePortalPeriod, launch.targetContacts]);
  const requestKey = request ? JSON.stringify(request) : '';
  const preflight = preflightState?.key === requestKey ? preflightState.result : null;
  const confirmationKey = preflight?.ready
    ? requestKey + JSON.stringify(preflight.items.map((i) => i.segmentation_audit_id))
    : '';
  useEffect(() => {
    if (!requestKey) return;
    const input = JSON.parse(requestKey) as VeOutreachLaunchRequest;
    let cancelled = false,
      inFlight = false;
    const check = async () => {
      if (inFlight || cancelled) return;
      inFlight = true;
      try {
        const explicitRetry = retry > retryRequest.current;
        retryRequest.current = retry;
        const result = await veEnginePost<Preflight>(`${VE_API}/projects/${projectId}/outreach/prepare-launch`, {
          ...input,
          ...(explicitRetry ? { retry_failed_audits: true } : {}),
        });
        if (cancelled) return;
        if (!result.ok) {
          setPreflightState(null);
          setError(result.data.error ?? 'Не удалось проверить запуск');
          clearInterval(timer);
          return;
        }
        setError('');
        setPreflightState({ key: requestKey, result: result.data });
        if (result.data.ready || result.data.items.some((i) => i.status === 'blocked')) clearInterval(timer);
      } catch {
        if (!cancelled) {
          setPreflightState(null);
          setError('Не удалось проверить запуск. Повторите проверку');
          clearInterval(timer);
        }
      } finally {
        inFlight = false;
      }
    };
    const timer = setInterval(() => void check(), 4000);
    void check();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [projectId, requestKey, retry]);
  const start = async () => {
    if (!request || !preflight?.ready || confirmedKey !== confirmationKey || busy) return;
    if (idempotency.current?.key !== confirmationKey)
      idempotency.current = { key: confirmationKey, id: crypto.randomUUID() };
    setBusy(true);
    setError('');
    try {
      const result = await veEnginePost<{ run?: VeOutreachRun; error?: string }>(
        `${VE_API}/projects/${projectId}/outreach/start`,
        {
          ...request,
          items: preflight.items.map(
            ({ hypothesis_id, base_id, template_id, preview_revision, segmentation_audit_id }) => ({
              hypothesis_id,
              base_id,
              template_id,
              preview_revision,
              segmentation_audit_id,
            }),
          ),
          idempotency_key: idempotency.current.id,
          confirmed_customer_approval: true,
        },
      );
      if (!result.ok || !result.data.run) {
        setError(result.data.error ?? 'Не удалось сохранить запуск');
        return;
      }
      onStarted(result.data.run);
    } catch {
      setError('Ответ о запуске не получен. Повторное нажатие безопасно: используем тот же запрос');
    } finally {
      setBusy(false);
    }
  };
  const preset = launch.presets?.find((p) => p.id === launch.presetId);
  if (!first) return <StatusBox tone="info">Дождитесь подготовки писем и одобрите базы на предыдущем шаге.</StatusBox>;
  return (
    <section className="space-y-5">
      <h2 className="ve2-h2">Клиент и отправители</h2>
      {launch.loadError ? <StatusBox tone="error">{launch.loadError}</StatusBox> : null}
      <label className="block ve2-label">
        Клиент
        <select
          aria-label="Клиент"
          className={`${HE.input} mt-2 w-full`}
          value={launch.presetId}
          disabled={!!launch.boundPresetId || busy}
          onChange={(event) => launch.setPresetId(event.target.value)}
        >
          <option value="">Выберите клиента</option>
          {launch.presets?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {preset ? (
        <p className={HE.muted}>
          {preset.instantly_account_label} ·{' '}
          {preset.mailbox_tags.map((t) => t.name).join(', ') || 'Сохранённый набор почт'} · отправителей:{' '}
          {preset.mailbox_count}
        </p>
      ) : null}
      {launch.canCreateClient && !launch.boundPresetId ? (
        <CreateClientPresetInline launch={launch} templateId={first.id} />
      ) : null}
      <DeliveryPlanBlock launch={launch} />
      <div className="border-t border-[var(--ve2-line)] pt-5 space-y-3">
        <h2 className="ve2-h2">Обзор запуска</h2>
        {!request ? (
          <p className={HE.muted}>Одобрите все выбранные базы, выберите клиента, проект и цель за период.</p>
        ) : !preflight && !error ? (
          <p role="status">Проверяем аудиторию и настройки отправки…</p>
        ) : null}
        {preflight?.items.map((item) => (
          <div key={item.hypothesis_id} className="border-b border-[var(--ve2-line)] py-3">
            <h3 className="ve2-h3">{titles[item.hypothesis_id] ?? 'Гипотеза'}</h3>
            <p className={HE.muted}>
              {item.status === 'ready'
                ? 'Готово к запуску'
                : item.status === 'working'
                  ? 'Проверяем получателей…'
                  : item.error}
            </p>
            {item.status === 'ready' ? (
              <p className={HE.muted}>
                Кампаний:{' '}
                {(item.summary?.segments?.filter((s) => s.count > 0).length ?? 0) +
                  (item.summary?.defaultGroup?.count ? 1 : 0)}{' '}
                · новых готовых контактов: {item.preview?.prospective_ready ?? '—'}
              </p>
            ) : null}
          </div>
        ))}
        {preflight?.ready ? (
          <p className={HE.muted}>
            Будем пополнять эти кампании в рабочие дни. Если отправители заняты или ещё не наступила дата начала,
            гипотеза останется в очереди.
          </p>
        ) : null}
        {error ? <StatusBox tone="error">{error}</StatusBox> : null}
        {error || preflight?.items.some((i) => i.status === 'blocked') ? (
          <button type="button" className={HE.btnGhost} onClick={() => setRetry((v) => v + 1)} disabled={busy}>
            Повторить проверку
          </button>
        ) : null}
        <label className="flex items-start gap-3 text-sm">
          <input
            type="checkbox"
            className="ve2-cbx mt-1"
            disabled={!preflight?.ready || busy}
            checked={!!confirmationKey && confirmedKey === confirmationKey}
            onChange={(event) => setConfirmedKey(event.target.checked ? confirmationKey : null)}
          />
          <span>Базы, письма и сегменты согласованы с заказчиком. Разрешаю создание кампаний и отправку.</span>
        </label>
        <button
          type="button"
          className={HE.btnPrimary}
          disabled={
            busy || !preflight?.ready || !confirmationKey || confirmedKey !== confirmationKey || !preset?.mailbox_count
          }
          onClick={() => void start()}
        >
          {busy ? 'Сохраняем запуск…' : 'Запустить аутрич'}
        </button>
      </div>
    </section>
  );
}
