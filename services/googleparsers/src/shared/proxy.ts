type PlaywrightProxySettings = {
  server: string;
  bypass?: string;
  username?: string;
  password?: string;
};

export function normalizeProxyUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value) ? value : `http://${value}`;
}

/**
 * Playwright does not reliably apply credentials embedded in `proxy.server`.
 * Passing `http://user:pass@host:port` as-is makes Chromium receive the proxy's
 * HTTP 407 page, which Google Maps then appears to load forever. Split the
 * credentials into the fields expected by Playwright instead.
 */
export function toPlaywrightProxy(raw: string | undefined): PlaywrightProxySettings | undefined {
  const normalized = normalizeProxyUrl(raw ?? "");
  if (!normalized) return undefined;

  try {
    const url = new URL(normalized);
    const username = url.username ? decodeURIComponent(url.username) : undefined;
    const password = url.password ? decodeURIComponent(url.password) : undefined;
    url.username = "";
    url.password = "";
    const server = url.toString().replace(/\/$/, "");
    return {
      server,
      ...(username ? { username } : {}),
      ...(password ? { password } : {})
    };
  } catch {
    return { server: normalized.replace(/\/$/, "") };
  }
}

export function maskProxy(raw: string | undefined): string {
  const normalized = normalizeProxyUrl(raw ?? "");
  if (!normalized) return "none";

  try {
    const url = new URL(normalized);
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return normalized.replace(/\/\/[^@/]+@/g, "//").replace(/\/$/, "");
  }
}

export function shuffledUniqueProxies(proxies: string[]): string[] {
  const unique = [...new Set(proxies.map(normalizeProxyUrl).filter(Boolean))];
  for (let index = unique.length - 1; index > 0; index -= 1) {
    const swapWith = Math.floor(Math.random() * (index + 1));
    [unique[index], unique[swapWith]] = [unique[swapWith], unique[index]];
  }
  return unique;
}
