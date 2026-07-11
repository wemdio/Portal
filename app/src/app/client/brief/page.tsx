'use client';

import { ClientBriefForm } from '@/components/client-brief/ClientBriefForm';
import { useDemoMode } from '@/lib/clientDemo/useDemoMode';
import { DemoPersonalizePanel } from '@/components/client/DemoPersonalizePanel';

export default function ClientBriefPage() {
  // Демо: над фикстурным брифом «Орбиты» — панель «вставьте свой сайт»
  // (AI-разбор: бриф → гипотезы → цепочка). Реальным клиентам не показывается.
  const isDemo = useDemoMode();

  return (
    <div className="mx-auto max-w-4xl xl:max-w-6xl">
      <header className="mb-6 sm:mb-8">
        <h1 className="text-xl sm:text-2xl font-bold m-0" style={{ color: 'var(--cp-paper)' }}>
          Бриф
        </h1>
      </header>
      {isDemo === true && <DemoPersonalizePanel />}
      <ClientBriefForm
        endpoint="/api/client/brief"
        hypothesesEndpoint="/api/client/brief/hypotheses"
        autofillEndpoint="/api/client/brief/autofill"
        subtitle="Заполните бриф один раз — мы используем его для AI-инструментов (Оценка ЦА, генерация гипотез и др.)."
        auditPrefix="client.brief"
      />
    </div>
  );
}
