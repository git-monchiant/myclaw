/**
 * session_status tool — แสดงสถานะระบบ + session ปัจจุบัน
 */

import type { ToolDefinition, ToolContext } from "./types.js";
import { getDb } from "../memory/store.js";

const startedAt = Date.now();

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export const sessionStatusTool: ToolDefinition = {
  name: "session_status",
  description:
    "Show current system status: uptime, AI provider, memory stats, and current user's session info. " +
    "Use when the user asks about system status, bot info, or their session.",
  inputSchema: {
    type: "object" as const,
    properties: {},
    required: [],
  },
  execute: async (_input, context?: ToolContext) => {
    const dataDir = process.env.DATA_DIR || "./data";

    // AI provider info
    const provider = process.env.GEMINI_API_KEY?.trim()
      ? "gemini"
      : process.env.OLLAMA_MODEL?.trim()
        ? "ollama"
        : process.env.ANTHROPIC_API_KEY?.trim()
          ? "anthropic"
          : "none";

    const model =
      provider === "gemini"
        ? process.env.GEMINI_MODEL?.trim() || "gemini-2.0-flash"
        : provider === "ollama"
          ? process.env.OLLAMA_MODEL?.trim() || "unknown"
          : provider === "anthropic"
            ? "claude-sonnet-4"
            : "none";

    // DB stats
    let totalUsers = 0;
    let totalMessages = 0;
    let totalChunks = 0;
    let userMessages = 0;
    let userLastActive = "";

    try {
      const db = getDb(dataDir);

      const usersRow = db.prepare("SELECT COUNT(DISTINCT session_id) as cnt FROM sessions").get() as { cnt: number };
      totalUsers = usersRow.cnt;

      const msgsRow = db.prepare("SELECT COUNT(*) as cnt FROM sessions").get() as { cnt: number };
      totalMessages = msgsRow.cnt;

      const chunksRow = db.prepare("SELECT COUNT(*) as cnt FROM chunks").get() as { cnt: number };
      totalChunks = chunksRow.cnt;

      // Current user stats
      if (context?.userId) {
        const userRow = db.prepare(
          "SELECT COUNT(*) as cnt, MAX(created_at) as last_active FROM sessions WHERE session_id = ?",
        ).get(context.userId) as { cnt: number; last_active: number | null };
        userMessages = userRow.cnt;
        if (userRow.last_active) {
          userLastActive = new Date(userRow.last_active).toISOString();
        }
      }
    } catch (err: any) {
      console.error("[session_status] DB error:", err?.message);
    }

    return JSON.stringify({
      uptime: formatUptime(Date.now() - startedAt),
      startedAt: new Date(startedAt).toISOString(),
      aiProvider: provider,
      aiModel: model,
      totalUsers,
      totalMessages,
      totalMemoryChunks: totalChunks,
      currentUser: context?.userId
        ? {
            userId: context.userId,
            messageCount: userMessages,
            lastActive: userLastActive || null,
          }
        : null,
    });
  },
};
