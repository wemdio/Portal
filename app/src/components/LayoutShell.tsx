'use client';

import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { Sidebar } from './Sidebar';
import { useIsTma } from '@/lib/useIsTma';
import { TmaHeader } from './TmaHeader';

export function LayoutShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isSpreadsheetPage = pathname === '/tools/databases';
  const isRdpPage = pathname === '/tools/rdp';
  const isTma = useIsTma();

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
          <div className={`flex-shrink-0 hidden md:block ${isSpreadsheetPage ? 'w-3' : 'w-40'}`} />
        </>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col">
        {isTma && <TmaHeader />}
        <main className={`flex-1 flex flex-col min-h-0${isTma ? ' overflow-y-auto' : ''} ${contentPadding}${isTma ? ' tma-safe-bottom' : ''}`}>
          <div className={`${contentWidth}${isRdpPage ? ' flex flex-col flex-1 min-h-0' : ''}`}>{children}</div>
        </main>
      </div>
    </div>
  );
}
