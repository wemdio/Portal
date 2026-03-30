'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { getPortalPageSectionTitle } from '@/lib/pageTitle';

/** Sets `document.title` from the current path and main nav section names. */
export function PortalDocumentTitle() {
  const pathname = usePathname();

  useEffect(() => {
    document.title = getPortalPageSectionTitle(pathname);
  }, [pathname]);

  return null;
}
