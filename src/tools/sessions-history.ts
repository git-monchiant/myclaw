/**
 * sessions_history tool — ดู chat history ของ user
 */

import type { ToolDefinition, ToolContext } from "./types.js";
import { getDb } from "../memory/store.js";

export const sessionsHistoryTool: ToolDefinition = {
  name: "sessions_history",
  description:
    "View chat history of a user session. Shows recent messages with timestamps. " +
    "Use when the user asks to see their chat history, previous conversations, or what they said earlier.",
  inputSchema: {
    type: "object" as const,
    properties: {
      userId: {
        type: "string",
        description: "User ID to view history for. Defaults to current user.",
      },
      limit: {
        type: "number",
        description: "Number of messages to return (default 20, max 50).",
      },
    },
    required: [],
  },
  execute: async (input, context?: ToolContext) => {
    const dataDir = process.env.DATA_DIR || "./data";
    const targetUserId = (typeof input.userId === "string" && input.userId.trim()) || context?.userId;
    const limit = typeof input.limit === "number" ? Math.max(1, Math.min(50, input.limit)) : 20;

    if (!targetUserId) {
      return JSON.stringify({ error: "no_user", message: "No userId specified." });
    }

    try {
      const db = getDb(dataDir);

      const rows = db.prepare(`
        SELECT role, content, created_at
        FROM sessions
        WHERE session_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `).all(targetUserId, limit) as Array<{
        role: string;
        content: string;
        created_at: number;
      }>;

      // Reverse to chronological order
      const messages = rows.reverse().map((row) => ({
        role: row.role,
        content: row.content.length > 500 ? row.content.substring(0, 500) + "..." : row.content,
        timestamp: new Date(row.created_at).toISOString(),
      }));

      return JSON.stringify({
        userId: targetUserId,
        messageCount: messages.length,
        messages,
      });
    } catch (err: any) {
      return JSON.stringify({ error: "query_failed", message: err?.message || String(err) });
    }
  },
};
