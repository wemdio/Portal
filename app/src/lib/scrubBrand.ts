/**
 * White-label scrub for CLIENT-facing text.
 *
 * We use Instantly as our email engine, but clients must never see the brand.
 * This replaces any "Instantly" / "Instantly.ai" mention (e.g. inside a dynamic
 * error message like `Instantly API 400: …`) with the neutral «система рассылки».
 *
 * Applied ONLY at client-facing boundaries (client API error responses + the
 * client fetcher). Internal logs and the admin/specialist UI keep the precise
 * wording, so this never touches debuggability. Dependency-free + server-free,
 * so both server routes and 'use client' modules can import it.
 */
export const scrubBrand = (s: string): string =>
  s.replace(/instantly(\.ai)?/gi, 'система рассылки');
