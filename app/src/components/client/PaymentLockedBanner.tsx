'use client';

import { useState } from 'react';
import { usePaymentStatus } from '@/lib/clientBilling/usePaymentStatus';
import { clientApiFetch } from '@/lib/clientFetcher';
import { Loader2, Lock, ExternalLink } from 'lucide-react';

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function PaymentLockedBanner() {
  const status = usePaymentStatus();
  const [paying, setPaying] = useState(false);
  const [paymentUrl, setPaymentUrl] = useState<string | null>(null);
  const [payError, setPayError] = useState<string | null>(null);

  if (!status || !status.payment_locked) return null;

  const handlePay = async () => {
    setPaying(true);
    setPayError(null);
    try {
      const res = await clientApiFetch<{ payment_url: string }>('/payment');
      setPaymentUrl(res.payment_url);
    } catch (e) {
      setPayError(e instanceof Error ? e.message : 'Ошибка');
    } finally {
      setPaying(false);
    }
  };

  const isPaid = !!status.paid_at;
  const setupUntil = status.setup_until;

  return (
    <div
      role="alert"
      className="px-4 py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
      style={{
        background: 'var(--cp-surface-elev)',
        color: 'var(--cp-paper)',
        borderBottom: '1px solid var(--cp-red)',
      }}
    >
      <div className="flex items-center gap-2.5">
        <Lock className="h-4 w-4 flex-shrink-0" style={{ color: 'var(--cp-red)' }} />
        <div>
          {status.billing_mode === 'invoice' ? (
            <p className="text-sm font-semibold leading-tight" style={{ color: 'var(--cp-paper)' }}>
              Доступ заблокирован — ожидается оплата счёта
            </p>
          ) : isPaid ? (
            <p className="text-sm font-semibold leading-tight" style={{ color: 'var(--cp-paper)' }}>
              Оплата получена — доступ откроется {setupUntil ? fmtDate(setupUntil) : 'после завершения настройки'}
            </p>
          ) : (
            <p className="text-sm font-semibold leading-tight" style={{ color: 'var(--cp-paper)' }}>
              Необходима оплата для активации доступа
            </p>
          )}
          <p className="text-xs mt-0.5" style={{ color: 'var(--cp-paper-mute)' }}>
            {status.billing_mode === 'invoice'
              ? 'Как только вы оплатите выставленный счёт, доступ откроется автоматически.'
              : isPaid
              ? 'Команда настраивает ваш аккаунт. По вопросам — свяжитесь с менеджером.'
              : 'Оплатите подписку, чтобы начать работу с порталом.'}
          </p>
        </div>
      </div>

      {/* Payment button — only for autopayment mode if not yet paid */}
      {status.billing_mode === 'autopayment' && !isPaid && (
        <div className="flex-shrink-0">
          {paymentUrl ? (
            <a
              href={paymentUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold transition"
              style={{ background: 'var(--cp-paper)', color: 'var(--cp-ink)' }}
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Перейти к оплате
            </a>
          ) : (
            <button
              onClick={handlePay}
              disabled={paying}
              className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-xs font-semibold transition disabled:opacity-60"
              style={{ background: 'var(--cp-paper)', color: 'var(--cp-ink)' }}
            >
              {paying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {paying ? 'Создаём счёт...' : 'Оплатить подписку'}
            </button>
          )}
          {payError && (
            <p className="text-[11px] mt-1 text-right" style={{ color: 'var(--cp-paper-mute)' }}>{payError}</p>
          )}
        </div>
      )}
    </div>
  );
}
