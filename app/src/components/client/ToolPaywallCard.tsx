'use client';

import Link from 'next/link';

/**
 * Карточка-заглушка на странице инструмента, когда доступ закрыт по оплате.
 * Показывается ВМЕСТО инструмента, чтобы клиент не заполнял форму впустую и
 * не ловил 403 при «Запустить». Ведёт на страницу «Тариф» для оплаты.
 *
 *  - 'unpaid'   — тариф не оплачен / истёк (inactive|expired).
 *  - 'awaiting' — подписка оформлена, но первая оплата ещё не поступила
 *                 (payment_locked && paid_at пусто).
 */
export function ToolPaywallCard({ variant }: { variant: 'unpaid' | 'awaiting' }) {
  const awaiting = variant === 'awaiting';
  return (
    <div className="neu-card p-6 sm:p-8 text-center">
      <p className="text-base sm:text-lg font-semibold m-0" style={{ color: 'var(--cp-paper)' }}>
        {awaiting ? 'Оформлена подписка — ожидается оплата' : 'Тариф не оплачен'}
      </p>
      <p className="mt-2 text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
        {awaiting
          ? 'Оплатите подписку, чтобы разблокировать инструменты.'
          : 'Чтобы запускать инструменты, оплатите тариф.'}
      </p>
      <Link
        href="/client/tariff"
        className="ds-btn-primary inline-flex items-center justify-center gap-2 px-5 py-2.5 mt-4 text-sm"
      >
        Перейти к оплате
      </Link>
    </div>
  );
}
