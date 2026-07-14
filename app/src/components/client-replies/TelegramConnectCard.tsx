'use client';

import { useCallback, useEffect, useState } from 'react';
import { Send } from 'lucide-react';
import { clientApiFetch } from '@/lib/clientFetcher';

interface TgStatus {
  bot_configured: boolean;
  linked: boolean;
  enabled: boolean;
  leads_only?: boolean;
  telegram_username: string | null;
}

/**
 * Self-serve «получать ответы в Telegram» для клиента.
 *
 * Рендерится только когда бот настроен на сервере (`bot_configured`), поэтому
 * фича может ехать тёмной. По «Подключить» открывает deep-link бота в новой
 * вкладке; когда клиент возвращается, focus-листенер обновляет статус.
 *
 * UX-решения (после жалоб клиентов «непонятно, какой режим включён»):
 *  - режим отправки — СЕГМЕНТ-КОНТРОЛ, а не кнопка-переключатель: оба варианта
 *    видны одновременно, активный подсвечен (.active). Кнопка с меткой одного
 *    режима не отвечала на вопрос «это текущее состояние или то, что включится
 *    по клику»;
 *  - под контролом — строка, что именно значит выбранный режим;
 *  - дефолтные критерии лида напечатаны В ИНТЕРФЕЙСЕ (PRODUCT.md: «объясняем в
 *    копи рядом, не прячем в тултипы»), а не подразумеваются.
 */

const DEFAULT_LEAD_RULE =
  'Человек увидел ваше предложение и проявил интерес: задал вопрос, спросил цену, предложил созвониться или начал обсуждать условия.';
const DEFAULT_NOT_LEAD_RULE =
  'Не лид: автоответы, «я в отпуске», отписки, отказы, уведомления о смене почты.';

