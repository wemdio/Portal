import { Suspense } from 'react';
import { EngClientsList } from '@/components/admin-eng/EngClientsList';

/**
 * Раздел админки «Английские клиенты» — список аккаунтов английского кабинета
 * (app.outreachos.xyz). Доступ — только админ (app/admin/layout.tsx и
 * middleware). `Suspense` обязателен: список читает страницу, фильтр и поиск
 * из адреса через `useSearchParams`.
 */
export default function EngClientsPage() {
  return (
    <Suspense fallback={<div className="py-10 text-center text-sm text-gray-400">Загрузка…</div>}>
      <EngClientsList />
    </Suspense>
  );
}
