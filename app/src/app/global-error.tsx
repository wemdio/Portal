'use client'

import { useMemo } from 'react';
import { normalizeLocale } from '@/lib/i18n';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const locale = useMemo(() => {
    if (typeof document === 'undefined') return 'ru';
    return normalizeLocale(document.documentElement.lang);
  }, []);

  return (
    <html lang={locale}>
      <body style={{ margin: 0, fontFamily: 'Arial, Helvetica, sans-serif' }}>
        <div
          style={{
            minHeight: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#f4f5f7',
            padding: '24px',
          }}
        >
          <div
            style={{
              maxWidth: 420,
              width: '100%',
              background: '#fff',
              borderRadius: 12,
              padding: '40px 32px',
              textAlign: 'center',
              boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
            }}
          >
            <div style={{ fontSize: 48, marginBottom: 16 }}>&#9888;</div>
            <h1 style={{ fontSize: 20, fontWeight: 600, color: '#18181b', margin: '0 0 8px' }}>
              {locale === 'en' ? 'Something went wrong' : 'Что-то пошло не так'}
            </h1>
            <p style={{ fontSize: 14, color: '#71717a', margin: '0 0 24px', lineHeight: 1.5 }}>
              {locale === 'en'
                ? 'An unexpected error occurred. Please try refreshing the page.'
                : 'Произошла непредвиденная ошибка. Попробуйте обновить страницу.'}
            </p>
            {error.digest && (
              <p style={{ fontSize: 12, color: '#a1a1aa', margin: '0 0 16px', fontFamily: 'monospace' }}>
                {error.digest}
              </p>
            )}
            <button
              onClick={reset}
              style={{
                padding: '10px 24px',
                fontSize: 14,
                fontWeight: 500,
                color: '#fff',
                background: '#18181b',
                border: 'none',
                borderRadius: 8,
                cursor: 'pointer',
              }}
            >
              {locale === 'en' ? 'Try again' : 'Попробовать снова'}
            </button>
          </div>
        </div>
      </body>
    </html>
  )
}
