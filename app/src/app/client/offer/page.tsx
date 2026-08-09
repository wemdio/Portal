import type { Metadata } from 'next';
import { OFFER_CLOSING, OFFER_PREAMBLE, OFFER_SECTIONS, OFFER_TITLE } from '@/lib/legal/offerText';

export const metadata: Metadata = {
  title: 'Договор оферты — Portal',
  description: OFFER_TITLE,
};

/**
 * In-portal version of the offer agreement. Sits inside /client/* so the
 * ClientLayout wraps it with the top bar + sidebar, and the .client-portal
 * cascade applies the same dark editorial theme as every other client page.
 *
 * The standalone /offer page (no chrome, white sheet) is kept for the /login
 * footer link — that flow has no Portal session, so a chromeless legal page
 * is the right surface. The sidebar item in CLIENT_NAV_OFFER points here, not
 * at /offer, so logged-in clients stay inside their workflow shell.
 *
 * All colours come from the `--cp-*` tokens so the page tracks any future
 * theme switching the same way every other client page does.
 */
export default function ClientOfferPage() {
  return (
    <article className="mx-auto max-w-3xl" style={{ color: 'var(--cp-text)' }}>
      <h1
        className="text-center text-xl font-bold uppercase tracking-wide sm:text-2xl"
        style={{ color: 'var(--cp-text)' }}
      >
        {OFFER_TITLE}
      </h1>

      <div
        className="mt-8 space-y-3 text-[14px] leading-relaxed sm:text-[15px]"
        style={{ color: 'var(--cp-text-m)' }}
      >
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
              style={{ color: 'var(--cp-text)' }}
            >
              {section.number ? `${section.number}. ` : ''}
              {section.title}
            </h2>
            <div
              className="mt-3 space-y-3 text-[14px] leading-relaxed sm:text-[15px]"
              style={{ color: 'var(--cp-text-m)' }}
            >
              {section.paragraphs.map((paragraph, idx) => (
                <p key={idx}>{paragraph}</p>
              ))}
            </div>
          </section>
        ))}
      </div>

      <div
        className="mt-8 space-y-3 text-[14px] leading-relaxed sm:text-[15px]"
        style={{ color: 'var(--cp-text-m)' }}
      >
        {OFFER_CLOSING.map((paragraph, idx) => (
          <p key={idx}>{paragraph}</p>
        ))}
      </div>
    </article>
  );
}
