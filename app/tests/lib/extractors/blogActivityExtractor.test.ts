/** @jest-environment node */

import { extractBlogLastPost } from '@/lib/enrich/extractors/blogActivityExtractor';

describe('extractBlogLastPost', () => {
  it('returns the most recent date from <time datetime="..."> tags', () => {
    const html = `
      <article><time datetime="2025-01-15">Old post</time></article>
      <article><time datetime="2026-04-10">Recent post</time></article>
      <article><time datetime="2024-08-20">Older post</time></article>
    `;

    expect(extractBlogLastPost(html)).toBe('2026-04-10');
  });

  it('parses dates from .post-date / .entry-date / .article-date text', () => {
    const html = `
      <div class="post-date">10 апреля 2026</div>
      <div class="post-date">2025-12-01</div>
    `;

    expect(extractBlogLastPost(html)).toBe('2026-04-10');
  });

  it('returns undefined when no date markup is present', () => {
    const html = `<article><h1>Post title</h1><p>Content</p></article>`;

    expect(extractBlogLastPost(html)).toBeUndefined();
  });

  it('ignores future dates (>today + 7 days) as likely typos', () => {
    const futureYear = new Date().getFullYear() + 5;
    const html = `
      <article><time datetime="${futureYear}-01-01">Future post</time></article>
      <article><time datetime="2026-04-10">Real post</time></article>
    `;

    expect(extractBlogLastPost(html)).toBe('2026-04-10');
  });
});
