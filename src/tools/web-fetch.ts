/**
 * web_fetch tool — ดึงเนื้อหาจาก URL
 * Ported from OpenClaw: openclaw/src/agents/tools/web-fetch.ts
 *
 * ดึง HTML → แปลงเป็น readable markdown/text ด้วย Readability
 * รองรับ: HTML (Readability), Markdown (Cloudflare), JSON, raw text
 * SSRF guard: block private IPs
 */

import type { ToolDefinition } from "./types.js";
import {
  extractReadableContent,
  extractImageUrls,
  htmlToMarkdown,
  markdownToText,
  truncateText,
  type ExtractMode,
} from "./web-fetch-utils.js";
import {
  type CacheEntry,
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_TIMEOUT_SECONDS,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  resolveTimeoutSeconds,
  withTimeout,
  writeCache,
  wrapWebContent,
  isPrivateUrl,
} from "./web-shared.js";

// ===== Constants =====
const DEFAULT_FETCH_MAX_CHARS = 50_000;
const DEFAULT_FETCH_MAX_RESPONSE_BYTES = 2_000_000;
const DEFAULT_FETCH_MAX_REDIRECTS = 3;
const DEFAULT_ERROR_MAX_CHARS = 4_000;
const DEFAULT_ERROR_MAX_BYTES = 64_000;
const DEFAULT_FETCH_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const FETCH_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();

// ===== SSRF-guarded fetch with redirect following =====
async function fetchWithSsrfGuard(params: {
  url: string;
  maxRedirects: number;
  timeoutMs: number;
  headers: Record<string, string>;
}): Promise<{ response: Response; finalUrl: string }> {
  let currentUrl = params.url;

  for (let i = 0; i <= params.maxRedirects; i++) {
    if (isPrivateUrl(currentUrl)) {
      throw new Error(`SSRF blocked: ${currentUrl} is a private/internal address`);
    }

    const res = await fetch(currentUrl, {
      method: "GET",
      headers: params.headers,
      redirect: "manual",
      signal: withTimeout(undefined, params.timeoutMs),
    });

    // Follow redirects manually (to check each URL for SSRF)
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location) break;
      try {
        currentUrl = new URL(location, currentUrl).toString();
      } catch {
        break;
      }
      continue;
    }

    return { response: res, finalUrl: currentUrl };
  }

  throw new Error(`Too many redirects (max ${params.maxRedirects})`);
}

// ===== Helper functions =====
function normalizeContentType(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const [raw] = value.split(";");
  return raw?.trim() || undefined;
}

