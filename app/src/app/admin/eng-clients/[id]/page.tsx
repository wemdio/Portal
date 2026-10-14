'use client';

import { useParams } from 'next/navigation';
import { EngClientCard } from '@/components/admin-eng/EngClientCard';

/** Карточка клиента английского кабинета (раздел «Английские клиенты»). */
export default function EngClientCardPage() {
  const params = useParams<{ id: string }>();
  const id = typeof params?.id === 'string' ? params.id : '';
  return <EngClientCard key={id} userId={id} />;
}
