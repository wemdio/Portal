'use client';

import { useCallback, useEffect, useState } from 'react';
import { Send } from 'lucide-react';
import { clientApiFetch } from '@/lib/clientFetcher';

interface TgStatus {
  bot_configured: boolean;
  linked: boolean;
  enabled: boolean;
  telegram_username: string | null;
}

/**
 * Self-serve «get reply notifications in Telegram» card for the client.
 *
 * Renders nothing until the dedicated replies bot is configured on the server
 * (`bot_configured`), so the feature can ship dark. On connect it opens the
 * bot deep-link in a new tab; when the client returns, the window-focus
 * listener refetches status and the card flips to the connected state.
 */
export function TelegramConnectCard() {
  const [status, setStatus] = useState<TgStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await clientApiFetch<TgStatus>('/telegram');
      setStatus(data);
    } catch {
      /* status stays as-is; card just won't update */
    }
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

  const connect = useCallback(async () => {
    setBusy(true);
    try {
      const data = await clientApiFetch<{ bot_configured: boolean; deeplink?: string }>(
        '/telegram/link-token',
      );
      if (data.deeplink) {
        window.open(data.deeplink, '_blank', 'noopener,noreferrer');
      }
    } catch {
      /* retryable — button stays active */
    } finally {
      setBusy(false);
    }
  }, []);

  const setEnabled = useCallback(
    async (enabled: boolean) => {
      setBusy(true);
      try {
        await clientApiFetch('/telegram', { method: 'PATCH', body: JSON.stringify({ enabled }) });
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

  // Hidden until we know the bot is live.
  if (!status || !status.bot_configured) return null;

  return (
    <div
      className="neu-card flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
      style={{ marginBottom: '0.75rem' }}
    >
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
            {status.linked
              ? status.enabled
                ? `Подключено${status.telegram_username ? ` · ${status.telegram_username}` : ''} — присылаем текст ответов сюда`
                : `Подключено${status.telegram_username ? ` · ${status.telegram_username}` : ''}, уведомления выключены`
              : 'Получайте текст ответов лидов прямо в Telegram'}
          </div>
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-2">
        {status.linked ? (
          <>
            <button
              type="button"
              onClick={() => void setEnabled(!status.enabled)}
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
  );
}