function looksLikeHtml(value: string): boolean {
  const head = value.trimStart().slice(0, 256).toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

function formatErrorDetail(params: {
  detail: string;
  contentType?: string | null;
  maxChars: number;
}): string {
  const { detail, contentType, maxChars } = params;
  if (!detail) return "";
  let text = detail;
  const contentTypeLower = contentType?.toLowerCase();
  if (contentTypeLower?.includes("text/html") || looksLikeHtml(detail)) {
    const rendered = htmlToMarkdown(detail);
    const withTitle = rendered.title ? `${rendered.title}\n${rendered.text}` : rendered.text;
    text = markdownToText(withTitle);
  }
  return truncateText(text.trim(), maxChars).text;
}

// ===== Main fetch function =====
async function runWebFetch(params: {
  url: string;
  extractMode: ExtractMode;
  maxChars: number;
  maxResponseBytes: number;
  maxRedirects: number;
  timeoutSeconds: number;
  cacheTtlMs: number;
  userAgent: string;
}): Promise<Record<string, unknown>> {
  const cacheKey = normalizeCacheKey(`fetch:${params.url}:${params.extractMode}:${params.maxChars}`);
  const cached = readCache(FETCH_CACHE, cacheKey);
  if (cached) return { ...cached.value, cached: true };

  // Validate URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(params.url);
  } catch {
    throw new Error("Invalid URL: must be http or https");
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("Invalid URL: must be http or https");
  }

  const start = Date.now();

  const { response: res, finalUrl } = await fetchWithSsrfGuard({
    url: params.url,
    maxRedirects: params.maxRedirects,
    timeoutMs: params.timeoutSeconds * 1000,
    headers: {
      Accept: "text/markdown, text/html;q=0.9, */*;q=0.1",
      "User-Agent": params.userAgent,
      "Accept-Language": "en-US,en;q=0.9",
    },
  });

  if (!res.ok) {
    const rawDetail = (await readResponseText(res, { maxBytes: DEFAULT_ERROR_MAX_BYTES })).text;
    const detail = formatErrorDetail({
      detail: rawDetail,
      contentType: res.headers.get("content-type"),
      maxChars: DEFAULT_ERROR_MAX_CHARS,
    });
    throw new Error(`Web fetch failed (${res.status}): ${detail || res.statusText}`);
  }

  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  const normalizedContentType = normalizeContentType(contentType) ?? "application/octet-stream";
  const bodyResult = await readResponseText(res, { maxBytes: params.maxResponseBytes });
  const body = bodyResult.text;
  const responseTruncatedWarning = bodyResult.truncated
    ? `Response body truncated after ${params.maxResponseBytes} bytes.`
    : undefined;

  // "images" mode — extract image URLs from HTML and return early
  if (params.extractMode === "images") {
    if (!contentType.includes("text/html")) {
      return {
        url: params.url,
        finalUrl,
        status: res.status,
        error: "not_html",
        message: `Cannot extract images from ${normalizedContentType}. Only HTML pages are supported.`,
      };
    }

    const images = extractImageUrls(body, finalUrl, 20);
    const payload: Record<string, unknown> = {
      url: params.url,
      finalUrl,
      extractMode: "images",
      imageCount: images.length,
      images,
      tookMs: Date.now() - start,
    };
    writeCache(FETCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  }

  let title: string | undefined;
  let extractor = "raw";
  let text = body;

  if (contentType.includes("text/markdown")) {
    // Cloudflare Markdown for Agents
    extractor = "cf-markdown";
    if (params.extractMode === "text") {
      text = markdownToText(body);
    }
  } else if (contentType.includes("text/html")) {
    const readable = await extractReadableContent({
      html: body,
      url: finalUrl,
      extractMode: params.extractMode,
    });
    if (readable?.text) {
      text = readable.text;
      title = readable.title;
      extractor = "readability";
    } else {
      // Fallback: basic HTML → markdown
      const rendered = htmlToMarkdown(body);
      text = params.extractMode === "text" ? markdownToText(rendered.text) : rendered.text;
      title = rendered.title;
      extractor = "htmlToMarkdown";
    }
  } else if (contentType.includes("application/json")) {
    try {
      text = JSON.stringify(JSON.parse(body), null, 2);
      extractor = "json";
    } catch {
      extractor = "raw";
    }
  }

  // Wrap content with safety markers and truncate
  const truncated = truncateText(text, params.maxChars);
  const wrappedText = wrapWebContent(truncated.text, "web_fetch");
  const wrappedTitle = title ? wrapWebContent(title, "web_fetch") : undefined;

  const payload: Record<string, unknown> = {
    url: params.url,
    finalUrl,
    status: res.status,
    contentType: normalizedContentType,
    title: wrappedTitle,
    extractMode: params.extractMode,
    extractor,
    truncated: truncated.truncated,
    length: wrappedText.length,
    fetchedAt: new Date().toISOString(),
    tookMs: Date.now() - start,
    text: wrappedText,
  };
  if (responseTruncatedWarning) payload.warning = responseTruncatedWarning;

  writeCache(FETCH_CACHE, cacheKey, payload, params.cacheTtlMs);
  return payload;
}

// ===== Tool definition =====
export const webFetchTool: ToolDefinition = {
  name: "web_fetch",
  description:
    "Fetch and extract content from a URL. Modes: 'markdown' (default) extracts readable text, 'text' strips formatting, " +
    "'images' extracts image URLs from the page (use this to find direct image URLs for sending). " +
    "Use for lightweight page access without browser automation.",
  inputSchema: {
    type: "object" as const,
    properties: {
      url: {
        type: "string",
        description: "HTTP or HTTPS URL to fetch.",
      },
      extractMode: {
        type: "string",
        description: 'Extraction mode: "markdown" (readable text), "text" (plain text), or "images" (extract image URLs from page). Default: "markdown".',
        enum: ["markdown", "text", "images"],
      },
      maxChars: {
        type: "number",
        description: "Maximum characters to return (truncates when exceeded). Default: 50000.",
        minimum: 100,
      },
    },
    required: ["url"],
  },
  execute: async (input) => {
    const url = input.url as string;
    if (!url?.trim()) {
      return JSON.stringify({ error: "missing_url", message: "url is required" });
    }

    const rawMode = input.extractMode as string;
    const extractMode: ExtractMode =
      rawMode === "text" ? "text" : rawMode === "images" ? "images" : "markdown";

    const maxCharsInput = typeof input.maxChars === "number" ? input.maxChars : undefined;
    const maxChars = maxCharsInput
      ? Math.max(100, Math.min(maxCharsInput, DEFAULT_FETCH_MAX_CHARS))
      : DEFAULT_FETCH_MAX_CHARS;

    try {
      const result = await runWebFetch({
        url,
        extractMode,
        maxChars,
        maxResponseBytes: DEFAULT_FETCH_MAX_RESPONSE_BYTES,
        maxRedirects: DEFAULT_FETCH_MAX_REDIRECTS,
        timeoutSeconds: resolveTimeoutSeconds(undefined, DEFAULT_TIMEOUT_SECONDS),
        cacheTtlMs: resolveCacheTtlMs(undefined, DEFAULT_CACHE_TTL_MINUTES),
        userAgent: DEFAULT_FETCH_USER_AGENT,
      });
      return JSON.stringify(result, null, 2);
    } catch (err: any) {
      return JSON.stringify({
        error: "fetch_failed",
        message: err?.message || String(err),
        url,
      });
    }
  },
};
