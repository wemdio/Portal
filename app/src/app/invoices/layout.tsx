'use client';

import { type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useUser } from '@/lib/UserProvider';
import { isTechnician } from '@/lib/roles';

export default function InvoicesLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { userRole } = useUser();

  if (userRole === null) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-zinc-400 text-sm">Проверка доступа...</div>
      </div>
    );
  }

  if (!isTechnician(userRole)) {
    router.replace('/');
    return null;
  }

  return <>{children}</>;
}
