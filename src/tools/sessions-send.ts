/**
 * sessions_send tool — ส่งข้อความข้าม user sessions
 * Ported from OpenClaw: openclaw/src/agents/tools/sessions-send-tool.ts
 *
 * ใน OpenClaw: ส่งข้อความข้าม agent sessions (agent-to-agent)
 * ใน MyClaw: ส่งข้อความข้าม user conversations ผ่าน LINE push
 *
 * Security: restrict ให้เฉพาะ owner userId (ถ้ามี OWNER_USER_ID)
 * เพราะส่ง push message ได้ทุก user → อาจถูกใช้ spam
 */

import type { ToolDefinition, ToolContext } from "./types.js";
import { lineClient } from "../line.js";
import { getDb } from "../memory/store.js";

function isOwner(userId?: string): boolean {
  const ownerIds = process.env.OWNER_USER_ID?.trim();
  if (!ownerIds) return true;
  if (!userId) return false;
  return ownerIds.split(",").map((s) => s.trim()).includes(userId);
}

export const sessionsSendTool: ToolDefinition = {
  name: "sessions_send",
  description:
    "Send a message to another user's session via LINE push message. " +
    "Owner-only for security. Use when you need to send a message to a different user, " +
    "relay information between users, or broadcast an announcement. " +
    "The message will appear as a regular LINE message from the bot.",
  inputSchema: {
    type: "object" as const,
    properties: {
      targetUserId: {
        type: "string",
        description: "The target user's LINE user ID (required).",
      },
      message: {
        type: "string",
        description: "Text message to send (required).",
      },
      asBot: {
        type: "boolean",
        description: "If true, prefix message with bot name. Default: false.",
      },
    },
    required: ["targetUserId", "message"],
  },

  execute: async (input, context?: ToolContext) => {
    // Owner check
    if (!isOwner(context?.userId)) {
      return JSON.stringify({ error: "forbidden", message: "sessions_send is restricted to the bot owner." });
    }

    const targetUserId = typeof input.targetUserId === "string" ? input.targetUserId.trim() : "";
    const message = typeof input.message === "string" ? input.message.trim() : "";

    if (!targetUserId) return JSON.stringify({ error: "missing_target", message: "targetUserId is required." });
    if (!message) return JSON.stringify({ error: "missing_message", message: "message is required." });

    const asBot = input.asBot === true;
    const text = asBot ? `🤖 MyClaw: ${message}` : message;

    try {
      await lineClient.pushMessage({
        to: targetUserId,
        messages: [{ type: "text", text }],
      });

      // Also log to the target user's session history
      const dataDir = process.env.DATA_DIR || "./data";
      try {
        const db = getDb(dataDir);
        db.prepare(
          "INSERT INTO sessions (session_id, role, content, created_at) VALUES (?, 'assistant', ?, ?)",
        ).run(targetUserId, text, Date.now());
      } catch { /* session table may not be ready */ }

      console.log(`[sessions_send] ${context?.userId} → ${targetUserId}: "${message.substring(0, 60)}"`);
      return JSON.stringify({
        success: true,
        action: "sessions_send",
        from: context?.userId || "system",
        to: targetUserId,
        messageLength: text.length,
      });
    } catch (err: any) {
      return JSON.stringify({ error: "send_failed", message: err?.message || String(err) });
    }
  },
};
