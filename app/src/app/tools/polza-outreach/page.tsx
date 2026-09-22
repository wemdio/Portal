import { InDevelopmentGate } from '@/components/InDevelopmentGate';
import { PolzaOutreachView } from '@/components/parsers/PolzaOutreachView';

export default function PolzaOutreachPage() {
  return (
    <InDevelopmentGate toolId="polza-outreach">
      {/* zoom 0.85 — тот же масштаб, в котором вьюха жила вкладкой «Парсеров»:
          у неё широкая таблица воронки и разворот письма, и в обычном масштабе
          колонки не помещаются. Переезд на свою страницу масштаб не меняет. */}
      <div className="space-y-6" style={{ zoom: 0.85 }}>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Англ. аутрич (авто)</h1>
          <p className="mt-1 text-sm text-gray-500">
            Свежие вакансии SDR/BDR → компания и почта → цепочка из четырёх писем на английском
          </p>
        </div>
        <PolzaOutreachView />
      </div>
    </InDevelopmentGate>
  );
}
