import { DatabaseSpreadsheet } from '@/components/DatabaseSpreadsheet';
import { Suspense } from 'react';

export default function DatabasesPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Загрузка…</div>}>
      <DatabaseSpreadsheet />
    </Suspense>
  );
}
