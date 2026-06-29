'use client';

import { useEffect, useState } from 'react';
import { Mail } from 'lucide-react';
import { supabase } from '@/lib/supabaseClient';

/**
 * Read-only chip с email текущего залогиненного клиента. Полезно когда у
 * админа открыто несколько вкладок ЛК разных клиентов — без подписи легко
 * запутаться.
 */
export function AccountEmail() {
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (cancelled) return;
      setEmail(session?.user?.email ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!email) return null;

  return (
    <div className="inline-flex items-center gap-2 rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-300">
      <Mail size={14} className="text-neutral-500" />
      <span className="font-mono">{email}</span>
    </div>
  );
}
