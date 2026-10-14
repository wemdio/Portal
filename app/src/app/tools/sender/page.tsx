import { Suspense } from 'react';
import { InDevelopmentGate } from '@/components/InDevelopmentGate';
import { SenderView } from '@/components/sender/SenderView';

/**
 * `Suspense` обязателен: SenderView читает вкладку и кампанию из адреса
 * (?tab=campaigns&campaign=<id>) через `useSearchParams`, а без границы
 * ожидания сборка отказывается пререндерить страницу.
 */
export default function SenderPage() {
  return (
    <InDevelopmentGate toolId="sender">
      <Suspense fallback={null}>
        <SenderView />
      </Suspense>
    </InDevelopmentGate>
  );
}
