import { extractEmails, extractEmailsFromHtml } from '@/lib/enrich/emailExtractor';

describe('emailExtractor', () => {
  it('extracts emails from plain text', () => {
    const text = 'Пишите на Sales@Example.com и info@example.com.';
    expect(extractEmails(text)).toEqual(['sales@example.com', 'info@example.com']);
  });

  it('handles simple obfuscation', () => {
    const text = 'support [at] example [dot] org';
    expect(extractEmails(text)).toEqual(['support@example.org']);
  });

  it('extracts emails from HTML mailto and text', () => {
    const html = `
      <html>
        <body>
          <a href="mailto:hello@example.com?subject=x">mail</a>
          <div>или пишите admin@example.com</div>
        </body>
      </html>
    `;
    expect(extractEmailsFromHtml(html)).toEqual(['hello@example.com', 'admin@example.com']);
  });
});

