'use client';

import { type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useUser } from '@/lib/UserProvider';

export default function AdminLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { userRole } = useUser();

  if (userRole === null) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-gray-400 text-sm">Проверка доступа...</div>
      </div>
    );
  }

  if (userRole !== 'admin') {
    router.replace('/');
    return null;
  }

  return <>{children}</>;
}
