'use client';

import { usePathname } from 'next/navigation';
import { Sidebar } from './Sidebar';

export function LayoutShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isSpreadsheetPage = pathname === '/tools/databases';

  return (
    <div className="flex h-screen overflow-hidden bg-gray-100">
      <Sidebar collapsed={isSpreadsheetPage} />
      <main className={`flex-1 overflow-y-auto ${isSpreadsheetPage ? 'p-1.5' : 'p-8'}`}>
        {children}
      </main>
    </div>
  );
}
