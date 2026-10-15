'use client';

import Link from 'next/link';
import type { Route } from 'next';

/**
 * Граница ошибок ENG-кабинета (/client/eng/**). Без неё ошибка рендера на
 * любой странице кабинета падала в общую клиентскую границу
 * (app/client/error.tsx) с русским «Ошибка загрузки» / «К кампаниям» — а
 * «Кампании» RU-кабинета ENG-клиенту закрыты middleware. RU-граница не
 * меняется.
 *
 * Тексты только английские и только про то, что точно случилось: страница не
 * отрисовалась. Почему — граница не знает, поэтому не гадает. Выходы — те же,
 * что у отказов кабинета: «Try again» (перерисовать сегмент), начало кабинета
 * и Support (чат /client/support живёт вне /client/eng, эта граница его не
 * накрывает). Ни одного импорта из кабинета: граница обязана отрисоваться и
 * тогда, когда сломан сам кабинет.
 */
export default function ClientEngError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto flex min-h-[50vh] max-w-md items-center px-1">
      <div className="ds-card w-full p-6 sm:p-8">
        <h2 className="m-0 text-lg font-semibold" style={{ color: 'var(--cp-paper)' }}>
          This page could not be shown
        </h2>
        <p className="mt-2 text-sm leading-relaxed" style={{ color: 'var(--cp-text-m)' }}>
          Something went wrong while showing this page. Press «Try again». If it happens again, message Support.
        </p>
        {error.digest && (
          <p className="mt-3 text-[11px] ds-mono" style={{ color: 'var(--cp-text-l)' }}>
            Reference: {error.digest}
          </p>
        )}
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <button type="button" onClick={reset} className="ds-btn-primary inline-flex items-center gap-1.5 text-xs">
            Try again
          </button>
          <Link
            href={'/client/eng' as Route}
            prefetch={false}
            className="ds-btn-secondary inline-flex items-center gap-1.5 text-xs"
          >
            Back to Outreach
          </Link>
          <Link
            href={'/client/support' as Route}
            prefetch={false}
            className="ds-btn-secondary inline-flex items-center gap-1.5 text-xs"
          >
            Message Support
          </Link>
        </div>
      </div>
    </div>
  );
}
