/**
 * memory_get tool — ดึง conversation history ย้อนหลัง
 * Ported from OpenClaw: openclaw/src/agents/tools/memory-tool.ts (createMemoryGetTool)
 *
 * OpenClaw: อ่านไฟล์ MEMORY.md ตาม path + line range
 * MyClaw: ไม่มีไฟล์ .md → ปรับเป็นดึง session messages จาก SQLite
 *
 * ใช้หลัง memory_search เพื่อดึงบริบทเพิ่มเติม
 */

import type { ToolDefinition, ToolContext } from "./types.js";
import { loadHistory, getMemoryStatus } from "../memory/index.js";

// ===== Constants =====
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_TEXT_PER_ENTRY = 500;

// ===== Tool definition =====
export const memoryGetTool: ToolDefinition = {
  name: "memory_get",
  description:
    "Retrieve recent conversation history for the current user. Use after memory_search to get full context, or to review what was discussed recently.",
  inputSchema: {
    type: "object" as const,
    properties: {
      limit: {
        type: "number",
        description: `Number of recent messages to retrieve (1-${MAX_LIMIT}). Default: ${DEFAULT_LIMIT}.`,
        minimum: 1,
        maximum: MAX_LIMIT,
      },
      query: {
        type: "string",
        description: "Optional: filter messages containing this keyword.",
      },
    },
    required: [],
  },
  execute: async (input, context?: ToolContext) => {
    const userId = context?.userId;
    if (!userId) {
      return JSON.stringify({ error: "missing_context", message: "userId is required for memory_get" });
    }

    const limit = typeof input.limit === "number"
      ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(input.limit)))
      : DEFAULT_LIMIT;

    const query = typeof input.query === "string" ? input.query.trim().toLowerCase() : undefined;

    try {
      // Load conversation history from SQLite
      let messages = loadHistory(userId, query ? MAX_LIMIT : limit);

      // Optional keyword filter
      if (query) {
        messages = messages.filter((m) =>
          m.content.toLowerCase().includes(query),
        );
        // Apply limit after filter
        messages = messages.slice(-limit);
      }

      if (messages.length === 0) {
        return JSON.stringify({
          userId,
          messages: [],
          message: query
            ? `No messages found containing "${query}".`
            : "No conversation history found.",
        });
      }

      // Format messages (truncate long ones)
      const formatted = messages.map((m, i) => ({
        index: i + 1,
        role: m.role,
        content: m.content.length > MAX_TEXT_PER_ENTRY
          ? m.content.substring(0, MAX_TEXT_PER_ENTRY) + "..."
          : m.content,
      }));

      return JSON.stringify({
        userId,
        messageCount: formatted.length,
        limit,
        ...(query ? { filter: query } : {}),
        messages: formatted,
      }, null, 2);
    } catch (err: any) {
      return JSON.stringify({
        error: "load_failed",
        message: err?.message || String(err),
        userId,
      });
    }
  },
};
