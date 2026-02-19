import {
  detectGoogleBlockReason,
  duckDuckGoSearchDetailed,
  extractBingResults,
  extractDuckDuckGoResults,
  extractGoogleResults,
} from '@/lib/parsers/searchScraper';

describe('searchScraper', () => {
  it('extracts results from modern and legacy containers', async () => {
    const html = `
      <div id="rso">
        <div class="MjjYud">
          <a href="https://www.google.com/url?q=https://example.com&sa=U&ved=2ah">
            <h3>Example Title</h3>
          </a>
          <div class="VwiC3b">Snippet A</div>
        </div>
        <div class="g">
          <a href="https://example.org">
            <h3>Example Org</h3>
          </a>
          <div class="VwiC3b">Snippet B</div>
        </div>
      </div>
    `;

    const results = await extractGoogleResults(html, 'test query');
    expect(results).toHaveLength(2);
    expect(results[0].title).toBe('Example Title');
    expect(results[0].link).toContain('https://example.com');
    expect(results[1].title).toBe('Example Org');
  });

  it('detects captcha or consent pages', () => {
    const html = `
      <html>
        <head><title>Sorry</title></head>
        <body>
          <form action="/sorry/">
            <div id="captcha-form"></div>
          </form>
          <script src="https://www.google.com/recaptcha/api.js"></script>
        </body>
      </html>
    `;

    expect(detectGoogleBlockReason(html)).toBeTruthy();
  });

  it('detects enablejs interstitial', () => {
    const html = `
      <!DOCTYPE html>
      <html lang="ru">
        <head>
          <title>Google Search</title>
        </head>
        <body>
          <noscript>
            <meta content="0;url=/httpservice/retry/enablejs?sei=abc" http-equiv="refresh">
          </noscript>
          <div>Нажмите <a href="/httpservice/retry/enablejs?sei=abc">здесь</a></div>
        </body>
      </html>
    `;
    expect(detectGoogleBlockReason(html)).toMatch(/enablejs/i);
  });

  it('extracts results from duckduckgo html', async () => {
    const html = `
      <html>
        <head><title>DuckDuckGo</title></head>
        <body>
          <table>
            <tr>
              <td>1.</td>
              <td>
                <a class="result-link" rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdoc%3Fa%3D1">Example</a>
              </td>
            </tr>
            <tr>
              <td></td>
              <td class="result-snippet">Snippet text</td>
            </tr>
            <tr>
              <td>2.</td>
              <td>
                <a class="result-link" rel="nofollow" href="https://example.org/">Example Org</a>
              </td>
            </tr>
            <tr>
              <td></td>
              <td class="result-snippet">Org snippet</td>
            </tr>
          </table>
        </body>
      </html>
    `;
    const results = await extractDuckDuckGoResults(html, 'q');
    expect(results).toHaveLength(2);
    expect(results[0].title).toBe('Example');
    expect(results[0].link).toBe('https://example.com/doc?a=1');
    expect(results[0].snippet).toContain('Snippet text');
    expect(results[1].link).toContain('https://example.org/');
  });

  it('extracts results from bing html', async () => {
    const html = `
      <html>
        <head><title>Bing</title></head>
        <body>
          <ol id="b_results">
            <li class="b_algo">
              <h2><a href="https://example.com/page">Example</a></h2>
              <div class="b_caption"><p>Snippet A</p></div>
            </li>
            <li class="b_algo">
              <h2><a href="https://www.bing.com/ck/a?u=a1aHR0cHM6Ly9leGFtcGxlLm9yZy8&ntb=1">Example Org</a></h2>
              <div class="b_caption"><p>Snippet B</p></div>
            </li>
          </ol>
        </body>
      </html>
    `;
    const results = await extractBingResults(html, 'q');
    expect(results).toHaveLength(2);
    expect(results[0].link).toBe('https://example.com/page');
    expect(results[0].snippet).toContain('Snippet A');
    expect(results[1].link).toBe('https://example.org/');
  });

  it('duckDuckGoSearchDetailed parses results from 202 response when HTML already contains results', async () => {
    jest.useFakeTimers();

    const html = `
      <html>
        <head><title>DuckDuckGo</title></head>
        <body>
          <table>
            <tr>
              <td>1.</td>
              <td>
                <a class="result-link" rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdoc%3Fa%3D1">Example</a>
              </td>
            </tr>
            <tr>
              <td></td>
              <td class="result-snippet">Snippet text</td>
            </tr>
          </table>
        </body>
      </html>
    `;

    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 202,
      url: 'https://lite.duckduckgo.com/lite/?q=test',
      text: async () => html,
    }));

    const prevFetch = global.fetch;
    // @ts-expect-error - test stub
    global.fetch = fetchMock;

    try {
      const promise = duckDuckGoSearchDetailed('test query');
      // Advance all internal backoff timers.
      await jest.runAllTimersAsync();
      const out = await promise;
      expect(out.results.length).toBeGreaterThan(0);
      expect(out.debug.status).toBe(202);
      expect(fetchMock).toHaveBeenCalled();
    } finally {
      global.fetch = prevFetch;
      jest.useRealTimers();
    }
  });
});
