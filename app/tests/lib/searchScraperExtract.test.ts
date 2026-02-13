import { extractGoogleResults } from '@/lib/parsers/searchScraper';

describe('searchScraper extractGoogleResults', () => {
  it('extracts result link/title/snippet from a typical container', async () => {
    const html = `
      <html>
        <head><title>test</title></head>
        <body>
          <div id="search">
            <div class="MjjYud">
              <a href="https://example.com/path?x=1">
                <h3>Example title</h3>
              </a>
              <div class="VwiC3b">Example snippet text</div>
            </div>
          </div>
        </body>
      </html>
    `;

    const results = await extractGoogleResults(html, 'q');
    expect(results).toHaveLength(1);
    expect(results[0].title).toBe('Example title');
    expect(results[0].link).toContain('https://example.com/path?x=1');
    expect(results[0].snippet).toContain('Example snippet text');
    expect(results[0].position).toBe(1);
  });

  it('ignores internal google links and still finds wrapped h3 link', async () => {
    const html = `
      <html>
        <body>
          <div id="search">
            <div class="g">
              <a href="/search?q=internal"><h3>Internal</h3></a>
              <a href="https://target.example.com"><h3>Target</h3></a>
              <div class="VwiC3b">Snippet</div>
            </div>
          </div>
        </body>
      </html>
    `;

    const results = await extractGoogleResults(html, 'q');
    expect(results).toHaveLength(1);
    expect(results[0].link).toContain('https://target.example.com/');
    expect(results[0].title).toBe('Target');
  });
});

