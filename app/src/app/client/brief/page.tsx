'use client';

import { ClientBriefForm } from '@/components/client-brief/ClientBriefForm';

export default function ClientBriefPage() {
  return (
    <div className="mx-auto max-w-4xl xl:max-w-6xl">
      <header className="mb-6 sm:mb-8">
        <h1 className="text-xl sm:text-2xl font-bold m-0" style={{ color: 'var(--cp-paper)' }}>
          Бриф
        </h1>
      </header>
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
