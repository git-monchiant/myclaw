/**
 * memory_search tool — ค้นหา memory ด้วย semantic/hybrid search
 * Ported from OpenClaw: openclaw/src/agents/tools/memory-tool.ts (createMemorySearchTool)
 *
 * ใช้ MyClaw memory system: hybridSearch (vector + keyword + MMR + temporal decay)
 * แยกตาม userId — ไม่ค้นข้าม user
 */

import type { ToolDefinition, ToolContext } from "./types.js";
import {
  searchMemory,
  formatMemoryForPrompt,
  getMemoryStatus,
} from "../memory/index.js";

// ===== Constants =====
const DEFAULT_MAX_RESULTS = 6;
const MAX_MAX_RESULTS = 20;
const DEFAULT_MIN_SCORE = 0.2;

// ===== Tool definition =====
export const memorySearchTool: ToolDefinition = {
  name: "memory_search",
  description:
    "Mandatory recall step: semantically search past conversations before answering questions about prior discussions, decisions, dates, people, preferences, or todos. Returns top memory snippets ranked by relevance.",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description: "Search query — what to look for in memory.",
      },
      maxResults: {
        type: "number",
        description: `Maximum number of results to return (1-${MAX_MAX_RESULTS}). Default: ${DEFAULT_MAX_RESULTS}.`,
        minimum: 1,
        maximum: MAX_MAX_RESULTS,
      },
      minScore: {
        type: "number",
        description: "Minimum relevance score (0-1). Default: 0.2.",
        minimum: 0,
        maximum: 1,
      },
    },
    required: ["query"],
  },
  execute: async (input, context?: ToolContext) => {
    const query = (input.query as string)?.trim();
    if (!query) {
      return JSON.stringify({ error: "missing_query", message: "query is required" });
    }

    const userId = context?.userId;
    if (!userId) {
      return JSON.stringify({ error: "missing_context", message: "userId is required for memory search" });
    }

    const maxResults = typeof input.maxResults === "number"
      ? Math.max(1, Math.min(MAX_MAX_RESULTS, Math.floor(input.maxResults)))
      : DEFAULT_MAX_RESULTS;

    const minScore = typeof input.minScore === "number"
      ? Math.max(0, Math.min(1, input.minScore))
      : DEFAULT_MIN_SCORE;

    try {
      // Use MyClaw's hybrid search (vector + keyword + MMR + temporal decay)
      const configOverride = {
        maxResults,
        minScore,
      };

      // searchMemory uses DEFAULT_MEMORY_CONFIG, override via spread
      const { DEFAULT_MEMORY_CONFIG } = await import("../memory/types.js");
      const config = { ...DEFAULT_MEMORY_CONFIG, ...configOverride };

      const results = await searchMemory(query, userId, config);

      if (results.length === 0) {
        return JSON.stringify({
          query,
          results: [],
          message: "No relevant memories found.",
        });
      }

      // Format results
      const formattedResults = results.map((r, i) => ({
        index: i + 1,
        score: Number(r.score.toFixed(3)),
        source: r.source, // "vector" | "keyword" | "hybrid"
        who: r.chunk.source, // "user" | "assistant"
        text: r.chunk.text.length > 700 ? r.chunk.text.substring(0, 700) + "..." : r.chunk.text,
        date: new Date(r.chunk.createdAt).toISOString(),
      }));

      // Get memory status for diagnostics
      const status = getMemoryStatus();

      return JSON.stringify({
        query,
        resultCount: formattedResults.length,
        searchMode: status.searchMode,
        provider: status.embeddingProvider,
        model: status.embeddingModel,
        results: formattedResults,
      }, null, 2);
    } catch (err: any) {
      return JSON.stringify({
        error: "search_failed",
        message: err?.message || String(err),
        query,
      });
    }
  },
};
