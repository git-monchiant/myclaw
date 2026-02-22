/**
 * nodes tool — จัดการอุปกรณ์ / notifications / location
 * Ported from OpenClaw: openclaw/src/agents/tools/nodes-tool.ts
 *
 * ใน OpenClaw: ควบคุมอุปกรณ์ผ่าน Gateway (camera, screen, run commands, etc.)
 * ใน MyClaw: ใช้ LINE API สำหรับ notifications + location + node registry
 *
 * Actions:
 * - status: แสดง registered nodes
 * - notify: ส่ง notification ผ่าน LINE push message
 * - location_request: ขอ location จาก user (ส่ง LINE location request)
 * - register: ลงทะเบียน node (เก็บใน DB)
 * - unregister: ยกเลิก node
 * - list: แสดง nodes ทั้งหมด
 * - describe: ดูรายละเอียด node
 *
 * Note: Camera, screen recording, run commands ไม่รองรับใน LINE bot mode
 *       (ต้องมี companion app ซึ่ง MyClaw อาจเพิ่มในอนาคต)
 */

import type { ToolDefinition, ToolContext } from "./types.js";
import { getDb } from "../memory/store.js";
import { lineClient } from "../line.js";
import crypto from "crypto";

// ===== DB Schema =====
let tableReady = false;

