'use client';

import { createContext, useContext } from 'react';
import type { ClientNavMode } from '@/lib/clientNav';

interface ClientPortalContextValue {
  portalMode: ClientNavMode;
}

const ClientPortalContext = createContext<ClientPortalContextValue>({
  portalMode: 'manual',
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
