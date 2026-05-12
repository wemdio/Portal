'use client';

import { ClientBriefForm } from '@/components/client-brief/ClientBriefForm';

export default function ClientBriefPage() {
  return (
    <div className="mx-auto max-w-4xl">
      <ClientBriefForm
        endpoint="/api/client/brief"
        hypothesesEndpoint="/api/client/brief/hypotheses"
        autofillEndpoint="/api/client/brief/autofill"
        title="Бриф"
        subtitle="Заполните бриф один раз — мы используем его для AI-инструментов (Оценка ЦА, генерация гипотез и др.)."
        auditPrefix="client.brief"
      />
    </div>
  );
}
