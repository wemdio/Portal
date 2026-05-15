'use client';

import { FileText } from 'lucide-react';
import { ClientBriefForm } from '@/components/client-brief/ClientBriefForm';

export default function ClientBriefPage() {
  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6 sm:mb-8 flex items-center gap-2.5">
        <span
          className="inline-flex items-center justify-center w-8 h-8 rounded-xl"
          style={{ background: 'rgba(245,158,11,0.12)', color: '#F59E0B' }}
        >
          <FileText className="h-4.5 w-4.5" />
        </span>
        <h1 className="text-xl sm:text-2xl font-extrabold">Бриф</h1>
      </div>
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
