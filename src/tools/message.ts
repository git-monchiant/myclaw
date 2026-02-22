/**
 * message tool — ส่ง/จัดการข้อความ LINE
 * Ported from OpenClaw: openclaw/src/agents/tools/message-tool.ts + openclaw/src/line/send.ts
 *
 * Actions:
 * - push: ส่ง push message (ไม่ต้องมี reply token)
 * - push_image: ส่งรูปภาพ
 * - get_profile: ดูข้อมูล user (ชื่อ, รูปโปรไฟล์)
 */

import type { ToolDefinition, ToolContext } from "./types.js";
import { getDb } from "../memory/store.js";

export const messageTool: ToolDefinition = {
  name: "message",
  description:
    "Send LINE messages, images, or get user profile. Actions: " +
    '"push" to send a text push message to a user (proactive notification), ' +
    '"push_image" to push an image directly to a user (proactive, costs quota), ' +
    '"send_image" to include an image in the current reply (free, preferred for normal replies), ' +
    '"get_profile" to get user info (name, picture, status), ' +
    '"broadcast" to send a text message to ALL users who have interacted with the bot, ' +
    '"multicast" to send a text message to multiple specific users at once. ' +
    "To send images: 1) use web_search to find relevant pages, 2) use web_fetch with extractMode='images' on a result URL to get direct image URLs, 3) pick the best one and use send_image or push_image. " +
    "The imageUrl MUST be a direct image URL (https://...jpg/png or CDN URL), NOT a web page URL.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["push", "push_image", "send_image", "get_profile", "broadcast", "multicast"],
        description: "Action to perform.",
      },
      userId: {
        type: "string",
        description: "Target user ID. Defaults to current user if not specified.",
      },
      message: {
        type: "string",
        description: 'Text message to send (for "push" action).',
      },
      imageUrl: {
        type: "string",
        description: 'Direct image URL (for "send_image" or "push_image"). Must be HTTPS and a direct image file URL, not a web page.',
      },
      previewUrl: {
        type: "string",
        description: "Preview image URL (optional, uses imageUrl if not specified).",
      },
      userIds: {
        type: "array",
        items: { type: "string" },
        description: "Array of user IDs for multicast (max 500).",
      },
    },
    required: ["action"],
  },

  execute: async (input, context?: ToolContext) => {
    const action = typeof input.action === "string" ? input.action.trim() : "";
    const client = context?.lineClient;

    if (!client) {
      return JSON.stringify({ error: "no_client", message: "LINE client not available." });
    }

    const targetUserId = (typeof input.userId === "string" && input.userId.trim())
      ? input.userId.trim()
      : context?.userId;

    if (!targetUserId) {
      return JSON.stringify({ error: "no_user", message: "No userId specified." });
    }

    try {
      switch (action) {
        // ===== push: ส่งข้อความ =====
        case "push": {
          const message = typeof input.message === "string" ? input.message.trim() : "";
          if (!message) {
            return JSON.stringify({ error: "missing_message", message: "Message text is required for push." });
          }

          await client.pushMessage({
            to: targetUserId,
            messages: [{ type: "text", text: message }],
          });

          console.log(`[message] Pushed text to ${targetUserId}: "${message.substring(0, 50)}..."`);
          return JSON.stringify({ success: true, action: "push", to: targetUserId });
        }

        // ===== push_image: ส่งรูปภาพผ่าน push (เสีย quota แต่ใช้ได้ทุกเวลา) =====
        case "push_image": {
          const imageUrl = typeof input.imageUrl === "string" ? input.imageUrl.trim() : "";
          if (!imageUrl) {
            return JSON.stringify({ error: "missing_image_url", message: "imageUrl is required for push_image." });
          }

          const previewUrl = (typeof input.previewUrl === "string" && input.previewUrl.trim()) || imageUrl;

          await client.pushMessage({
            to: targetUserId,
            messages: [{
              type: "image",
              originalContentUrl: imageUrl,
              previewImageUrl: previewUrl,
            }],
          });

          console.log(`[message] Pushed image to ${targetUserId}: ${imageUrl.substring(0, 80)}`);
          return JSON.stringify({ success: true, action: "push_image", to: targetUserId, imageUrl });
        }

        // ===== send_image: ส่งรูปภาพ (ผ่าน reply ไม่เสียเงิน) =====
        case "send_image": {
          const imageUrl = typeof input.imageUrl === "string" ? input.imageUrl.trim() : "";
          if (!imageUrl) {
            return JSON.stringify({ error: "missing_image_url", message: "imageUrl is required for send_image." });
          }

          // Return imageUrl → ai.ts จะ detect แล้วส่งใน reply (ไม่ต้อง push)
          console.log(`[message] Image ready for reply: ${imageUrl.substring(0, 80)}`);
          return JSON.stringify({ success: true, action: "send_image", imageUrl });
        }

        // ===== get_profile: ดูข้อมูล user =====
        case "get_profile": {
          const profile = await client.getProfile(targetUserId);

          console.log(`[message] Got profile for ${targetUserId}: ${profile.displayName}`);
          return JSON.stringify({
            success: true,
            action: "get_profile",
            displayName: profile.displayName,
            pictureUrl: profile.pictureUrl || null,
            statusMessage: profile.statusMessage || null,
            userId: targetUserId,
          });
        }

        // ===== broadcast: ส่งข้อความหาทุก user ที่เคย chat =====
        case "broadcast": {
          const message = typeof input.message === "string" ? input.message.trim() : "";
          if (!message) {
            return JSON.stringify({ error: "missing_message", message: "Message text is required for broadcast." });
          }

          // Get all unique user IDs from sessions
          const dataDir = process.env.DATA_DIR || "./data";
          const db = getDb(dataDir);
          const rows = db.prepare(
            "SELECT DISTINCT session_id FROM sessions WHERE session_id != ''",
          ).all() as Array<{ session_id: string }>;

          const userIds = rows.map((r) => r.session_id).filter(Boolean);

          if (userIds.length === 0) {
            return JSON.stringify({ error: "no_users", message: "No users found to broadcast to." });
          }

          // LINE multicast API (max 500 per call)
          let sent = 0;
          let failed = 0;
          const batchSize = 500;

          for (let i = 0; i < userIds.length; i += batchSize) {
            const batch = userIds.slice(i, i + batchSize);
            try {
              await client.multicast({
                to: batch,
                messages: [{ type: "text", text: message }],
              });
              sent += batch.length;
            } catch (err: any) {
              console.error(`[message] Broadcast batch failed:`, err?.message);
              failed += batch.length;
            }
          }

          console.log(`[message] Broadcast to ${sent}/${userIds.length} users`);
          return JSON.stringify({
            success: true,
            action: "broadcast",
            totalUsers: userIds.length,
            sent,
            failed,
          });
        }

        // ===== multicast: ส่งข้อความหาหลาย user พร้อมกัน =====
        case "multicast": {
          const message = typeof input.message === "string" ? input.message.trim() : "";
          if (!message) {
            return JSON.stringify({ error: "missing_message", message: "Message text is required for multicast." });
          }

          const userIds = Array.isArray(input.userIds)
            ? input.userIds.filter((id): id is string => typeof id === "string" && id.trim() !== "").map((id) => id.trim())
            : [];

          if (userIds.length === 0) {
            return JSON.stringify({ error: "missing_user_ids", message: "userIds array is required for multicast." });
          }

          if (userIds.length > 500) {
            return JSON.stringify({ error: "too_many_users", message: "Maximum 500 users per multicast." });
          }

          try {
            await client.multicast({
              to: userIds,
              messages: [{ type: "text", text: message }],
            });

            console.log(`[message] Multicast to ${userIds.length} users`);
            return JSON.stringify({
              success: true,
              action: "multicast",
              userCount: userIds.length,
            });
          } catch (err: any) {
            return JSON.stringify({ error: "multicast_failed", message: err?.message || String(err) });
          }
        }

        default:
          return JSON.stringify({
            error: "unknown_action",
            message: `Unknown action "${action}". Available: push, push_image, send_image, get_profile, broadcast, multicast.`,
          });
      }
    } catch (err: any) {
      console.error(`[message] Error (${action}):`, err?.message || err);
      return JSON.stringify({
        error: "action_failed",
        action,
        message: err?.message || String(err),
      });
    }
  },
};
