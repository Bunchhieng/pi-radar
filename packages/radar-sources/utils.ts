import { createHash } from "node:crypto";

export function makeId(source: string, canonicalUrl: string): string {
  return createHash("sha256").update(`${source}:${canonicalUrl}`).digest("hex").slice(0, 16);
}

export function canonicalize(url: string): string {
  try {
    const u = new URL(url);
    // Remove tracking params
    const TRACKING = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "ref", "source"];
    for (const p of TRACKING) u.searchParams.delete(p);
    // Remove trailing slash from pathname (except root)
    if (u.pathname !== "/" && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.slice(0, -1);
    }
    u.hostname = u.hostname.toLowerCase();
    u.hash = "";
    return u.toString();
  } catch {
    return url.toLowerCase().replace(/\/+$/, "");
  }
}

export function sinceDefault(since?: string): Date {
  if (since) return new Date(since);
  return new Date(Date.now() - 24 * 3600 * 1000);
}

export async function fetchWithRetry(
  url: string,
  opts: RequestInit = {},
  retries = 3
): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      const resp = await fetch(url, opts);
      if (resp.status === 429) {
        const retryAfter = parseInt(resp.headers.get("retry-after") ?? "5", 10);
        await sleep(retryAfter * 1000 * (i + 1));
        continue;
      }
      return resp;
    } catch (e) {
      lastErr = e;
      await sleep(1000 * 2 ** i);
    }
  }
  throw lastErr;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
