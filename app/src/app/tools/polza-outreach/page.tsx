import { Suspense } from 'react';
import { InDevelopmentGate } from '@/components/InDevelopmentGate';
import { OutreachTabs } from '@/components/senderLeads/OutreachTabs';
import { PolzaOutreachView } from '@/components/parsers/PolzaOutreachView';

export default function PolzaOutreachPage() {
  return (
    <InDevelopmentGate toolId="polza-outreach">
      {/* zoom 0.85 — тот же масштаб, в котором вьюха жила вкладкой «Парсеров»:
          у неё широкая таблица воронки и разворот письма, и в обычном масштабе
          колонки не помещаются. Переезд на свою страницу масштаб не меняет. */}
      <div className="space-y-6" style={{ zoom: 0.85 }}>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Английский автоаутрич</h1>
          <p className="mt-1 text-sm text-gray-500">
            Найм в sales/GTM и стартапы YC → Lead Score → почта → цепочка из четырёх писем на английском
          </p>
        </div>
        {/* Suspense — OutreachTabs читает вкладку из адреса (?tab=qualification)
            через useSearchParams; без границы ожидания сборка не пререндерит страницу. */}
        <Suspense fallback={null}>
          <OutreachTabs folderKey="auto_en">
            <PolzaOutreachView />
          </OutreachTabs>
        </Suspense>
      </div>
    </InDevelopmentGate>
  );
}