function ensureNodesTable(dataDir: string): void {
  if (tableReady) return;
  const db = getDb(dataDir);
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'generic',
      owner_user_id TEXT NOT NULL,
      capabilities TEXT DEFAULT '[]',
      metadata TEXT DEFAULT '{}',
      last_seen_at TEXT,
      created_at TEXT NOT NULL
    );
  `);
  tableReady = true;
}

interface NodeRecord {
  id: string;
  name: string;
  type: string;
  owner_user_id: string;
  capabilities: string;
  metadata: string;
  last_seen_at: string | null;
  created_at: string;
}

function formatNode(n: NodeRecord): Record<string, unknown> {
  let caps: string[] = [];
  let meta: Record<string, unknown> = {};
  try { caps = JSON.parse(n.capabilities); } catch { /* ignore */ }
  try { meta = JSON.parse(n.metadata); } catch { /* ignore */ }

  return {
    id: n.id,
    name: n.name,
    type: n.type,
    ownerUserId: n.owner_user_id,
    capabilities: caps,
    metadata: meta,
    lastSeenAt: n.last_seen_at,
    createdAt: n.created_at,
  };
}

export const nodesTool: ToolDefinition = {
  name: "nodes",
  description:
    "Manage devices and send notifications. Actions: " +
    '"status" show all registered nodes overview, ' +
    '"list" list all nodes with details, ' +
    '"describe" get detailed info about a specific node, ' +
    '"register" register a new node/device, ' +
    '"unregister" remove a node, ' +
    '"notify" send a notification to a user via LINE push (with title, body, priority), ' +
    '"location_request" ask user to share their location via LINE. ' +
    "Use for: sending alerts/notifications, requesting user location, managing IoT-like devices.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["status", "list", "describe", "register", "unregister", "notify", "location_request"],
        description: "Action to perform.",
      },
      nodeId: {
        type: "string",
        description: "Node ID (for describe/unregister).",
      },
      // register
      name: {
        type: "string",
        description: "Node name (for register).",
      },
      nodeType: {
        type: "string",
        description: 'Node type: "phone", "desktop", "iot", "server", "generic" (for register).',
      },
      capabilities: {
        type: "array",
        items: { type: "string" },
        description: 'Node capabilities list (e.g. ["notify", "location", "camera"]) (for register).',
      },
      // notify
      title: {
        type: "string",
        description: "Notification title.",
      },
      body: {
        type: "string",
        description: "Notification body text.",
      },
      targetUserId: {
        type: "string",
        description: "Target user ID for notify/location_request (default: current user).",
      },
      priority: {
        type: "string",
        enum: ["normal", "important", "urgent"],
        description: "Notification priority (affects emoji prefix).",
      },
    },
    required: ["action"],
  },

  execute: async (input, context?: ToolContext) => {
    const dataDir = process.env.DATA_DIR || "./data";
    ensureNodesTable(dataDir);
    const db = getDb(dataDir);
    const action = typeof input.action === "string" ? input.action.trim() : "";

    try {
      switch (action) {
        // ===== status =====
        case "status": {
          const total = (db.prepare("SELECT COUNT(*) as cnt FROM nodes").get() as any)?.cnt || 0;
          const byType = db.prepare(`
            SELECT type, COUNT(*) as cnt FROM nodes GROUP BY type
          `).all() as Array<{ type: string; cnt: number }>;

          return JSON.stringify({
            totalNodes: total,
            byType: Object.fromEntries(byType.map((r) => [r.type, r.cnt])),
            capabilities: ["notify", "location_request"],
            note: "MyClaw nodes currently support LINE-based notifications and location requests. " +
                  "Camera, screen recording, and command execution require a companion app (future feature).",
          });
        }

        // ===== list =====
        case "list": {
          const nodes = db.prepare("SELECT * FROM nodes ORDER BY last_seen_at DESC NULLS LAST").all() as NodeRecord[];
          return JSON.stringify({
            count: nodes.length,
            nodes: nodes.map(formatNode),
          });
        }

        // ===== describe =====
        case "describe": {
          const nodeId = typeof input.nodeId === "string" ? input.nodeId.trim() : "";
          if (!nodeId) return JSON.stringify({ error: "missing_node_id", message: "nodeId is required." });

          const node = db.prepare("SELECT * FROM nodes WHERE id = ?").get(nodeId) as NodeRecord | undefined;
          if (!node) return JSON.stringify({ error: "not_found", message: `Node "${nodeId}" not found.` });

          return JSON.stringify({ found: true, ...formatNode(node) });
        }

        // ===== register =====
        case "register": {
          const name = typeof input.name === "string" ? input.name.trim() : "";
          if (!name) return JSON.stringify({ error: "missing_name", message: "name is required." });

          const userId = context?.userId;
          if (!userId) return JSON.stringify({ error: "no_user", message: "No userId available." });

          const nodeType = typeof input.nodeType === "string" ? input.nodeType.trim() : "generic";
          const capabilities = Array.isArray(input.capabilities) ? input.capabilities : ["notify"];

          const id = crypto.randomUUID().substring(0, 8);
          const now = new Date().toISOString();

          db.prepare(`
            INSERT INTO nodes (id, name, type, owner_user_id, capabilities, metadata, last_seen_at, created_at)
            VALUES (?, ?, ?, ?, ?, '{}', ?, ?)
          `).run(id, name, nodeType, userId, JSON.stringify(capabilities), now, now);

          console.log(`[nodes] Registered node "${name}" (${id}) for ${userId}`);
          return JSON.stringify({
            success: true,
            action: "register",
            node: { id, name, type: nodeType, capabilities },
          });
        }

        // ===== unregister =====
        case "unregister": {
          const nodeId = typeof input.nodeId === "string" ? input.nodeId.trim() : "";
          if (!nodeId) return JSON.stringify({ error: "missing_node_id", message: "nodeId is required." });

          const node = db.prepare("SELECT * FROM nodes WHERE id = ?").get(nodeId) as NodeRecord | undefined;
          if (!node) return JSON.stringify({ error: "not_found", message: `Node "${nodeId}" not found.` });

          db.prepare("DELETE FROM nodes WHERE id = ?").run(nodeId);
          console.log(`[nodes] Unregistered node "${node.name}" (${nodeId})`);

          return JSON.stringify({ success: true, action: "unregister", removed: { id: nodeId, name: node.name } });
        }

        // ===== notify =====
        case "notify": {
          const title = typeof input.title === "string" ? input.title.trim() : "";
          const body = typeof input.body === "string" ? input.body.trim() : "";
          const priority = typeof input.priority === "string" ? input.priority.trim() : "normal";

          if (!title && !body) {
            return JSON.stringify({ error: "missing_content", message: "title or body is required." });
          }

          const targetUserId = (typeof input.targetUserId === "string" && input.targetUserId.trim()) || context?.userId;
          if (!targetUserId) return JSON.stringify({ error: "no_target", message: "No target userId." });

          const emoji = priority === "urgent" ? "🚨" : priority === "important" ? "⚡" : "🔔";
          const text = title && body
            ? `${emoji} ${title}\n\n${body}`
            : `${emoji} ${title || body}`;

          await lineClient.pushMessage({
            to: targetUserId,
            messages: [{ type: "text", text }],
          });

          console.log(`[nodes] Notification sent to ${targetUserId}: ${title || body}`);
          return JSON.stringify({ success: true, action: "notify", to: targetUserId, priority });
        }

        // ===== location_request =====
        case "location_request": {
          const targetUserId = (typeof input.targetUserId === "string" && input.targetUserId.trim()) || context?.userId;
          if (!targetUserId) return JSON.stringify({ error: "no_target", message: "No target userId." });

          // LINE Quick Reply with location action
          await lineClient.pushMessage({
            to: targetUserId,
            messages: [{
              type: "text",
              text: "📍 กรุณาแชร์ตำแหน่งของคุณ (กดปุ่มด้านล่าง)",
              quickReply: {
                items: [{
                  type: "action",
                  action: {
                    type: "location",
                    label: "แชร์ตำแหน่ง",
                  },
                }],
              },
            }],
          });

          console.log(`[nodes] Location request sent to ${targetUserId}`);
          return JSON.stringify({
            success: true,
            action: "location_request",
            to: targetUserId,
            message: "Location request sent. User will see a quick reply button to share their location.",
          });
        }

        default:
          return JSON.stringify({
            error: "unknown_action",
            message: `Unknown action "${action}". Available: status, list, describe, register, unregister, notify, location_request.`,
          });
      }
    } catch (err: any) {
      return JSON.stringify({ error: "action_failed", action, message: err?.message || String(err) });
    }
  },
};
