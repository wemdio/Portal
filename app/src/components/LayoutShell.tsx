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

  useEffect(() => {
    // Close the drawer on route change in TMA
    if (!isTma) return;
    setTmaMenuOpen(false);
  }, [isTma, pathname]);

  const contentPadding = isTma
    ? (isSpreadsheetPage ? 'p-1.5' : 'px-4 py-4')
    : (isSpreadsheetPage ? 'p-1.5' : 'p-8');
  const contentWidth = 'w-full';

  return (
    <div
      className="flex min-h-screen overflow-hidden"
      style={{
        minHeight: 'var(--app-viewport-height, 100vh)',
      }}
    >
      {!isTma ? (
        <Sidebar collapsed={isSpreadsheetPage} isTma={false} />
      ) : (
        <Sidebar
          isTma
          mobileOpen={tmaMenuOpen}
          onMobileClose={() => setTmaMenuOpen(false)}
        />
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        {isTma && <TmaHeader onMenuClick={() => setTmaMenuOpen(true)} />}
        <main className={`flex-1 overflow-y-auto ${contentPadding}${isTma ? ' safe-bottom' : ''}`}>
          <div className={contentWidth}>{children}</div>
        </main>
      </div>
    </div>
  );
}
