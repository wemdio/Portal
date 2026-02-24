'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import { Monitor, AlertCircle, X } from 'lucide-react';

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

  const cardContent = (
    <>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <p className="text-base font-semibold text-gray-900">Удалённый рабочий стол</p>
            <span className="px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider bg-emerald-100 text-emerald-700 rounded">
              функционал для ПК
            </span>
          </div>
          <p className="text-sm text-gray-500">
            Подключение к удалённому ПК через браузер с бронированием.
          </p>
        </div>
        <Monitor className="h-8 w-8 text-emerald-500 group-hover:text-emerald-600 transition-colors" />
      </div>
      <div className="mt-4 text-sm font-medium text-emerald-600 group-hover:text-emerald-700">
        Открыть →
      </div>
    </>
  );

  const baseClass =
    'group rounded-2xl border-2 border-emerald-200 bg-gradient-to-br from-emerald-50 to-white p-6 transition';

  if (isPcViewport === null) {
    return (
      <div className={`${baseClass} animate-pulse`} aria-hidden>
        <div className="flex items-start justify-between gap-4">
          <div className="h-5 w-40 bg-emerald-100 rounded" />
          <div className="h-8 w-8 bg-emerald-100 rounded" />
        </div>
        <div className="mt-4 h-4 w-20 bg-emerald-100 rounded" />
      </div>
    );
  }

  if (isPcViewport) {
    return (
      <Link
        href={'/tools/rdp' as Route}
        className={`${baseClass} hover:shadow-md hover:border-emerald-300`}
      >
        {cardContent}
      </Link>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setShowPcOnlyModal(true)}
        className={`${baseClass} w-full text-left cursor-pointer hover:shadow-md hover:border-emerald-300 opacity-90 hover:opacity-100`}
      >
        {cardContent}
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
                Только с ПК
              </p>
            </div>
            <div className="px-6 pb-6 pt-2">
              <p className="text-gray-600 text-sm text-center">
                Воспользуйтесь данным функционалом только через ваш ПК.
              </p>
              <button
                type="button"
                onClick={() => setShowPcOnlyModal(false)}
                className="mt-4 w-full rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-amber-600 transition flex items-center justify-center gap-2"
              >
                <X className="h-4 w-4" />
                Понятно
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
