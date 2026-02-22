/**
 * web_search tool — ค้นหาเว็บ
 * Ported from OpenClaw: openclaw/src/agents/tools/web-search.ts
 *
 * รองรับ 4 providers: Gemini (Google Search grounding), Brave Search, Perplexity, xAI Grok
 * เลือก provider ตาม env var: WEB_SEARCH_PROVIDER หรือ auto-detect จาก API key ที่มี
 */

import type { ToolDefinition } from "./types.js";
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
} from "./web-shared.js";

// ===== Constants =====
const SEARCH_PROVIDERS = ["gemini", "brave", "perplexity", "grok"] as const;
type SearchProvider = (typeof SEARCH_PROVIDERS)[number];

const DEFAULT_SEARCH_COUNT = 5;
const MAX_SEARCH_COUNT = 10;

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_GEMINI_SEARCH_MODEL = "gemini-2.0-flash";

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_PERPLEXITY_BASE_URL = "https://openrouter.ai/api/v1";
const PERPLEXITY_DIRECT_BASE_URL = "https://api.perplexity.ai";
const DEFAULT_PERPLEXITY_MODEL = "perplexity/sonar-pro";

const XAI_API_ENDPOINT = "https://api.x.ai/v1/responses";
const DEFAULT_GROK_MODEL = "grok-4-1-fast";

const SEARCH_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();
const BRAVE_FRESHNESS_SHORTCUTS = new Set(["pd", "pw", "pm", "py"]);
const BRAVE_FRESHNESS_RANGE = /^(\d{4}-\d{2}-\d{2})to(\d{4}-\d{2}-\d{2})$/;

// ===== Types =====
type BraveSearchResponse = {
  web?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
      age?: string;
    }>;
  };
};

type PerplexitySearchResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  citations?: string[];
};

type GrokSearchResponse = {
  output?: Array<{
    type?: string;
    role?: string;
    text?: string;
    content?: Array<{
      type?: string;
      text?: string;
      annotations?: Array<{ type?: string; url?: string }>;
    }>;
    annotations?: Array<{ type?: string; url?: string }>;
  }>;
  output_text?: string;
  citations?: string[];
};

// ===== Gemini Search Grounding types =====
type GeminiSearchResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
    groundingMetadata?: {
      webSearchQueries?: string[];
      groundingChunks?: Array<{
        web?: { uri?: string; title?: string };
      }>;
      groundingSupports?: Array<{
        segment?: { startIndex?: number; endIndex?: number };
        groundingChunkIndices?: number[];
      }>;
    };
  }>;
};

// ===== Provider resolution =====
function resolveProvider(): SearchProvider {
  const explicit = process.env.WEB_SEARCH_PROVIDER?.trim().toLowerCase();
  if (explicit === "gemini") return "gemini";
  if (explicit === "perplexity") return "perplexity";
  if (explicit === "grok") return "grok";
  if (explicit === "brave") return "brave";

  // Auto-detect from available API keys (Gemini as fallback since user likely has it for AI)
  if (process.env.BRAVE_API_KEY?.trim()) return "brave";
  if (process.env.PERPLEXITY_API_KEY?.trim() || process.env.OPENROUTER_API_KEY?.trim()) return "perplexity";
  if (process.env.XAI_API_KEY?.trim()) return "grok";
  if (process.env.GEMINI_API_KEY?.trim()) return "gemini";

  return "gemini"; // default — most users have GEMINI_API_KEY
}

function resolveApiKey(provider: SearchProvider): string | undefined {
  if (provider === "gemini") return process.env.GEMINI_API_KEY?.trim() || undefined;
  if (provider === "brave") return process.env.BRAVE_API_KEY?.trim() || undefined;
  if (provider === "perplexity") {
    return process.env.PERPLEXITY_API_KEY?.trim() || process.env.OPENROUTER_API_KEY?.trim() || undefined;
  }
  if (provider === "grok") return process.env.XAI_API_KEY?.trim() || undefined;
  return undefined;
}

function resolvePerplexityBaseUrl(apiKey?: string): string {
  if (!apiKey) return DEFAULT_PERPLEXITY_BASE_URL;
  if (apiKey.startsWith("pplx-")) return PERPLEXITY_DIRECT_BASE_URL;
  return DEFAULT_PERPLEXITY_BASE_URL;
}

function resolvePerplexityRequestModel(baseUrl: string, model: string): string {
  try {
    if (new URL(baseUrl).hostname.toLowerCase() === "api.perplexity.ai") {
      return model.startsWith("perplexity/") ? model.slice("perplexity/".length) : model;
    }
  } catch { /* ignore */ }
  return model;
}

