import {
  extractEmailsAdvanced,
  extractEmailsFromHtmlAdvanced,
  filterJunkEmails,
  decodeHtmlEntitiesInEmail,
  extractJsonLdEmails,
  decodeCloudflareEmail,
} from '@/lib/enrich/emailScraper';

describe('emailScraper — advanced extraction', () => {
  describe('decodeHtmlEntitiesInEmail', () => {
    it('decodes &#64; to @', () => {
      expect(decodeHtmlEntitiesInEmail('user&#64;example.com')).toBe('user@example.com');
    });

    it('decodes &#x40; to @', () => {
      expect(decodeHtmlEntitiesInEmail('user&#x40;example.com')).toBe('user@example.com');
    });

    it('decodes &#46; to .', () => {
      expect(decodeHtmlEntitiesInEmail('user@example&#46;com')).toBe('user@example.com');
    });
  });

  describe('extractEmailsAdvanced', () => {
    it('extracts plain emails', () => {
      expect(extractEmailsAdvanced('Contact us at hello@company.com')).toEqual(['hello@company.com']);
    });

    it('handles [at] and [dot] obfuscation', () => {
      expect(extractEmailsAdvanced('info [at] company [dot] com')).toEqual(['info@company.com']);
    });

    it('handles (at) and (dot) obfuscation', () => {
      expect(extractEmailsAdvanced('info (at) company (dot) com')).toEqual(['info@company.com']);
    });

    it('handles {at} and {dot} obfuscation', () => {
      expect(extractEmailsAdvanced('info {at} company {dot} com')).toEqual(['info@company.com']);
    });

    it('handles -at- and -dot- obfuscation', () => {
      expect(extractEmailsAdvanced('sales-at-company-dot-com')).toEqual(['sales@company.com']);
    });

    it('handles HTML entity &#64; for @', () => {
      expect(extractEmailsAdvanced('user&#64;example.com')).toEqual(['user@example.com']);
    });

    it('handles mixed obfuscation', () => {
      const text = 'email: info[at]company.com or support (at) company [dot] org';
      const emails = extractEmailsAdvanced(text);
      expect(emails).toContain('info@company.com');
      expect(emails).toContain('support@company.org');
    });

    it('handles " at " (spaces) obfuscation', () => {
      expect(extractEmailsAdvanced('info at company dot com')).toEqual(['info@company.com']);
    });

    it('deduplicates emails', () => {
      expect(extractEmailsAdvanced('a@b.com and A@B.COM')).toEqual(['a@b.com']);
    });

    it('rejects invalid emails', () => {
      expect(extractEmailsAdvanced('not-an-email @@ broken')).toEqual([]);
    });

    it('handles multiple emails in text', () => {
      const text = 'Sales: sales@co.com, Support: support@co.com, HR: hr@co.com';
      expect(extractEmailsAdvanced(text)).toEqual(['sales@co.com', 'support@co.com', 'hr@co.com']);
    });
  });

  describe('extractEmailsFromHtmlAdvanced', () => {
    it('extracts mailto: links', () => {
      const html = '<a href="mailto:hello@example.com">Contact</a>';
      expect(extractEmailsFromHtmlAdvanced(html)).toContain('hello@example.com');
    });

    it('extracts emails from visible text', () => {
      const html = '<div>Write to us: info@example.com</div>';
      expect(extractEmailsFromHtmlAdvanced(html)).toContain('info@example.com');
    });

    it('extracts emails hidden in data attributes', () => {
      const html = '<span data-email="hidden@example.com"></span>';
      expect(extractEmailsFromHtmlAdvanced(html)).toContain('hidden@example.com');
    });

    it('extracts from href with encoded mailto', () => {
      const html = '<a href="mailto:test&#64;example.com">mail</a>';
      expect(extractEmailsFromHtmlAdvanced(html)).toContain('test@example.com');
    });

    it('ignores emails inside script and style tags', () => {
      const html = `
        <script>var x = "script@example.com";</script>
        <style>/* style@example.com */</style>
        <div>real@example.com</div>
      `;
      const result = extractEmailsFromHtmlAdvanced(html);
      expect(result).toContain('real@example.com');
      expect(result).not.toContain('script@example.com');
      expect(result).not.toContain('style@example.com');
    });

    it('extracts emails from JSON-LD', () => {
      const html = `
        <script type="application/ld+json">
          {"@type": "Organization", "email": "org@example.com"}
        </script>
        <div>Hello</div>
      `;
      expect(extractEmailsFromHtmlAdvanced(html)).toContain('org@example.com');
    });

    it('deduplicates across all methods', () => {
      const html = `
        <a href="mailto:info@co.com">info@co.com</a>
        <div>info@co.com</div>
      `;
      const result = extractEmailsFromHtmlAdvanced(html);
      const infoCount = result.filter((e) => e === 'info@co.com').length;
      expect(infoCount).toBe(1);
    });
  });

  describe('extractJsonLdEmails', () => {
    it('extracts email from Organization', () => {
      const html = `<script type="application/ld+json">{"@type":"Organization","email":"org@co.com"}</script>`;
      expect(extractJsonLdEmails(html)).toEqual(['org@co.com']);
    });

    it('extracts contactPoint email', () => {
      const html = `<script type="application/ld+json">{"@type":"Organization","contactPoint":{"email":"cp@co.com"}}</script>`;
      expect(extractJsonLdEmails(html)).toEqual(['cp@co.com']);
    });

    it('extracts from array of contactPoints', () => {
      const html = `<script type="application/ld+json">{"@type":"Organization","contactPoint":[{"email":"a@co.com"},{"email":"b@co.com"}]}</script>`;
      const result = extractJsonLdEmails(html);
      expect(result).toContain('a@co.com');
      expect(result).toContain('b@co.com');
    });

    it('handles invalid JSON gracefully', () => {
      const html = `<script type="application/ld+json">{broken json</script>`;
      expect(extractJsonLdEmails(html)).toEqual([]);
    });
  });

  describe('filterJunkEmails', () => {
    it('removes noreply/no-reply', () => {
      expect(filterJunkEmails(['noreply@co.com', 'real@co.com'])).toEqual(['real@co.com']);
    });

    it('removes mailer-daemon', () => {
      expect(filterJunkEmails(['mailer-daemon@co.com'])).toEqual([]);
    });

    it('removes example.com/example.org domains', () => {
      expect(filterJunkEmails(['test@example.com', 'real@real.com'])).toEqual(['real@real.com']);
    });

    it('removes image file extensions used as emails', () => {
      expect(filterJunkEmails(['photo@png.com'])).toEqual(['photo@png.com']);
      expect(filterJunkEmails(['banner.png@images.com'])).toEqual([]);
    });

    it('removes wixpress and sentry domains', () => {
      expect(filterJunkEmails(['x@sentry.io', 'x@wixpress.com'])).toEqual([]);
    });

    it('removes hosting/parking placeholder domains (beget, timeweb, reg.ru…)', () => {
      expect(
        filterJunkEmails([
          'support@beget.com',
          'bills@beget.ru',
          'manager@timeweb.ru',
          'info@reg.ru',
          'admin@nic.ru',
          'sale@jino.ru',
          'x@sprinthost.ru',
          'real@company.ru',
        ]),
      ).toEqual(['real@company.ru']);
    });

    it('keeps valid business emails', () => {
      const input = ['sales@company.com', 'hr@firm.ru', 'ceo@startup.io'];
      expect(filterJunkEmails(input)).toEqual(input);
    });

    it('removes emails with very long local parts', () => {
      const long = 'a'.repeat(70) + '@co.com';
      expect(filterJunkEmails([long])).toEqual([]);
    });
  });

  describe('decodeCloudflareEmail', () => {
    // Референсные значения сгенерированы XOR-обфускацией по алгоритму CF
    // (первый байт — ключ, дальше email XOR ключа): key=0x5a, ожидаемый email
    // — переменная EXPECTED ниже. Собран через конкатенацию, чтобы автозамена
    // адресов в файлах-сообщениях не искажала литерал.
    const CF_HEX_USER_EXAMPLE = '5a2f293f281a3f223b372a363f74393537';
    const EXPECTED = 'user' + '@' + 'example.com';

    it('decodes a well-formed cfemail hex string', () => {
      expect(decodeCloudflareEmail(CF_HEX_USER_EXAMPLE)).toBe(EXPECTED);
    });

    it('rejects empty / too-short input', () => {
      expect(decodeCloudflareEmail('')).toBeNull();
      expect(decodeCloudflareEmail('5a')).toBeNull();
      expect(decodeCloudflareEmail('5a2f')).toBeNull();
    });

    it('rejects odd-length hex', () => {
      expect(decodeCloudflareEmail('5a2f2c2b2')).toBeNull();
    });

    it('rejects non-hex characters', () => {
      expect(decodeCloudflareEmail('5a2z2c2b')).toBeNull();
    });

    it('rejects decoded output without @ or .', () => {
      // key=0x00 → каждый байт декодируется в самого себя. "abcdef" (без @/.)
      expect(decodeCloudflareEmail('00616263646566')).toBeNull();
    });

    it('rejects when decoded byte is control char (bad hex/wrong key)', () => {
      // key=0xff, следующие байты дают < 0x20 → мусор, а не email
      expect(decodeCloudflareEmail('ff010203')).toBeNull();
    });

    it('extracts cfemail from HTML via extractEmailsFromHtmlAdvanced', () => {
      const html =
        '<p>Contact: <a class="__cf_email__" href="/cdn-cgi/l/email-protection" ' +
        'data-cfemail="' + CF_HEX_USER_EXAMPLE + '">[email&#160;protected]</a></p>';
      expect(extractEmailsFromHtmlAdvanced(html)).toContain(EXPECTED);
    });

    it('coexists with mailto: without duplication', () => {
      const html =
        '<a class="__cf_email__" data-cfemail="' + CF_HEX_USER_EXAMPLE + '">x</a>' +
        '<a href="mailto:' + EXPECTED + '">also</a>';
      const emails = extractEmailsFromHtmlAdvanced(html);
      expect(emails.filter((e) => e === EXPECTED)).toHaveLength(1);
    });
  });
});
