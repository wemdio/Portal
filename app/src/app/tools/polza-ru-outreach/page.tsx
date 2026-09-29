import { Suspense } from 'react';
import { InDevelopmentGate } from '@/components/InDevelopmentGate';
import { OutreachTabs } from '@/components/senderLeads/OutreachTabs';
import { PolzaRuOutreachView } from '@/components/polzaRuOutreach/PolzaRuOutreachView';

export default function PolzaRuOutreachPage() {
  return (
    <InDevelopmentGate toolId="polza-ru-outreach">
      <div className="space-y-6" style={{ zoom: 0.85 }}>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Наш автоаутрич</h1>
          <p className="mt-1 text-sm text-gray-500">
            Русский аутрич Polza: найм SDR, автоматизация аутрича, сигналы → компания и почта → готовая цепочка писем
          </p>
        </div>
        {/* Suspense — OutreachTabs читает вкладку из адреса (?tab=qualification)
            через useSearchParams; без границы ожидания сборка не пререндерит страницу. */}
        <Suspense fallback={null}>
          <OutreachTabs folderKey="auto_ru">
            <PolzaRuOutreachView />
          </OutreachTabs>
        </Suspense>
      </div>
    </InDevelopmentGate>
  );
}
