'use client';

import Link from 'next/link';
import { AdminTracesPanel } from '@/components/AdminTracesPanel';
import { useIsTma } from '@/lib/useIsTma';

export default function AdminTracesPage() {
  const isTma = useIsTma();

  return (
    <div className={`max-w-6xl mx-auto px-4 ${isTma ? 'py-6 text-sm leading-relaxed' : 'py-10'}`}>
      <div className="mb-6">
        <Link href="/admin" className="text-sm font-medium text-blue-600 hover:text-blue-700">
          ← Назад в админку
        </Link>
      </div>

      <AdminTracesPanel />
    </div>
  );
}

