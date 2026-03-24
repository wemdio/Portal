'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';

const ALLOWED_ROLES = ['technician', 'lead', 'admin', 'director'];

export default function BillingCalendarLayout({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [allowed, setAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function check() {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.user) {
        if (!cancelled) router.replace('/login');
        return;
      }

      const { data: profile } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', session.user.id)
        .single();

      if (cancelled) return;

      if (!profile || !ALLOWED_ROLES.includes(profile.role)) {
        router.replace('/');
      } else {
        setAllowed(true);
      }
    }

    void check();
    return () => { cancelled = true; };
  }, [router]);

  if (allowed === null) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-gray-400 text-sm">Проверка доступа...</div>
      </div>
    );
  }

  return <>{children}</>;
}
