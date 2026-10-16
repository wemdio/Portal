import { Suspense } from 'react';
import { EngClientsList } from '@/components/admin-eng/EngClientsList';
import { PortalSpinner } from '@/components/PortalSpinner';

/**
 * Раздел админки «Английские клиенты» — список аккаунтов английского кабинета
 * (app.outreachos.xyz). Доступ — только админ (app/admin/layout.tsx и
 * middleware). `Suspense` обязателен: список читает страницу, фильтр и поиск
 * из адреса через `useSearchParams`.
 */
export default function EngClientsPage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-10"><PortalSpinner /></div>}>
      <EngClientsList />
    </Suspense>
  );
}
