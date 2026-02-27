'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { Monitor, AlertCircle } from 'lucide-react';

const PC_BREAKPOINT = 768; // md в Tailwind

export function RdpToolCard() {
  const [isPcViewport, setIsPcViewport] = useState<boolean | null>(null);
  const [showPcOnlyModal, setShowPcOnlyModal] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia(`(min-width: ${PC_BREAKPOINT}px)`);
    const update = () => setIsPcViewport(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, []);

  const cardContentPc = (
    <>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-base font-semibold text-gray-900">Удалённый рабочий стол</p>
          <p className="text-sm text-gray-500 mt-0.5">
            Подключение к удалённому ПК через браузер.
          </p>
        </div>
        <Monitor className="h-8 w-8 text-gray-400 group-hover:text-blue-600 transition-colors shrink-0" />
      </div>
      <div className="mt-4 text-sm font-medium text-blue-600 group-hover:text-blue-700">
        Открыть →
      </div>
    </>
  );

  const cardContentMobile = (
    <>
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-base font-semibold text-gray-500">Удалённый рабочий стол</p>
          <p className="text-sm text-gray-400 mt-0.5">
            Подключение к удалённому ПК через браузер.
          </p>
        </div>
        <Monitor className="h-8 w-8 text-gray-400 shrink-0" />
      </div>
      <div className="mt-4 text-sm font-medium text-gray-400">
        Открыть →
      </div>
    </>
  );

  const baseClassPc =
    'group rounded-2xl border border-gray-200 bg-white p-6 transition hover:shadow-md hover:border-gray-300 w-full min-w-0 h-full flex flex-col';
  const baseClassMobile =
    'rounded-2xl border-2 border-gray-200 bg-gray-50 p-6 w-full h-full min-h-0 text-left cursor-pointer transition flex flex-col';

  if (isPcViewport === null) {
    return (
      <div className={`${baseClassMobile} animate-pulse min-h-[140px]`} aria-hidden>
        <div className="flex items-start justify-between gap-4">
          <div className="h-5 w-40 bg-gray-200 rounded" />
          <div className="h-8 w-8 bg-gray-200 rounded shrink-0" />
        </div>
        <div className="mt-4 h-4 w-20 bg-gray-200 rounded" />
      </div>
    );
  }

  if (isPcViewport) {
    return (
      <Link href={'/tools/rdp' as Route} className={baseClassPc}>
        {cardContentPc}
      </Link>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setShowPcOnlyModal(true)}
        className={baseClassMobile}
      >
        {cardContentMobile}
      </button>
      {showPcOnlyModal && (
        <div
          className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4"
          onClick={() => setShowPcOnlyModal(false)}
          role="dialog"
          aria-modal="true"
          aria-labelledby="rdp-pc-only-title"
        >
          <div
            className="bg-white rounded-2xl shadow-2xl max-w-sm w-full overflow-hidden border border-amber-100"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="bg-amber-50 px-6 pt-6 pb-4 flex flex-col items-center">
              <div className="h-12 w-12 rounded-full bg-amber-100 flex items-center justify-center mb-3">
                <AlertCircle className="h-6 w-6 text-amber-600" />
              </div>
              <p id="rdp-pc-only-title" className="text-amber-900 font-semibold text-center">
                Только с ПК/ноутбука
              </p>
            </div>
            <div className="px-6 pb-6 pt-2">
              <p className="text-gray-600 text-sm text-center">
                Воспользуйтесь данным функционалом через ваш ПК или ноутбук.
              </p>
              <button
                type="button"
                onClick={() => setShowPcOnlyModal(false)}
                className="mt-4 w-full rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-amber-600 transition flex items-center justify-center gap-2"
              >
                Понятно
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
