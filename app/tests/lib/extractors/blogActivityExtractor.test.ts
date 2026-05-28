/** @jest-environment node */

import {
  discoverBlogOrSocialUrls,
  extractBlogLastPost,
  extractFullPostText,
  findLatestPostUrl,
} from '@/lib/enrich/extractors/blogActivityExtractor';

describe('extractBlogLastPost', () => {
  it('returns the text from the most recent dated post', () => {
    const html = `
      <article><time datetime="2025-01-15">Old post</time><h2>Old launch</h2></article>
      <article><time datetime="2026-04-10">Recent post</time><h2>New product update</h2><p>We launched integrations.</p></article>
      <article><time datetime="2024-08-20">Older post</time><h2>Older news</h2></article>
    `;

    expect(extractBlogLastPost(html)).toBe('New product update — We launched integrations.');
  });

  it('parses dates from .post-date / .entry-date / .article-date text', () => {
    const html = `
      <article><div class="post-date">10 апреля 2026</div><h2>April company news</h2></article>
      <article><div class="post-date">2025-12-01</div><h2>December update</h2></article>
    `;

    expect(extractBlogLastPost(html)).toBe('April company news');
  });

  it('falls back to the first plausible post when no date markup is present', () => {
    const html = `<article><h1>Post title</h1><p>Content</p></article>`;

    expect(extractBlogLastPost(html)).toBe('Post title — Content');
  });

  it('falls back to social preview meta tags when no article markup is present', () => {
    const html = `
      <meta property="og:title" content="Telegram company channel" />
      <meta property="og:description" content="Latest launch post from the team." />
    `;

    expect(extractBlogLastPost(html)).toBe('Telegram company channel — Latest launch post from the team.');
  });

  it('ignores future dates (>today + 7 days) as likely typos', () => {
    const futureYear = new Date().getFullYear() + 5;
    const realYear = new Date().getFullYear() - 1;
    const html = `
      <article><time datetime="${futureYear}-01-01">Future post</time><h2>Future post</h2></article>
      <article><time datetime="${realYear}-04-10">Real post</time><h2>Real company post</h2></article>
    `;

    expect(extractBlogLastPost(html)).toBe('Real company post');
  });

  it('discovers same-domain blog links and company social links', () => {
    const html = `
      <a href="/blog">Blog</a>
      <a href="https://vk.com/company_page">VK</a>
      <a href="https://twitter.com/intent/tweet?url=https://example.com">Share</a>
    `;

    expect(discoverBlogOrSocialUrls(html, 'https://example.com')).toEqual([
      'https://example.com/blog',
      'https://vk.com/company_page',
    ]);
  });
});

describe('findLatestPostUrl', () => {
  it('picks the most recent post link under the blog path', () => {
    const html = `
      <article><time datetime="2026-02-01">f</time><h2><a href="/blog/post-a">A</a></h2></article>
      <article><time datetime="2026-06-15">s</time><h2><a href="/blog/post-b">B</a></h2></article>
      <a href="/blog?page=2">Next</a>
      <a href="/blog/category/news">Category</a>
    `;
    expect(findLatestPostUrl(html, 'https://acme.com/blog')).toBe('https://acme.com/blog/post-b');
  });

  it('ignores pagination, category and external links (bare anchor lists)', () => {
    const html = `
      <a href="/blog/category/news">Cat</a>
      <a href="/blog?page=3">Next</a>
      <a href="https://twitter.com/acme">Tw</a>
      <a href="/blog/real-post">Real</a>
    `;
    expect(findLatestPostUrl(html, 'https://acme.com/blog')).toBe('https://acme.com/blog/real-post');
  });

  it('returns null when there are no post-like links', () => {
    const html = `<a href="/about">About</a><a href="/contacts">Contacts</a>`;
    expect(findLatestPostUrl(html, 'https://acme.com/blog')).toBeNull();
  });
});

describe('extractFullPostText', () => {
  it('extracts the full post body from a single article page and strips chrome', () => {
    const html = `<html><body><article class="entry-content">
      <h1>Our new release</h1>
      <p>${'Paragraph one with enough text to be meaningful. '.repeat(8)}</p>
      <p>${'Paragraph two continues the story for a while. '.repeat(8)}</p>
      <div class="share">share buttons</div>
    </article></body></html>`;

    const text = extractFullPostText(html);
    expect(text).toContain('Our new release');
    expect(text).toContain('Paragraph one');
    expect(text).toContain('Paragraph two');
    expect(text).not.toContain('share buttons');
  });

  it('returns undefined for a listing of many short cards (no single post body)', () => {
    const html = `
      <article class="post"><h2>One</h2><p>short</p></article>
      <article class="post"><h2>Two</h2><p>short</p></article>
      <article class="post"><h2>Three</h2><p>short</p></article>`;
    expect(extractFullPostText(html)).toBeUndefined();
  });

  it('truncates very long posts to the configured maximum', () => {
    const longBody = `<p>${'word '.repeat(2000)}</p>`;
    const html = `<article class="post-content"><h1>Big</h1>${longBody}</article>`;
    const text = extractFullPostText(html);
    expect(text).toBeDefined();
    expect((text ?? '').length).toBeLessThanOrEqual(4000);
    expect((text ?? '').endsWith('…')).toBe(true);
  });
});
