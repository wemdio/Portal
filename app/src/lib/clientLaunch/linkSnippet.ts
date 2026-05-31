/**
 * Build the plain-text snippet inserted by the «Вставить ссылку» action in
 * EmailBodyField.
 *
 * Client emails are plain-text (text_only — see buildCampaignPayload). A
 * plain-text email CANNOT anchor display text to a URL the way HTML's
 * `<a href>` does — there's no way to make the word «Егор» itself clickable
 * while hiding the URL. The honest plain-text equivalent: keep the selected
 * word and put the URL right next to it, e.g. `Егор (https://…)`. Mail
 * clients auto-linkify the bare URL, so it's clickable; the word stays
 * visible. No selected word → just the URL on its own.
 *
 * This replaces the old behaviour where inserting a link REPLACED the
 * selected text with the raw URL (so selecting «Егор» and adding a link
 * deleted «Егор»).
 */
export function buildPlainTextLinkSnippet(anchorText: string, url: string): string {
  const anchor = anchorText.trim();
  const link = url.trim();
  if (!anchor) return link;
  // If the selected text IS the same URL (e.g. re-inserting over an existing
  // link), don't produce «https://… (https://…)» — just keep one.
  if (anchor === link) return link;
  return `${anchor} (${link})`;
}
