import type { Metadata } from 'next';
import { PRIVACY_TITLE, PRIVACY_LEAD, PRIVACY_SECTIONS } from '@/lib/legal/privacyText';

export const metadata: Metadata = {
  title: 'Политика обработки персональных данных — outreachOS',
  description: PRIVACY_TITLE,
};

/**
 * Public "Политика обработки персональных данных" page — must be openly
 * available per 152-ФЗ. Reachable from the signup checkbox, lead forms, and the
 * /login footer. Bare standalone sheet (LayoutShell isLegalPage early-return);
 * middleware lists /privacy as public + client-allowed. Static text in
 * lib/legal/privacyText.
 */
export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-white px-6 py-8 text-gray-900 sm:py-12">
      <article className="mx-auto max-w-3xl">
        <h1 className="text-center text-xl font-bold uppercase tracking-wide sm:text-2xl">
          {PRIVACY_TITLE}
        </h1>

        <div className="mt-6 space-y-3 text-[14px] leading-relaxed text-gray-700 sm:text-[15px]">
          {PRIVACY_LEAD.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>

        <div className="mt-8 space-y-8">
          {PRIVACY_SECTIONS.map((section) => (
            <section key={section.number} aria-labelledby={`privacy-section-${section.number}`}>
              <h2 id={`privacy-section-${section.number}`} className="text-base font-semibold sm:text-lg">
                {section.number}. {section.title}
              </h2>
              <div className="mt-3 space-y-3 text-[14px] leading-relaxed text-gray-800 sm:text-[15px]">
                {section.paragraphs.map((paragraph, idx) => (
                  <p key={idx}>{paragraph}</p>
                ))}
              </div>
            </section>
          ))}
        </div>
      </article>
    </main>
  );
}
