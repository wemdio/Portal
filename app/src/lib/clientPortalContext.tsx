'use client';

import { createContext, useContext } from 'react';
import type { ClientNavMode } from '@/lib/clientNav';

interface ClientPortalContextValue {
  portalMode: ClientNavMode;
  /**
   * Непрочитанные сообщения поддержки — для бейджа рядом с «Поддержка».
   * Поллится один раз в layout и раздаётся сюда, чтобы оба инстанса навигации
   * (десктоп-сайдбар + мобильный drawer) не дублировали таймер.
   */
  supportUnread: number;
  /** BYO-почты (пилот): показывать ли пункт «Почты». Грузится раз в layout. */
  mailboxesEnabled: boolean;
}

const ClientPortalContext = createContext<ClientPortalContextValue>({
  portalMode: 'manual',
  supportUnread: 0,
  mailboxesEnabled: false,
});

export function ClientPortalProvider({
  value,
  children,
}: {
  value: ClientPortalContextValue;
  children: React.ReactNode;
}) {
  return (
    <ClientPortalContext.Provider value={value}>
      {children}
    </ClientPortalContext.Provider>
  );
}

export function useClientPortalContext(): ClientPortalContextValue {
  return useContext(ClientPortalContext);
}
