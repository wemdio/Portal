'use client';

import type { ReactNode, InputHTMLAttributes } from 'react';
import { Inter, JetBrains_Mono } from 'next/font/google';

const inter = Inter({ subsets: ['latin', 'cyrillic'], display: 'swap', variable: '--font-inter' });
const jetbrainsMono = JetBrains_Mono({ subsets: ['latin', 'cyrillic'], display: 'swap', variable: '--font-mono' });

/**
 * Shared chrome for /login and /signup so both share ONE design code — the same
 * editorial-dark client-portal system (--cp-* tokens + neu-* classes) used inside
 * the app, instead of the two mismatched ad-hoc styles they had before. Wraps
 * content in .client-portal (dark bg + fonts + tokens) and centers a neu-card with
 * the outreachOS wordmark.
 */
export function AuthShell({
  title,
  subtitle,
  children,
  overlay,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  /** Full-screen overlay (e.g. a modal) rendered inside .client-portal but outside the card. */
  overlay?: ReactNode;
}) {
  return (
    <div
      className={`client-portal ${inter.variable} ${jetbrainsMono.variable}`}
      style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1.5rem 1rem' }}
    >
      <div className="neu-card w-full max-w-md p-6 sm:p-8">
        <div className="mb-6 text-center">
          <h1 className="text-2xl font-bold tracking-tight" style={{ color: 'var(--cp-paper)' }}>
            {title}
          </h1>
          {subtitle ? (
            <p className="mt-1 text-sm" style={{ color: 'var(--cp-paper-mute)' }}>
              {subtitle}
            </p>
          ) : null}
        </div>
        {children}
      </div>
      {overlay}
    </div>
  );
}

/**
 * One labelled input in the auth design (neu-input + a mono-ish caption label).
 * `optional` appends a muted "— по желанию"; `hint` renders a caption below.
 */
export function AuthField({
  label,
  optional,
  hint,
  ...inputProps
}: { label: string; optional?: boolean; hint?: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label htmlFor={inputProps.id} className="block text-xs font-medium mb-1" style={{ color: 'var(--cp-paper-mute)' }}>
        {label}
        {optional ? <span style={{ color: 'var(--cp-paper-faint)', fontWeight: 400 }}> — по желанию</span> : null}
      </label>
      <input {...inputProps} className="neu-input w-full px-3 py-2.5 text-sm" />
      {hint ? (
        <p className="mt-1 text-[11px]" style={{ color: 'var(--cp-paper-faint)' }}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
