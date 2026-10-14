import type { JSONContent } from '@tiptap/core';

/** The same small link syntax as clientLaunch; no arbitrary HTML or Markdown. */
export function splitVeEmailBody(value: string): Array<{ text: string; href?: string }> {
  const parts: Array<{ text: string; href?: string }> = [];
  const pattern = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let end = 0;
  for (const match of value.matchAll(pattern)) {
    if (match.index! > end) parts.push({ text: value.slice(end, match.index) });
    // Invalid pasted links must stay editable text. Do not let a malformed URL
    // become a mark that can throw during serialization or opening the link form.
    try {
      veEmailLinkUrl(match[2]);
      parts.push({ text: match[1], href: match[2] });
    } catch { parts.push({ text: match[0] }); }
    end = match.index! + match[0].length;
  }
  if (end < value.length) parts.push({ text: value.slice(end) });
  return parts;
}

export function veEmailLinkUrl(raw: string, utm?: Record<string, string>): string {
  const value = raw.trim();
  if (!value || /[\s<>"\x00-\x1f\x7f]/.test(value)) throw new Error('Укажите адрес сайта без пробелов.');
  const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.includes('.') || url.username || url.password) throw new Error('Нужна ссылка на сайт: https://…');
  for (const [key, val] of Object.entries(utm ?? {})) {
    if (!/^utm_(source|medium|campaign|content|term)$/.test(key)) continue;
    if (val.trim()) url.searchParams.set(key, val.trim());
    else url.searchParams.delete(key);
  }
  // Parentheses must not terminate the persisted Markdown link early.
  return url.toString().replace(/\(/g, '%28').replace(/\)/g, '%29');
}

export function veEmailBodyHasInvalidLinks(value: string): boolean {
  for (const match of value.matchAll(/\[[^\]\n]*\]\(([^\n)]*)\)/g)) {
    try { if (!/^https?:\/\//.test(match[1])) return true; veEmailLinkUrl(match[1]); }
    catch { return true; }
  }
  return false;
}

export function veEmailBodyDocument(value: string): JSONContent {
  return { type: 'doc', content: value.split('\n').map(line => ({ type: 'paragraph', content: splitVeEmailBody(line).map(part => ({
    type: 'text', text: part.text, ...(part.href ? { marks: [{ type: 'link', attrs: { href: part.href } }] } : {}),
  })) })) };
}

export function veEmailBodyText(doc: JSONContent): string {
  const inline = (node: JSONContent): string => {
    if (node.type === 'hardBreak') return '\n';
    if (node.type !== 'text') return (node.content ?? []).map(inline).join('');
    const href = node.marks?.find(mark => mark.type === 'link')?.attrs?.href;
    const text = node.text ?? '';
    if (!href) return text;
    let url: string;
    try { url = veEmailLinkUrl(String(href)); }
    catch { return `[${text}](${String(href)})`; }
    // This small storage syntax cannot represent a closing bracket in a label.
    // If one is typed directly into a link, keep both the exact text and URL
    // visibly instead of silently deleting the user's characters.
    return /[\]\r\n]/.test(text) ? `${text} (${url})` : `[${text}](${url})`;
  };
  return (doc.content ?? []).map(inline).join('\n');
}
