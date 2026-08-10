import type { Metadata } from 'next';
import { OFFER_CLOSING, OFFER_PREAMBLE, OFFER_SECTIONS, OFFER_TITLE } from '@/lib/legal/offerText';

export const metadata: Metadata = {
  title: 'Договор оферты — Portal',
  description: OFFER_TITLE,
};

/**
 * Public offer agreement page. Reachable from /login (footer button) and the
 * client portal sidebar; rendered as a bare standalone sheet via the
 * isOfferPage early-return in LayoutShell — no TopNav, no client sidebar, no
 * container chrome. Just the legal text on a white page.
 *
 * Middleware adds /offer to its public-paths list (auth bypass) and to the
 * client-allowed list (so client-role users aren't kicked back to /client).
 *
 * Server component — content is fully static and lives in lib/legal/offerText.
 */
export default function OfferPage() {
  return (
    <main className="min-h-screen bg-white px-6 py-8 text-gray-900 sm:py-12">
      <article className="mx-auto max-w-3xl">
        <h1 className="text-center text-xl font-bold uppercase tracking-wide sm:text-2xl">
          {OFFER_TITLE}
        </h1>

        <div className="mt-8 space-y-3 text-[14px] leading-relaxed text-gray-800 sm:text-[15px]">
          {OFFER_PREAMBLE.map((paragraph, idx) => (
            <p key={idx}>{paragraph}</p>
          ))}
        </div>

        <div className="mt-8 space-y-8">
          {OFFER_SECTIONS.map((section) => (
            <section
              key={section.number || section.title}
              aria-labelledby={`offer-section-${section.number || 'terms'}`}
            >
              <h2
                id={`offer-section-${section.number || 'terms'}`}
                className="text-base font-semibold sm:text-lg"
              >
                {section.number ? `${section.number}. ` : ''}
                {section.title}
              </h2>
              <div className="mt-3 space-y-3 text-[14px] leading-relaxed text-gray-800 sm:text-[15px]">
                {section.paragraphs.map((paragraph, idx) => (
                  <p key={idx}>{paragraph}</p>
                ))}
              </div>
            </section>
          ))}
        </div>

        <div className="mt-8 space-y-3 text-[14px] leading-relaxed text-gray-600 sm:text-[15px]">
          {OFFER_CLOSING.map((paragraph, idx) => (
            <p key={idx}>{paragraph}</p>
          ))}
        </div>
      </article>
    </main>
  );
}
