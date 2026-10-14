'use client';

import { EngDoNotContact } from '@/components/client-eng/EngDoNotContact';

/**
 * /client/eng/do-not-contact — чёрный список ENG-клиента («Do not contact»,
 * пункт меню ENG-кабинета). Экран и его границы — шапка
 * components/client-eng/EngDoNotContact.tsx; тексты английские.
 */
export default function ClientEngDoNotContactPage() {
  return (
    <div className="mx-auto max-w-3xl">
      <EngDoNotContact />
    </div>
  );
}
