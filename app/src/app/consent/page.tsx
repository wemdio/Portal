import type { Metadata } from 'next';
import { CONSENT_TITLE, CONSENT_LEAD, CONSENT_SECTIONS } from '@/lib/legal/consentText';

export const metadata: Metadata = {
  title: 'Согласие на обработку персональных данных — outreachOS',
  description: CONSENT_TITLE,
};

/**
 * Public "Согласие на обработку персональных данных" page. Reachable from the
 * signup checkbox, the landing lead forms, and the /login footer. Rendered as a
 * bare standalone sheet (LayoutShell isLegalPage early-return). Middleware lists
 * /consent as a public path and a client-allowed path. Static text in
 * lib/legal/consentText.
 */
export default function ConsentPage() {
  return (
    <main className="min-h-screen bg-white px-6 py-8 text-gray-900 sm:py-12">
      <article className="mx-auto max-w-3xl">
        <h1 className="text-center text-xl font-bold uppercase tracking-wide sm:text-2xl">
          {CONSENT_TITLE}
        </h1>

        <div className="mt-6 space-y-3 text-[14px] leading-relaxed text-gray-700 sm:text-[15px]">
          {CONSENT_LEAD.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>

        <div className="mt-8 space-y-8">
          {CONSENT_SECTIONS.map((section) => (
            <section key={section.number} aria-labelledby={`consent-section-${section.number}`}>
              <h2 id={`consent-section-${section.number}`} className="text-base font-semibold sm:text-lg">
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
