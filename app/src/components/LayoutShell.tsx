'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Sidebar } from './Sidebar';
import { useIsTma } from '@/lib/useIsTma';
import { TmaHeader } from './TmaHeader';

export function LayoutShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isSpreadsheetPage = pathname === '/tools/databases';
  const isTma = useIsTma();
  const [tmaMenuOpen, setTmaMenuOpen] = useState(false);

  useEffect(() => {
    if (!isTma) return;
    document.body.style.overflow = '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [isTma, pathname]);

  const contentPadding = isTma
    ? (isSpreadsheetPage ? 'p-1.5' : 'px-4 py-4')
    : (isSpreadsheetPage ? 'p-1.5' : 'p-8');
  const contentWidth = 'w-full';

  const shellClassName = isTma
    ? 'flex min-h-screen overflow-hidden'
    : 'flex min-h-screen overflow-x-hidden';

  return (
    <div
      className={shellClassName}
      style={{
        minHeight: 'var(--app-viewport-height, 100vh)',
      }}
    >
      {!isTma ? (
        <>
          <Sidebar collapsed={isSpreadsheetPage} isTma={false} />
          <div className={`flex-shrink-0 hidden md:block ${isSpreadsheetPage ? 'w-3' : 'w-60'}`} />
        </>
      ) : (
        <Sidebar
          isTma
          mobileOpen={tmaMenuOpen}
          onMobileClose={() => setTmaMenuOpen(false)}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        {isTma && <TmaHeader onMenuClick={() => setTmaMenuOpen(true)} />}
        <main className={`flex-1${isTma ? ' overflow-y-auto' : ''} ${contentPadding}${isTma ? ' safe-bottom' : ''}`}>
          <div className={contentWidth}>{children}</div>
        </main>
      </div>
    </div>
  );
}
