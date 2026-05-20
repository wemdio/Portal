/** @jest-environment node */

import { discoverBlogOrSocialUrls, extractBlogLastPost } from '@/lib/enrich/extractors/blogActivityExtractor';

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
