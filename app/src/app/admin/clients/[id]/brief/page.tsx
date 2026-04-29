'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { supabase } from '@/lib/supabaseClient';
import { useUser } from '@/lib/UserProvider';
import { isAdmin } from '@/lib/roles';
import { ClientBriefForm } from '@/components/client-brief/ClientBriefForm';
import type { UserProfile } from '@/types';

export default function AdminClientBriefPage() {
  const params = useParams<{ id: string }>();
  const clientUserId = params?.id ?? '';
  const { userRole } = useUser();
  const admin = isAdmin(userRole);

  const [client, setClient] = useState<UserProfile | null>(null);

  useEffect(() => {
    if (!admin || !clientUserId) return;
    void (async () => {
      const { data } = await supabase.from('profiles').select('*').eq('id', clientUserId).single();
      setClient((data as UserProfile | null) ?? null);
    })();
  }, [admin, clientUserId]);

  if (!admin) {
    return (
      <div className="max-w-4xl mx-auto py-10">
        <div className="bg-red-50 border border-red-200 rounded-lg p-6">
          <h2 className="text-lg font-semibold text-red-800">Доступ запрещён</h2>
          <p className="text-red-600">Только администраторы могут управлять брифом клиента.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-10">
      <div className="mb-6">
        <Link href="/admin/users" className="text-sm font-medium text-blue-600 hover:text-blue-700">
          ← Назад к пользователям
        </Link>
      </div>

      <ClientBriefForm
        endpoint={`/api/admin/clients/${clientUserId}/brief`}
        title="Бриф клиента"
        subtitle={client?.full_name || client?.email || clientUserId}
        auditPrefix="admin.client-brief"
      />
    </div>
  );
}
