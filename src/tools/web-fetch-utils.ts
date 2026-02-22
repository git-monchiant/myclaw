/**
 * HTML extraction utilities for web_fetch tool
 * Ported from OpenClaw: openclaw/src/agents/tools/web-fetch-utils.ts
 */

export type ExtractMode = "markdown" | "text" | "images";

const READABILITY_MAX_HTML_CHARS = 1_000_000;
const READABILITY_MAX_ESTIMATED_NESTING_DEPTH = 3_000;

// Lazy-loaded deps (Mozilla Readability + linkedom)
let readabilityDepsPromise:
  | Promise<{
      Readability: typeof import("@mozilla/readability").Readability;
      parseHTML: typeof import("linkedom").parseHTML;
    }>
  | undefined;

async function loadReadabilityDeps(): Promise<{
  Readability: typeof import("@mozilla/readability").Readability;
  parseHTML: typeof import("linkedom").parseHTML;
}> {
  if (!readabilityDepsPromise) {
    readabilityDepsPromise = Promise.all([import("@mozilla/readability"), import("linkedom")]).then(
      ([readability, linkedom]) => ({
        Readability: readability.Readability,
        parseHTML: linkedom.parseHTML,
      }),
    );
  }
  try {
    return await readabilityDepsPromise;
  } catch (error) {
    readabilityDepsPromise = undefined;
    throw error;
  }
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gi, (_, dec) => String.fromCharCode(Number.parseInt(dec, 10)));
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, ""));
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function htmlToMarkdown(html: string): { text: string; title?: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? normalizeWhitespace(stripTags(titleMatch[1])) : undefined;
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "");
  text = text.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, body) => {
    const label = normalizeWhitespace(stripTags(body));
    if (!label) {
      return href;
    }
    return `[${label}](${href})`;
  });
  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, body) => {
    const prefix = "#".repeat(Math.max(1, Math.min(6, Number.parseInt(level, 10))));
    const label = normalizeWhitespace(stripTags(body));
    return `\n${prefix} ${label}\n`;
  });
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, body) => {
    const label = normalizeWhitespace(stripTags(body));
    return label ? `\n- ${label}` : "";
  });
  // <img> → ![alt](src)
  text = text.replace(/<img\s+[^>]*src=["']([^"']+)["'][^>]*>/gi, (match, src) => {
    const altMatch = match.match(/alt=["']([^"']*?)["']/i);
    const alt = altMatch ? stripTags(altMatch[1]).trim() : "";
    return `![${alt}](${src})`;
  });
  text = text
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|table|tr|ul|ol)>/gi, "\n");
  text = stripTags(text);
  text = normalizeWhitespace(text);
  return { text, title };
}

