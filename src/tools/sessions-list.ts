/**
 * sessions_list tool — แสดงรายชื่อ user sessions ทั้งหมด
 */

import type { ToolDefinition, ToolContext } from "./types.js";
import { getDb } from "../memory/store.js";

export const sessionsListTool: ToolDefinition = {
  name: "sessions_list",
  description:
    "List all user sessions with message counts and last active time. " +
    "Use when the user asks how many people use the bot, who has chatted, or wants to see all sessions.",
  inputSchema: {
    type: "object" as const,
    properties: {
      limit: {
        type: "number",
        description: "Maximum number of sessions to return (default 10).",
      },
    },
    required: [],
  },
  execute: async (input, _context?: ToolContext) => {
    const dataDir = process.env.DATA_DIR || "./data";
    const limit = typeof input.limit === "number" ? Math.max(1, Math.min(50, input.limit)) : 10;

    try {
      const db = getDb(dataDir);

      const rows = db.prepare(`
        SELECT
          session_id,
          COUNT(*) as message_count,
          SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) as user_messages,
          SUM(CASE WHEN role = 'assistant' THEN 1 ELSE 0 END) as assistant_messages,
          MAX(created_at) as last_active,
          MIN(created_at) as first_active
        FROM sessions
        GROUP BY session_id
        ORDER BY last_active DESC
        LIMIT ?
      `).all(limit) as Array<{
        session_id: string;
        message_count: number;
        user_messages: number;
        assistant_messages: number;
        last_active: number;
        first_active: number;
      }>;

      // Get last message preview for each session
      const sessions = rows.map((row) => {
        const lastMsg = db.prepare(
          "SELECT content FROM sessions WHERE session_id = ? ORDER BY created_at DESC LIMIT 1",
        ).get(row.session_id) as { content: string } | undefined;

        return {
          userId: row.session_id,
          messageCount: row.message_count,
          userMessages: row.user_messages,
          assistantMessages: row.assistant_messages,
          lastActive: new Date(row.last_active).toISOString(),
          firstActive: new Date(row.first_active).toISOString(),
          lastMessage: lastMsg ? lastMsg.content.substring(0, 100) : null,
        };
      });

      return JSON.stringify({
        totalSessions: sessions.length,
        sessions,
      });
    } catch (err: any) {
      return JSON.stringify({ error: "query_failed", message: err?.message || String(err) });
    }
  },
};