// ===== Freshness =====
function normalizeFreshness(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const lower = trimmed.toLowerCase();
  if (BRAVE_FRESHNESS_SHORTCUTS.has(lower)) return lower;

  const match = trimmed.match(BRAVE_FRESHNESS_RANGE);
  if (!match) return undefined;

  const [, start, end] = match;
  if (start > end) return undefined;
  return `${start}to${end}`;
}

function freshnessToPerplexityRecency(freshness: string | undefined): string | undefined {
  if (!freshness) return undefined;
  const map: Record<string, string> = { pd: "day", pw: "week", pm: "month", py: "year" };
  return map[freshness] ?? undefined;
}

// ===== Grok content extraction =====
function extractGrokContent(data: GrokSearchResponse): {
  text: string | undefined;
  annotationCitations: string[];
} {
  for (const output of data.output ?? []) {
    if (output.type === "message") {
      for (const block of output.content ?? []) {
        if (block.type === "output_text" && typeof block.text === "string" && block.text) {
          const urls = (block.annotations ?? [])
            .filter((a) => a.type === "url_citation" && typeof a.url === "string")
            .map((a) => a.url as string);
          return { text: block.text, annotationCitations: [...new Set(urls)] };
        }
      }
    }
    if (output.type === "output_text" && "text" in output && typeof output.text === "string" && output.text) {
      const rawAnnotations = "annotations" in output && Array.isArray(output.annotations) ? output.annotations : [];
      const urls = rawAnnotations
        .filter((a: Record<string, unknown>) => a.type === "url_citation" && typeof a.url === "string")
        .map((a: Record<string, unknown>) => a.url as string);
      return { text: output.text, annotationCitations: [...new Set(urls)] };
    }
  }
  const text = typeof data.output_text === "string" ? data.output_text : undefined;
  return { text, annotationCitations: [] };
}

// ===== Provider runners =====

// Gemini with Google Search grounding
async function runGeminiSearch(params: {
  query: string;
  apiKey: string;
  model: string;
  timeoutSeconds: number;
}): Promise<{ content: string; citations: string[] }> {
  const url = `${GEMINI_BASE_URL}/models/${params.model}:generateContent`;

  const body = {
    contents: [{ parts: [{ text: params.query }] }],
    tools: [{ google_search: {} }],
    systemInstruction: {
      parts: [{ text: "Always include relevant source URLs in your response. When the user asks for links, provide the actual URLs from search results." }],
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": params.apiKey,
    },
    body: JSON.stringify(body),
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  if (!res.ok) {
    const detail = (await readResponseText(res, { maxBytes: 64_000 })).text;
    throw new Error(`Gemini Search API error (${res.status}): ${detail || res.statusText}`);
  }

  const data = (await res.json()) as GeminiSearchResponse;
  const candidate = data.candidates?.[0];
  const textParts = candidate?.content?.parts?.filter((p) => p.text).map((p) => p.text!) ?? [];
  let content = textParts.join("\n") || "No response";

  // Extract citations from groundingChunks
  const chunks = candidate?.groundingMetadata?.groundingChunks ?? [];
  const rawUris = chunks
    .map((c) => c.web?.uri)
    .filter((uri): uri is string => !!uri);

  // Resolve Google redirect URLs to actual URLs
  const resolvedUris = await Promise.all(
    rawUris.map(async (uri) => {
      if (!uri.includes("vertexaisearch.cloud.google.com/grounding-api-redirect")) {
        return uri;
      }
      try {
        const redirectRes = await fetch(uri, { method: "HEAD", redirect: "manual" });
        const location = redirectRes.headers.get("location");
        if (location) {
          console.log(`[web_search] resolved: ${location}`);
          return location;
        }
      } catch (e) {
        console.log(`[web_search] redirect resolve failed for ${uri}:`, e);
      }
      return uri; // fallback to original
    }),
  );

  const citations = [...new Set(resolvedUris)];

  // Append citations to content so the AI model sees them clearly
  if (citations.length > 0) {
    const citationLines = citations.map((uri, i) => {
      const title = chunks[i]?.web?.title || "";
      return title ? `[${i + 1}] ${title}: ${uri}` : `[${i + 1}] ${uri}`;
    });
    content += "\n\nSources:\n" + citationLines.join("\n");
  }

  return { content, citations };
}

async function runBraveSearch(params: {
  query: string;
  count: number;
  apiKey: string;
  timeoutSeconds: number;
  country?: string;
  search_lang?: string;
  freshness?: string;
}): Promise<Record<string, unknown>> {
  const url = new URL(BRAVE_SEARCH_ENDPOINT);
  url.searchParams.set("q", params.query);
  url.searchParams.set("count", String(params.count));
  if (params.country) url.searchParams.set("country", params.country);
  if (params.search_lang) url.searchParams.set("search_lang", params.search_lang);
  if (params.freshness) url.searchParams.set("freshness", params.freshness);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": params.apiKey,
    },
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  if (!res.ok) {
    const detail = (await readResponseText(res, { maxBytes: 64_000 })).text;
    throw new Error(`Brave Search API error (${res.status}): ${detail || res.statusText}`);
  }

  const data = (await res.json()) as BraveSearchResponse;
  const results = Array.isArray(data.web?.results) ? data.web!.results : [];

  return {
    results: results.map((entry) => ({
      title: entry.title ? wrapWebContent(entry.title, "web_search") : "",
      url: entry.url ?? "",
      description: entry.description ? wrapWebContent(entry.description, "web_search") : "",
      published: entry.age || undefined,
      siteName: entry.url ? (() => { try { return new URL(entry.url).hostname; } catch { return undefined; } })() : undefined,
    })),
  };
}

