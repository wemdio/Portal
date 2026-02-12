
import * as cheerio from 'cheerio';
import { normalizeUrl } from '@/lib/enrich/websiteParser';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];

export interface SearchResultItem {
  query: string;
  title: string;
  link: string;
  snippet: string;
  position: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function extractGoogleRedirect(href: string): string {
  try {
    const parsed = new URL(href);
    if (parsed.hostname.includes('google.') && parsed.pathname === '/url') {
      const target = parsed.searchParams.get('q') || parsed.searchParams.get('url');
      if (target) return target;
    }
  } catch {
    // ignore
  }
  return href;
}

function isSearchEngineHost(hostname: string) {
  const host = hostname.toLowerCase();
  return host.includes('google.') || host.includes('googleusercontent.com') || host.includes('gstatic.com');
}

/**
 * Perform a Google search for the given query and return parsed results.
 * This uses direct scraping and is subject to rate limits and blocking.
 */
export async function googleSearch(query: string, numResults = 10): Promise<SearchResultItem[]> {
  const url = new URL('https://www.google.com/search');
  url.searchParams.set('q', query);
  url.searchParams.set('num', String(Math.max(10, Math.min(100, numResults))));
  url.searchParams.set('hl', 'ru'); // Russian interface for better localized results if needed

  // Random delay before request to reduce bot detection
  await sleep(1000 + Math.random() * 2000);

  const headers = {
    'User-Agent': getRandomUserAgent(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
  };

  try {
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      if (response.status === 429) {
        throw new Error('Google blocking: Too Many Requests (429). Try again later.');
      }
      throw new Error(`Google search failed with status ${response.status}`);
    }

    const html = await response.text();
    const $ = cheerio.load(html);
    const results: SearchResultItem[] = [];

    // Selectors for Google search results (these change occasionally)
    // Common pattern: div.g contains the result
    // Title is usually h3
    // Link is usually a[href] inside .yuRUbf or similar, or just first a inside div.g
    // Snippet is usually .VwiC3b or similar

    // Using a more generic approach to be resilient to class name changes
    $('div.g').each((index, element) => {
      const $el = $(element);
      
      // Extract Title (h3 is standard)
      const title = $el.find('h3').first().text().trim();
      
      // Extract Link (look for anchor with href starting with http)
      let link = '';
      const $anchor = $el.find('a[href^="http"]').first();
      if ($anchor.length) {
        link = $anchor.attr('href') || '';
      }

      // Extract Snippet
      // Google snippets are often in divs with specific classes, but we can look for text blocks below the title
      // A common class recently is .VwiC3b, but let's try to grab the text container
      // Remove the title/link part to get the snippet
      const $snippetContainer = $el.find('div[style*="-webkit-line-clamp"], .VwiC3b, span.st').first();
      let snippet = $snippetContainer.text().trim();
      
      if (!snippet) {
         // Fallback: try to get text that isn't the title or link
         const clone = $el.clone();
         clone.find('h3, a, cite, .action-menu').remove();
         snippet = clone.text().replace(/\s+/g, ' ').trim();
      }

      if (title && link) {
        try {
          // Validate URL
          const cleanedLink = extractGoogleRedirect(link);
          const validLink = normalizeUrl(cleanedLink);
          const hostname = new URL(validLink).hostname;
          if (isSearchEngineHost(hostname)) return;
          results.push({
            query,
            title,
            link: validLink,
            snippet,
            position: index + 1,
          });
        } catch {
          // Ignore invalid URLs (e.g. relative links or google internal links)
        }
      }
    });

    return results;
  } catch (error) {
    console.error('Google search error:', error);
    throw error;
  }
}
