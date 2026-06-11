/** @jest-environment node */
import { deriveCompanyName, domainRoot } from '@/lib/enrich/extractors/deriveCompanyName';

it('prefers og:site_name', () => {
  const html = '<head><meta property="og:site_name" content="Acme Corp"><title>Главная — Acme</title></head>';
  expect(deriveCompanyName(html, 'https://acme.ru')).toBe('Acme Corp');
});

it('takes the first non-generic title segment', () => {
  const html = '<head><title>Главная — Lidorium — Агентство</title></head>';
  expect(deriveCompanyName(html, 'https://lidorium.ru')).toBe('Lidorium');
});

it('falls back to the domain root when no name on page', () => {
  expect(deriveCompanyName('', 'https://www.syntonic.ru/contacts')).toBe('syntonic');
});

it('domainRoot strips www and tld', () => {
  expect(domainRoot('https://www.komus-contact.ru/')).toBe('komus-contact');
  expect(domainRoot('bad input')).toBe('');
});
