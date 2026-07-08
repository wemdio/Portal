import { normalizeDomain, unique } from "../shared/normalize";

export interface ContactEnrichment {
  emails: string[];
  phones: string[];
  socials: string[];
  linkedInUrl: string;
}

const CONTACT_HINTS = ["contact", "contacts", "kontakt", "about", "about-us", "kontakty", "сontact", "связ"];
const SOCIAL_HOSTS = ["linkedin.com", "facebook.com", "instagram.com", "youtube.com", "x.com", "twitter.com", "vk.com", "t.me", "wa.me", "whatsapp.com"];

export async function enrichWebsiteContacts(website: string): Promise<ContactEnrichment> {
  if (!website) return emptyContacts();

  const startUrl = normalizeWebsiteUrl(website);
  const visited = new Set<string>();
  const pagesToVisit = [startUrl];
  const emails: string[] = [];
  const phones: string[] = [];
  const socials: string[] = [];
  const rootDomain = normalizeDomain(startUrl);

  while (pagesToVisit.length > 0 && visited.size < 4) {
    const url = pagesToVisit.shift();
    if (!url || visited.has(url)) continue;
    visited.add(url);

    const html = await fetchPage(url);
    if (!html) continue;

    emails.push(...extractEmails(html));
    phones.push(...extractPhones(html));
    socials.push(...extractSocialLinks(html));

    if (visited.size === 1) {
      for (const contactUrl of extractContactLinks(html, url, rootDomain)) {
        if (!visited.has(contactUrl)) pagesToVisit.push(contactUrl);
      }
    }
  }

  const uniqueSocials = unique(socials).slice(0, 12);

  return {
    emails: unique(emails).slice(0, 10),
    phones: unique(phones).slice(0, 8),
    socials: uniqueSocials,
    linkedInUrl: uniqueSocials.find(isLinkedInUrl) ?? ""
  };
}

function emptyContacts(): ContactEnrichment {
  return { emails: [], phones: [], socials: [], linkedInUrl: "" };
}

function normalizeWebsiteUrl(website: string): string {
  return /^https?:\/\//i.test(website) ? website : `https://${website}`;
}

async function fetchPage(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        accept: "text/html,application/xhtml+xml"
      },
      redirect: "follow"
    });

    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok || !contentType.includes("text/html")) return "";
    const text = await response.text();
    return text.slice(0, 750000);
  } catch {
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

function extractEmails(html: string): string[] {
  const decoded = html.replace(/&#64;|&commat;/gi, "@").replace(/\s+\[at]\s+|\s+\(at\)\s+/gi, "@");
  return unique(decoded.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) ?? []).filter(
    (email) => !/\.(png|jpg|jpeg|webp|gif|svg)$/i.test(email)
  );
}

function extractPhones(html: string): string[] {
  const text = stripTags(html);
  const matches = text.match(/(?:\+?\d[\s().-]?){9,18}/g) ?? [];
  return unique(
    matches
      .map((phone) => phone.replace(/\s+/g, " ").trim())
      .filter((phone) => phone.replace(/\D+/g, "").length >= 9)
  );
}

function extractSocialLinks(html: string): string[] {
  const links = extractLinks(html, "https://example.com");
  return unique(links.filter((link) => SOCIAL_HOSTS.some((host) => link.includes(host))));
}

function isLinkedInUrl(url: string): boolean {
  return url.toLowerCase().includes("linkedin.com");
}

function extractContactLinks(html: string, baseUrl: string, rootDomain: string): string[] {
  return unique(
    extractLinks(html, baseUrl).filter((link) => {
      const domain = normalizeDomain(link);
      const lower = link.toLowerCase();
      return domain === rootDomain && CONTACT_HINTS.some((hint) => lower.includes(hint));
    })
  ).slice(0, 3);
}

function extractLinks(html: string, baseUrl: string): string[] {
  const links: string[] = [];
  const linkRegex = /href=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;

  while ((match = linkRegex.exec(html))) {
    try {
      const href = match[1].trim();
      if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) continue;
      links.push(new URL(href, baseUrl).toString());
    } catch {
      // Ignore malformed links from third-party widgets.
    }
  }

  return links;
}

function stripTags(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ");
}
