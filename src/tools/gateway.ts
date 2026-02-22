/**
 * gateway tool — จัดการระบบ MyClaw (system management)
 * Ported from OpenClaw: openclaw/src/agents/tools/gateway-tool.ts
 *
 * ใน OpenClaw: จัดการ Gateway server ผ่าน WebSocket RPC
 * ใน MyClaw: จัดการ local system (status, config, restart, logs)
 *
 * Actions:
 * - status: แสดง system health (uptime, memory, AI provider, stats)
 * - config.get: อ่าน runtime config
 * - config.set: แก้ runtime config (in-memory override)
 * - restart: restart process (ให้ process manager จัดการ)
 * - logs: แสดง recent logs
 *
 * Security: เฉพาะ owner userId เท่านั้น (ถ้ามี OWNER_USER_ID ใน env)
 */

import type { ToolDefinition, ToolContext } from "./types.js";
import { getDb } from "../memory/store.js";

// ===== In-memory log buffer =====
const LOG_BUFFER_SIZE = 500;
const logBuffer: Array<{ ts: string; level: string; msg: string }> = [];

// Override console.log/error to capture logs
const origLog = console.log;
const origError = console.error;

console.log = (...args: unknown[]) => {
  const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  logBuffer.push({ ts: new Date().toISOString(), level: "info", msg });
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
  origLog.apply(console, args);
};

console.error = (...args: unknown[]) => {
  const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  logBuffer.push({ ts: new Date().toISOString(), level: "error", msg });
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
  origError.apply(console, args);
};

// ===== Runtime config overrides =====
const configOverrides = new Map<string, string>();

export function getConfigOverride(key: string): string | undefined {
  return configOverrides.get(key);
}

// ===== Owner check =====
function isOwner(userId?: string): boolean {
  const ownerIds = process.env.OWNER_USER_ID?.trim();
  if (!ownerIds) return true; // No restriction if not set
  if (!userId) return false;
  return ownerIds.split(",").map((s) => s.trim()).includes(userId);
}