export function markdownToText(markdown: string): string {
  let text = markdown;
  text = text.replace(/!\[[^\]]*]\([^)]+\)/g, "");
  text = text.replace(/\[([^\]]+)]\([^)]+\)/g, "$1");
  text = text.replace(/```[\s\S]*?```/g, (block) =>
    block.replace(/```[^\n]*\n?/g, "").replace(/```/g, ""),
  );
  text = text.replace(/`([^`]+)`/g, "$1");
  text = text.replace(/^#{1,6}\s+/gm, "");
  text = text.replace(/^\s*[-*+]\s+/gm, "");
  text = text.replace(/^\s*\d+\.\s+/gm, "");
  return normalizeWhitespace(text);
}

export function truncateText(
  value: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  if (value.length <= maxChars) {
    return { text: value, truncated: false };
  }
  return { text: value.slice(0, maxChars), truncated: true };
}

function exceedsEstimatedHtmlNestingDepth(html: string, maxDepth: number): boolean {
  const voidTags = new Set([
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
  ]);

  let depth = 0;
  const len = html.length;
  for (let i = 0; i < len; i++) {
    if (html.charCodeAt(i) !== 60) continue; // '<'
    const next = html.charCodeAt(i + 1);
    if (next === 33 || next === 63) continue; // <! or <?

    let j = i + 1;
    let closing = false;
    if (html.charCodeAt(j) === 47) {
      closing = true;
      j += 1;
    }
    while (j < len && html.charCodeAt(j) <= 32) j += 1;

    const nameStart = j;
    while (j < len) {
      const c = html.charCodeAt(j);
      const isNameChar =
        (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
        (c >= 48 && c <= 57) || c === 58 || c === 45;
      if (!isNameChar) break;
      j += 1;
    }

    const tagName = html.slice(nameStart, j).toLowerCase();
    if (!tagName) continue;

    if (closing) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (voidTags.has(tagName)) continue;

    let selfClosing = false;
    for (let k = j; k < len && k < j + 200; k++) {
      const c = html.charCodeAt(k);
      if (c === 62) {
        if (html.charCodeAt(k - 1) === 47) selfClosing = true;
        break;
      }
    }
    if (selfClosing) continue;

    depth += 1;
    if (depth > maxDepth) return true;
  }
  return false;
}

/** Extract image URLs from HTML — returns absolute URLs, filtered by size hints */
export function extractImageUrls(html: string, baseUrl: string, maxImages = 10): string[] {
  const imgRegex = /<img\s+[^>]*src=["']([^"']+)["'][^>]*>/gi;
  const seen = new Set<string>();
  const results: string[] = [];

  // Skip tiny images (icons, spacers, tracking pixels)
  const SKIP_PATTERNS = [
    /1x1/i, /pixel/i, /spacer/i, /blank/i, /tracking/i,
    /\.gif$/i, /\.svg$/i, /data:image/i,
    /logo/i, /icon/i, /favicon/i, /badge/i, /avatar/i,
    /ad[_-]?banner/i, /advertisement/i,
  ];

  let match;
  while ((match = imgRegex.exec(html)) !== null && results.length < maxImages) {
    let src = match[0]; // full tag for checking attributes
    let url = match[1];

    // Resolve relative URLs
    try {
      url = new URL(url, baseUrl).toString();
    } catch {
      continue;
    }

    // Skip if not http/https
    if (!url.startsWith("http://") && !url.startsWith("https://")) continue;

    // Skip tiny images (check width/height attributes)
    const widthMatch = src.match(/width=["']?(\d+)/i);
    const heightMatch = src.match(/height=["']?(\d+)/i);
    if (widthMatch && parseInt(widthMatch[1]) < 50) continue;
    if (heightMatch && parseInt(heightMatch[1]) < 50) continue;

    // Skip patterns
    if (SKIP_PATTERNS.some(p => p.test(url))) continue;

    // Dedup
    if (seen.has(url)) continue;
    seen.add(url);

    results.push(url);
  }

  return results;
}

export async function extractReadableContent(params: {
  html: string;
  url: string;
  extractMode: ExtractMode;
}): Promise<{ text: string; title?: string } | null> {
  const fallback = (): { text: string; title?: string } => {
    const rendered = htmlToMarkdown(params.html);
    if (params.extractMode === "text") {
      const text = markdownToText(rendered.text) || normalizeWhitespace(stripTags(params.html));
      return { text, title: rendered.title };
    }
    return rendered;
  };
  if (
    params.html.length > READABILITY_MAX_HTML_CHARS ||
    exceedsEstimatedHtmlNestingDepth(params.html, READABILITY_MAX_ESTIMATED_NESTING_DEPTH)
  ) {
    return fallback();
  }
  try {
    const { Readability, parseHTML } = await loadReadabilityDeps();
    const { document } = parseHTML(params.html);
    try {
      (document as { baseURI?: string }).baseURI = params.url;
    } catch {
      // Best-effort base URI for relative links.
    }
    const reader = new Readability(document, { charThreshold: 0 });
    const parsed = reader.parse();
    if (!parsed?.content) {
      return fallback();
    }
    const title = parsed.title || undefined;
    if (params.extractMode === "text") {
      const text = normalizeWhitespace(parsed.textContent ?? "");
      return text ? { text, title } : fallback();
    }
    const rendered = htmlToMarkdown(parsed.content);
    return { text: rendered.text, title: title ?? rendered.title };
  } catch {
    return fallback();
  }
}
