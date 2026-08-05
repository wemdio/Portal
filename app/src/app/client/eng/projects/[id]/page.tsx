'use client';

import { useParams } from 'next/navigation';
import { EngProjectWizard } from '@/components/client-eng/EngProjectWizard';

/**
 * /client/eng/projects/[id] — мастер проекта ENG-кабинета
 * (Brief → Verticals → Letters → Bases & Launch).
 */
export default function ClientEngProjectPage() {
  const params = useParams<{ id: string }>();
  const projectId = typeof params?.id === 'string' ? params.id : '';

  if (!projectId) return null;
  return (
    <div className="mx-auto max-w-4xl xl:max-w-6xl">
      <EngProjectWizard projectId={projectId} />
    </div>
  );
}
