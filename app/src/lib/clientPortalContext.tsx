'use client';

import { createContext, useContext } from 'react';
import type { ClientNavMode } from '@/lib/clientNav';
import type { ClientMarket } from '@/lib/engMarket';

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
  /**
   * Дашборд «2GIS + сигналы»: показывать ли пункт меню. Виден только клиенту
   * из gis_signal_pipeline_config.client_user_id. Грузится раз в layout.
   */
  gisSignalsEnabled: boolean;
  /**
   * Рынок профиля (profiles.market), приезжает вместе с portal-mode.
   * 'eng' → навигация сводится к ENG-кабинету; undefined/'ru' → обычный
   * RU-рендер без ENG-пункта. У демо не запрашивается (= RU-рендер).
   */
  market?: ClientMarket;
}

const ClientPortalContext = createContext<ClientPortalContextValue>({
  portalMode: 'manual',
  supportUnread: 0,
  mailboxesEnabled: false,
  gisSignalsEnabled: false,
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
