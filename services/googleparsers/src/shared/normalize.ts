import type { PlaceResult } from "./types";

export function normalizeDomain(value: string): string {
  if (!value) return "";
  try {
    const parsed = new URL(value.startsWith("http") ? value : `https://${value}`);
    return parsed.hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return value.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0].toLowerCase();
  }
}

export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[ё]/g, "е")
    .replace(/["'`.,:;!?()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizePhone(value: string): string {
  const digits = value.replace(/\D+/g, "");
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
}

export function buildDedupeKey(result: Pick<PlaceResult, "placeId" | "googleId" | "website" | "name" | "address">): string {
  if (result.placeId) return `place:${result.placeId}`;
  if (result.googleId) return `google:${result.googleId}`;

  const domain = normalizeDomain(result.website);
  if (domain) return `domain:${domain}`;

  const identity = [normalizeText(result.name), normalizeText(result.address)].filter(Boolean).join("|");
  return identity ? `name-address:${identity}` : "";
}

export function mergeResult(existing: PlaceResult, incoming: PlaceResult): PlaceResult {
  return {
    ...existing,
    ...Object.fromEntries(
      Object.entries(incoming).filter(([, value]) => {
        if (Array.isArray(value)) return value.length > 0;
        return value !== "";
      })
    ),
    emails: unique([...existing.emails, ...incoming.emails]),
    socials: unique([...existing.socials, ...incoming.socials]),
    linkedInUrl: existing.linkedInUrl || incoming.linkedInUrl,
    status: existing.status === "ok" ? existing.status : incoming.status
  } as PlaceResult;
}

export function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