export function TelegramConnectCard() {
  const [status, setStatus] = useState<TgStatus | null>(null);
  const [busy, setBusy] = useState(false);
  // «Свой промпт»: клиентские критерии лида для ИИ-разметки ответов.
  const [criteria, setCriteria] = useState('');
  const [criteriaOpen, setCriteriaOpen] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');

  const load = useCallback(async () => {
    try {
      const data = await clientApiFetch<TgStatus>('/telegram');
      setStatus(data);
    } catch {
      /* статус остаётся прежним, карточка просто не обновится */
    }
  }, []);

  // Критерии грузим ОДИН раз на маунте: load() дёргается на каждый
  // window-focus и на каждый тоггл, и рефетч перетирал бы несохранённый
  // черновик (alt-tab в Telegram гарантирован самим connect-флоу).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const c = await clientApiFetch<{ criteria: string }>('/lead-criteria');
        if (!cancelled) setCriteria(c.criteria ?? '');
      } catch {
        /* блок критериев просто останется пустым */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void load();
    const onFocus = () => void load();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  const saveCriteria = useCallback(async () => {
    setSaveState('saving');
    try {
      await clientApiFetch('/lead-criteria', {
        method: 'PUT',
        body: JSON.stringify({ criteria }),
      });
      setSaveState('saved');
      setTimeout(() => setSaveState('idle'), 2000);
    } catch {
      setSaveState('idle');
    }
  }, [criteria]);

  const connect = useCallback(async () => {
    setBusy(true);
    try {
      const data = await clientApiFetch<{ bot_configured: boolean; deeplink?: string }>(
        '/telegram/link-token',
      );
      if (data.deeplink) window.open(data.deeplink, '_blank', 'noopener,noreferrer');
    } catch {
      /* повторяемо: кнопка остаётся активной */
    } finally {
      setBusy(false);
    }
  }, []);

  const patch = useCallback(
    async (body: { enabled?: boolean; leads_only?: boolean }) => {
      setBusy(true);
      try {
        await clientApiFetch('/telegram', { method: 'PATCH', body: JSON.stringify(body) });
        await load();
      } catch {
        /* no-op */
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const disconnect = useCallback(async () => {
    setBusy(true);
    try {
      await clientApiFetch('/telegram', { method: 'DELETE' });
      await load();
    } catch {
      /* no-op */
    } finally {
      setBusy(false);
    }
  }, [load]);

  // Прячем, пока не знаем, что бот живой.
  if (!status || !status.bot_configured) return null;

  const hasCustomCriteria = criteria.trim().length > 0;
  const leadsOnly = !!status.leads_only;
  const handle = status.telegram_username ? `@${status.telegram_username.replace(/^@/, '')}` : null;

  return (
    <div className="neu-card px-4 py-3" style={{ marginBottom: '0.75rem' }}>
      {/* Шапка: состояние подключения и управление им. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <span
            className="neu-pill flex h-9 w-9 shrink-0 items-center justify-center"
            style={{ color: 'var(--cp-text-m)' }}
            aria-hidden
          >
            <Send className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <div className="text-sm font-semibold" style={{ color: 'var(--cp-text)' }}>
              Ответы в Telegram
            </div>
            <div className="text-xs" style={{ color: 'var(--cp-text-l)' }}>
              {!status.linked && 'Пришлём ответы лидов вам в Telegram, чтобы не заходить в портал за каждым.'}
              {status.linked && status.enabled && `Подключён${handle ? ` ${handle}` : ''}.`}
              {status.linked && !status.enabled && `Подключён${handle ? ` ${handle}` : ''}, уведомления выключены.`}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {status.linked ? (
            <>
              <button
                type="button"
                onClick={() => void patch({ enabled: !status.enabled })}
                disabled={busy}
                className="neu-pill px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
                style={{ color: 'var(--cp-text-m)' }}
              >
                {status.enabled ? 'Выключить' : 'Включить'}
              </button>
              <button
                type="button"
                onClick={() => void disconnect()}
                disabled={busy}
                className="neu-pill px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
                style={{ color: 'var(--cp-text-l)' }}
              >
                Отключить
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => void connect()}
              disabled={busy}
              className="neu-pill inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
              style={{ color: 'var(--cp-text)' }}
            >
              <Send className="h-3.5 w-3.5" />
              Подключить Telegram
            </button>
          )}
        </div>
      </div>

      {status.linked && (
        <div
          className="mt-3 space-y-3 pt-3"
          style={{ borderTop: '1px solid var(--cp-divider)' }}
        >
          {/* Что присылать: оба режима видны, активный подсвечен. */}
          {status.enabled && (
            <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:gap-3">
              <div
                role="group"
                aria-label="Что присылать в Telegram"
                className="inline-flex shrink-0 gap-0.5 rounded-md p-0.5"
                style={{ background: 'var(--cp-bg)', border: '1px solid var(--cp-divider)' }}
              >
                <button
                  type="button"
                  aria-pressed={!leadsOnly}
                  onClick={() => void patch({ leads_only: false })}
                  disabled={busy}
                  className={`neu-pill px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${!leadsOnly ? 'active' : ''}`}
                >
                  Все ответы
                </button>
                <button
                  type="button"
                  aria-pressed={leadsOnly}
                  onClick={() => void patch({ leads_only: true })}
                  disabled={busy}
                  className={`neu-pill px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${leadsOnly ? 'active' : ''}`}
                >
                  Только лидов
                </button>
              </div>
              <p className="text-xs" style={{ color: 'var(--cp-text-l)' }}>
                {leadsOnly
                  ? 'Присылаем только ответы, которые ИИ признал лидом. Остальные не пропадут: они останутся в списке ниже.'
                  : 'Присылаем каждый живой ответ. Автоответы и отписки не присылаем никогда.'}
              </p>
            </div>
          )}

          {/* Кого считаем лидом: правило напечатано, а не подразумевается. */}
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold" style={{ color: 'var(--cp-text-m)' }}>
                Кого считаем лидом
              </span>
              <span
                className="ds-mono rounded px-1.5 py-0.5 text-[10px] uppercase"
                style={{
                  color: hasCustomCriteria ? 'var(--cp-amber)' : 'var(--cp-text-l)',
                  border: `1px solid ${hasCustomCriteria ? 'var(--cp-amber)' : 'var(--cp-divider)'}`,
                }}
              >
                {hasCustomCriteria ? 'ваши критерии' : 'по умолчанию'}
              </span>
              <button
                type="button"
                onClick={() => setCriteriaOpen((v) => !v)}
                className="ml-auto text-xs font-semibold"
                style={{ color: 'var(--cp-text-m)' }}
                aria-expanded={criteriaOpen}
              >
                {criteriaOpen ? 'Свернуть' : hasCustomCriteria ? 'Изменить' : 'Задать свои'}
              </button>
            </div>

            <p className="mt-1 max-w-[70ch] text-xs" style={{ color: 'var(--cp-text-l)' }}>
              {hasCustomCriteria ? criteria : `${DEFAULT_LEAD_RULE} ${DEFAULT_NOT_LEAD_RULE}`}
            </p>

            {criteriaOpen && (
              <div className="mt-2 space-y-2">
                <textarea
                  value={criteria}
                  onChange={(e) => setCriteria(e.target.value)}
                  rows={3}
                  maxLength={2000}
                  aria-label="Свои критерии лида"
                  placeholder="Например: лид, если спросили цену, попросили подробности или предложили созвониться. Просто контакт другого сотрудника лидом не считаем."
                  className="w-full rounded-md px-2.5 py-1.5 text-xs"
                  style={{
                    background: 'var(--cp-bg)',
                    color: 'var(--cp-text)',
                    border: '1px solid var(--cp-divider-strong)',
                  }}
                />
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void saveCriteria()}
                    disabled={saveState === 'saving'}
                    className="neu-pill px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
                    style={{ color: 'var(--cp-text)' }}
                  >
                    {saveState === 'saving' ? 'Сохраняем' : saveState === 'saved' ? 'Сохранено' : 'Сохранить'}
                  </button>
                  <p className="text-xs" style={{ color: 'var(--cp-text-l)' }}>
                    Оставьте пустым, чтобы вернуться к правилам по умолчанию. Изменения применятся в течение пяти минут.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