async function runPerplexitySearch(params: {
  query: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutSeconds: number;
  freshness?: string;
}): Promise<{ content: string; citations: string[] }> {
  const baseUrl = params.baseUrl.trim().replace(/\/$/, "");
  const endpoint = `${baseUrl}/chat/completions`;
  const model = resolvePerplexityRequestModel(baseUrl, params.model);

  const body: Record<string, unknown> = {
    model,
    messages: [{ role: "user", content: params.query }],
  };

  const recencyFilter = freshnessToPerplexityRecency(params.freshness);
  if (recencyFilter) body.search_recency_filter = recencyFilter;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.apiKey}`,
      "HTTP-Referer": "https://myclaw.app",
      "X-Title": "MyClaw Web Search",
    },
    body: JSON.stringify(body),
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  if (!res.ok) {
    const detail = (await readResponseText(res, { maxBytes: 64_000 })).text;
    throw new Error(`Perplexity API error (${res.status}): ${detail || res.statusText}`);
  }

  const data = (await res.json()) as PerplexitySearchResponse;
  return {
    content: data.choices?.[0]?.message?.content ?? "No response",
    citations: data.citations ?? [],
  };
}

async function runGrokSearch(params: {
  query: string;
  apiKey: string;
  model: string;
  timeoutSeconds: number;
}): Promise<{ content: string; citations: string[] }> {
  const body: Record<string, unknown> = {
    model: params.model,
    input: [{ role: "user", content: params.query }],
    tools: [{ type: "web_search" }],
  };

  const res = await fetch(XAI_API_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  if (!res.ok) {
    const detail = (await readResponseText(res, { maxBytes: 64_000 })).text;
    throw new Error(`xAI API error (${res.status}): ${detail || res.statusText}`);
  }

  const data = (await res.json()) as GrokSearchResponse;
  const { text: extractedText, annotationCitations } = extractGrokContent(data);
  const content = extractedText ?? "No response";
  const citations = (data.citations ?? []).length > 0 ? data.citations! : annotationCitations;

  return { content, citations };
}

// ===== Main search function =====
async function runWebSearch(params: {
  query: string;
  count: number;
  provider: SearchProvider;
  apiKey: string;
  timeoutSeconds: number;
  cacheTtlMs: number;
  country?: string;
  search_lang?: string;
  freshness?: string;
}): Promise<Record<string, unknown>> {
  const cacheKey = normalizeCacheKey(`${params.provider}:${params.query}:${params.count}:${params.freshness || "default"}`);
  const cached = readCache(SEARCH_CACHE, cacheKey);
  if (cached) return { ...cached.value, cached: true };

  const start = Date.now();

  if (params.provider === "gemini") {
    const model = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_SEARCH_MODEL;
    const { content, citations } = await runGeminiSearch({
      query: params.query,
      apiKey: params.apiKey,
      model,
      timeoutSeconds: params.timeoutSeconds,
    });
    const payload = {
      query: params.query,
      provider: params.provider,
      model,
      tookMs: Date.now() - start,
      content: wrapWebContent(content),
      citations,
    };
    writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  }

  if (params.provider === "perplexity") {
    const apiKey = params.apiKey;
    const baseUrl = resolvePerplexityBaseUrl(apiKey);
    const model = process.env.PERPLEXITY_MODEL?.trim() || DEFAULT_PERPLEXITY_MODEL;
    const { content, citations } = await runPerplexitySearch({
      query: params.query,
      apiKey,
      baseUrl,
      model,
      timeoutSeconds: params.timeoutSeconds,
      freshness: params.freshness,
    });
    const payload = {
      query: params.query,
      provider: params.provider,
      model,
      tookMs: Date.now() - start,
      content: wrapWebContent(content),
      citations,
    };
    writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  }

  if (params.provider === "grok") {
    const model = process.env.GROK_MODEL?.trim() || DEFAULT_GROK_MODEL;
    const { content, citations } = await runGrokSearch({
      query: params.query,
      apiKey: params.apiKey,
      model,
      timeoutSeconds: params.timeoutSeconds,
    });
    const payload = {
      query: params.query,
      provider: params.provider,
      model,
      tookMs: Date.now() - start,
      content: wrapWebContent(content),
      citations,
    };
    writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  }

  // Brave Search
  const braveResult = await runBraveSearch({
    query: params.query,
    count: params.count,
    apiKey: params.apiKey,
    timeoutSeconds: params.timeoutSeconds,
    country: params.country,
    search_lang: params.search_lang,
    freshness: params.freshness,
  });
  const payload = {
    query: params.query,
    provider: params.provider,
    count: (braveResult.results as unknown[]).length,
    tookMs: Date.now() - start,
    ...braveResult,
  };
  writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
  return payload;
}

// ===== Tool definition =====
const provider = resolveProvider();
const apiKey = resolveApiKey(provider);

if (apiKey) {
  console.log(`[tools] web_search: ${provider}`);
}

const description =
  provider === "gemini"
    ? "Search the web using Google Search (via Gemini). Returns AI-synthesized answers grounded in real-time web results with citations."
    : provider === "perplexity"
      ? "Search the web using Perplexity Sonar. Returns AI-synthesized answers with citations from real-time web search."
      : provider === "grok"
        ? "Search the web using xAI Grok. Returns AI-synthesized answers with citations from real-time web search."
        : "Search the web using Brave Search API. Returns titles, URLs, and snippets for fast research.";

export const webSearchTool: ToolDefinition = {
  name: "web_search",
  description: apiKey
    ? description
    : "Web search is not available — no API key configured. Set GEMINI_API_KEY, BRAVE_API_KEY, PERPLEXITY_API_KEY, or XAI_API_KEY in .env",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description: "Search query string.",
      },
      count: {
        type: "number",
        description: "Number of results to return (1-10).",
        minimum: 1,
        maximum: MAX_SEARCH_COUNT,
      },
      country: {
        type: "string",
        description: "2-letter country code for region-specific results (e.g. 'TH', 'US').",
      },
      search_lang: {
        type: "string",
        description: "ISO language code for search results (e.g. 'th', 'en').",
      },
      freshness: {
        type: "string",
        description: "Filter by time: 'pd' (past day), 'pw' (past week), 'pm' (past month), 'py' (past year), or 'YYYY-MM-DDtoYYYY-MM-DD'.",
      },
    },
    required: ["query"],
  },
  execute: async (input) => {
    const currentApiKey = resolveApiKey(resolveProvider());
    if (!currentApiKey) {
      return JSON.stringify({
        error: "missing_api_key",
        message: `web_search needs an API key. Set GEMINI_API_KEY, BRAVE_API_KEY, PERPLEXITY_API_KEY, or XAI_API_KEY in .env`,
      });
    }

    const query = input.query as string;
    if (!query?.trim()) {
      return JSON.stringify({ error: "missing_query", message: "query is required" });
    }

    const count = typeof input.count === "number"
      ? Math.max(1, Math.min(MAX_SEARCH_COUNT, Math.floor(input.count)))
      : DEFAULT_SEARCH_COUNT;

    const rawFreshness = input.freshness as string | undefined;
    const currentProvider = resolveProvider();
    if (rawFreshness && currentProvider !== "brave" && currentProvider !== "perplexity") {
      return JSON.stringify({
        error: "unsupported_freshness",
        message: "freshness is only supported by Brave and Perplexity providers.",
      });
    }

    const freshness = normalizeFreshness(rawFreshness);
    if (rawFreshness && !freshness) {
      return JSON.stringify({
        error: "invalid_freshness",
        message: "freshness must be one of pd, pw, pm, py, or a range like YYYY-MM-DDtoYYYY-MM-DD.",
      });
    }

    const result = await runWebSearch({
      query,
      count,
      provider: currentProvider,
      apiKey: currentApiKey,
      timeoutSeconds: resolveTimeoutSeconds(undefined, DEFAULT_TIMEOUT_SECONDS),
      cacheTtlMs: resolveCacheTtlMs(undefined, DEFAULT_CACHE_TTL_MINUTES),
      country: (input.country as string) || undefined,
      search_lang: (input.search_lang as string) || undefined,
      freshness,
    });

    return JSON.stringify(result, null, 2);
  },
};
