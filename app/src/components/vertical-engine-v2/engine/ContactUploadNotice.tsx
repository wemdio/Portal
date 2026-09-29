'use client';

import { useEffect, useRef, useState } from 'react';
import type { VeContactUploadStatus } from '@/lib/verticalEngineV2/contactUploadStatus';
import { VE_API, veEngineCall, veEnginePost } from './api';
import { HE } from './design';
import { StatusBox } from './ui';

export function ContactUploadNotice({ templateId }: { templateId: string }) {
  const [blocked, setBlocked] = useState<VeContactUploadStatus['blocked']>(null);
  const [campaigns, setCampaigns] = useState<VeContactUploadStatus['campaigns']>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(false);
  const requestVersion = useRef(0);
  const submitting = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    async function refresh() {
      if (submitting.current) return;
      const version = ++requestVersion.current;
      try {
        const response = await veEngineCall<VeContactUploadStatus & { error?: string }>(
          `${VE_API}/templates/${templateId}/upload`, { signal: controller.signal },
        );
        if (cancelled || version !== requestVersion.current) return;
        if (!response.ok) throw new Error(response.data.error ?? 'Не удалось проверить загрузку');
        setBlocked(response.data.blocked);
        setCampaigns(response.data.campaigns ?? []);
        if (response.data.blocked) setQueued(false);
        setError('');
      } catch (caught) {
        if (!cancelled && version === requestVersion.current) setError(caught instanceof Error ? caught.message : 'Не удалось проверить загрузку');
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => { cancelled = true; controller.abort(); clearInterval(timer); };
  }, [templateId]);

  async function retry() {
    if (!blocked || submitting.current) return;
    submitting.current = true;
    ++requestVersion.current;
    setBusy(true);
    setError('');
    try {
      const response = await veEnginePost<{ error?: string }>(`${VE_API}/templates/${templateId}/upload`, {
        action: 'retry', run_id: blocked.run_id, blocked_at: blocked.blocked_at,
      });
      if (!response.ok) throw new Error(response.data.error ?? 'Не удалось запросить дозаливку');
      setBlocked(null);
      setQueued(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Не удалось запросить дозаливку');
    } finally { submitting.current = false; setBusy(false); }
  }

  if (!blocked && !queued && !error && !campaigns?.length) return null;
  return <div className="space-y-2" aria-live="polite">
    {campaigns?.map(campaign => <div key={campaign.campaign_id} className="space-y-1">
      <p className="font-medium">{campaigns.length > 1 ? `${campaign.campaign_name}: ` : ''}{
        campaign.remote_status === 0 ? 'Черновик в Instantly — ожидает Start'
        : campaign.remote_status === 2 ? 'На паузе в Instantly — отправка выключена'
        : campaign.remote_status === 1 || campaign.remote_status === 4 ? 'Включена в Instantly — отправка по расписанию'
        : campaign.remote_status === 3 ? 'Текущая отправка завершена в Instantly'
        : campaign.remote_status == null ? 'Статус Instantly ещё не получен'
        : 'Кампания требует проверки в Instantly'}</p>
      <p className={HE.muted}>Загружено через Portal: {campaign.leads_count.toLocaleString('ru-RU')} контактов.
        {campaign.status_observed_at ? ` Последняя проверка: ${new Date(campaign.status_observed_at).toLocaleString('ru-RU')}.` : ''}</p>
      {campaign.remote_status === 0 || campaign.remote_status === 2 ? <p className={HE.muted}>
        Проверьте кампанию и нажмите Start в Instantly. Portal сам отправку не включает; после Start продолжит дозагрузку по плану.</p> : null}
    </div>)}
    {blocked ? <StatusBox tone="info">
      <p className="font-medium">Нет места для контактов в Instantly</p>
      <p className="mt-1">Загрузка новых контактов проекта приостановлена. Освободите место в рабочем пространстве Instantly или увеличьте тариф, затем запросите дозаливку.</p>
      <p className="mt-1">План проекта на {blocked.run_date.split('-').reverse().join('.')}: загружено {blocked.accepted.toLocaleString('ru-RU')}, осталось {blocked.pending.toLocaleString('ru-RU')}. Остаток сохранён и будет загружаться по дневному плану.</p>
      {blocked.uncertain > 0 ? <p className="mt-1">Результат для {blocked.uncertain.toLocaleString('ru-RU')} контактов не подтверждён. Повторная загрузка заблокирована до автоматической сверки с Instantly.</p> : null}
      <button type="button" className={`${HE.btnGhost} mt-3`} disabled={busy} onClick={() => void retry()}>
        {busy ? 'Запрашиваем дозаливку…' : 'Дозалить контакты проекта'}
      </button>
    </StatusBox> : queued ? <StatusBox tone="info">
      Дозаливка запрошена. При ближайшей автоматической проверке загрузка продолжится, если появилось свободное место. Обычно проверка проходит раз в 5 минут.
    </StatusBox> : null}
    {error ? <StatusBox tone="error">{error}</StatusBox> : null}
  </div>;
}
