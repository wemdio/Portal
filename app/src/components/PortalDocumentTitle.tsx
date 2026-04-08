'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { getPortalPageSectionTitle } from '@/lib/pageTitle';
import { useUser } from '@/lib/UserProvider';

/** Sets `document.title` from the current path and main nav section names. */
export function PortalDocumentTitle() {
  const pathname = usePathname();
  const { locale } = useUser();

  useEffect(() => {
    document.title = getPortalPageSectionTitle(pathname, locale);
  }, [locale, pathname]);

  return null;
}
