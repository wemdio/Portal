/**
 * Build the markdown snippet inserted by the «Вставить ссылку» action in
 * EmailBodyField.
 *
 * Client emails now support ONE rich element: a hidden hyperlink. The client
 * selects a word (e.g. «наш сайт» / «Егор»), the button wraps it as a
 * markdown link `[наш сайт](https://…)`. At build time toInstantlyHtmlBody
 * converts that to `<a href="https://…">наш сайт</a>` (URL validated http(s),
 * everything else escaped) and the campaign goes out as HTML so the link is
 * clickable with the URL hidden from the recipient.
 *
 * Markdown shape is the editable plain-text representation: the client sees
 * `[наш сайт](https://…)` in the textarea and can edit/remove it; nothing
 * else they type can become HTML.
 *
 * No selected anchor (or anchor equals the URL) → the URL itself becomes the
 * clickable text: `[https://…](https://…)`.
 *
 * Anchor is sanitized so it can't break the markdown parse: `]` and newlines
 * (which the link regex forbids in the anchor) are stripped/space-collapsed.
 */
export function buildMarkdownLink(anchorText: string, url: string): string {
  const link = url.trim();
  const anchor = anchorText.replace(/[\]\r\n]+/g, ' ').trim();
  if (!anchor || anchor === link) return `[${link}](${link})`;
  return `[${anchor}](${link})`;
}