// ===== Tool definition =====
export const gatewayTool: ToolDefinition = {
  name: "gateway",
  description:
    "System management tool for MyClaw. Owner-only. Actions: " +
    '"status" to show system health (uptime, memory, provider, stats), ' +
    '"config.get" to view runtime configuration, ' +
    '"config.set" to change runtime config (key + value), ' +
    '"restart" to restart the process, ' +
    '"logs" to view recent system logs. ' +
    "Use when asked about system status, configuration, or admin operations.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["status", "config.get", "config.set", "restart", "logs"],
        description: "Action to perform.",
      },
      key: {
        type: "string",
        description: 'Config key for config.set (e.g. "GEMINI_MODEL", "MAX_HISTORY").',
      },
      value: {
        type: "string",
        description: "Config value for config.set.",
      },
      reason: {
        type: "string",
        description: "Reason for restart (max 200 chars).",
      },
      lines: {
        type: "number",
        description: "Number of log lines to return (default 50, max 500).",
      },
      level: {
        type: "string",
        enum: ["all", "info", "error"],
        description: 'Filter logs by level (default "all").',
      },
    },
    required: ["action"],
  },

  execute: async (input, context?: ToolContext) => {
    const action = typeof input.action === "string" ? input.action.trim() : "";

    // Owner check
    if (!isOwner(context?.userId)) {
      return JSON.stringify({ error: "forbidden", message: "This tool is restricted to the bot owner." });
    }

    const dataDir = process.env.DATA_DIR || "./data";

    try {
      switch (action) {
        // ===== status =====
        case "status": {
          const mem = process.memoryUsage();
          const uptime = process.uptime();

          // DB stats
          let dbStats: Record<string, number> = {};
          try {
            const db = getDb(dataDir);
            const sessions = (db.prepare("SELECT COUNT(DISTINCT session_id) as cnt FROM sessions").get() as any)?.cnt || 0;
            const messages = (db.prepare("SELECT COUNT(*) as cnt FROM sessions").get() as any)?.cnt || 0;
            const memories = (db.prepare("SELECT COUNT(*) as cnt FROM chunks").get() as any)?.cnt || 0;

            let cronJobs = 0;
            try { cronJobs = (db.prepare("SELECT COUNT(*) as cnt FROM cron_jobs").get() as any)?.cnt || 0; } catch { /* table may not exist */ }

            let bgTasks = 0;
            try { bgTasks = (db.prepare("SELECT COUNT(*) as cnt FROM background_tasks WHERE status = 'running'").get() as any)?.cnt || 0; } catch { /* table may not exist */ }

            dbStats = { sessions, messages, memories, cronJobs, backgroundTasks: bgTasks };
          } catch { /* DB not available */ }

          // Active provider
          const provider = process.env.GEMINI_API_KEY?.trim() ? "gemini"
            : process.env.OLLAMA_MODEL?.trim() ? "ollama"
            : process.env.ANTHROPIC_API_KEY?.trim() ? "anthropic" : "none";

          return JSON.stringify({
            uptime: {
              seconds: Math.round(uptime),
              human: formatUptime(uptime),
            },
            memory: {
              heapUsed: formatBytes(mem.heapUsed),
              heapTotal: formatBytes(mem.heapTotal),
              rss: formatBytes(mem.rss),
              external: formatBytes(mem.external),
            },
            node: process.version,
            platform: process.platform,
            provider,
            model: provider === "gemini" ? (process.env.GEMINI_MODEL?.trim() || "gemini-2.0-flash")
              : provider === "ollama" ? process.env.OLLAMA_MODEL?.trim()
              : provider === "anthropic" ? "claude-sonnet-4" : null,
            db: dbStats,
            configOverrides: Object.fromEntries(configOverrides),
            logBufferSize: logBuffer.length,
          });
        }

        // ===== config.get =====
        case "config.get": {
          // Show non-sensitive config
          const SENSITIVE = new Set([
            "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "LINE_CHANNEL_SECRET",
            "LINE_CHANNEL_ACCESS_TOKEN", "BRAVE_API_KEY", "PERPLEXITY_API_KEY",
            "XAI_API_KEY", "OPENROUTER_API_KEY",
          ]);

          const config: Record<string, string> = {};
          const envKeys = [
            "GEMINI_MODEL", "OLLAMA_MODEL", "OLLAMA_BASE_URL",
            "DATA_DIR", "PORT", "WEB_SEARCH_PROVIDER", "GEMINI_TTS_MODEL",
            "OWNER_USER_ID",
          ];

          for (const key of envKeys) {
            const override = configOverrides.get(key);
            const env = process.env[key]?.trim();
            if (override) {
              config[key] = `${override} (override)`;
            } else if (env) {
              config[key] = env;
            }
          }

          // Show which sensitive keys are set (without values)
          for (const key of SENSITIVE) {
            if (process.env[key]?.trim()) {
              config[key] = "***set***";
            }
          }

          return JSON.stringify({
            config,
            overrides: Object.fromEntries(configOverrides),
          });
        }

        // ===== config.set =====
        case "config.set": {
          const key = typeof input.key === "string" ? input.key.trim() : "";
          const value = typeof input.value === "string" ? input.value : "";

          if (!key) return JSON.stringify({ error: "missing_key", message: "key is required." });

          // Block setting sensitive keys
          const BLOCKED = new Set(["LINE_CHANNEL_SECRET", "LINE_CHANNEL_ACCESS_TOKEN"]);
          if (BLOCKED.has(key)) {
            return JSON.stringify({ error: "blocked", message: `Cannot override ${key} at runtime.` });
          }

          configOverrides.set(key, value);
          // Also set in process.env for immediate effect
          process.env[key] = value;

          console.log(`[gateway] Config override: ${key} = ${value}`);
          return JSON.stringify({
            success: true,
            action: "config.set",
            key,
            value,
            message: `Runtime config "${key}" set. Note: Some changes may require restart to take effect.`,
          });
        }

        // ===== restart =====
        case "restart": {
          const reason = typeof input.reason === "string"
            ? input.reason.trim().substring(0, 200)
            : "Requested via gateway tool";

          console.log(`[gateway] Restart requested: ${reason}`);

          // Schedule restart after response
          setTimeout(() => {
            console.log("[gateway] Restarting...");
            process.exit(0);
          }, 1000);

          return JSON.stringify({
            success: true,
            action: "restart",
            reason,
            message: "Restarting in 1 second... (process manager will restart the app)",
          });
        }

        // ===== logs =====
        case "logs": {
          const lines = typeof input.lines === "number" ? Math.max(1, Math.min(500, input.lines)) : 50;
          const level = typeof input.level === "string" ? input.level.trim() : "all";

          let filtered = logBuffer;
          if (level === "info") {
            filtered = logBuffer.filter((l) => l.level === "info");
          } else if (level === "error") {
            filtered = logBuffer.filter((l) => l.level === "error");
          }

          const logs = filtered.slice(-lines);

          return JSON.stringify({
            totalBuffered: logBuffer.length,
            returned: logs.length,
            level,
            logs: logs.map((l) => `[${l.ts}] [${l.level}] ${l.msg}`),
          });
        }

        default:
          return JSON.stringify({
            error: "unknown_action",
            message: `Unknown action "${action}". Available: status, config.get, config.set, restart, logs.`,
          });
      }
    } catch (err: any) {
      return JSON.stringify({ error: "action_failed", action, message: err?.message || String(err) });
    }
  },
};

// ===== Helpers =====
function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1048576).toFixed(1)}MB`;
}
