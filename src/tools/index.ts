import type { ToolDefinition, ToolContext } from "./types.js";
import { datetimeTool } from "./datetime.js";
import { webSearchTool } from "./web-search.js";
import { webFetchTool } from "./web-fetch.js";
import { memorySearchTool } from "./memory-search.js";
import { memoryGetTool } from "./memory-get.js";
import { imageTool } from "./image.js";
import { ttsTool } from "./tts.js";
import { messageTool } from "./message.js";
import { sessionStatusTool } from "./session-status.js";
import { sessionsListTool } from "./sessions-list.js";
import { sessionsHistoryTool } from "./sessions-history.js";
import { agentsListTool } from "./agents-list.js";
import { cronTool, initCronJobs } from "./cron.js";
import { sessionsSpawnTool } from "./sessions-spawn.js";
import { subagentsTool } from "./subagents.js";
import { gatewayTool } from "./gateway.js";
import { canvasTool } from "./canvas.js";
import { browserTool } from "./browser.js";
import { nodesTool } from "./nodes.js";
import { sessionsSendTool } from "./sessions-send.js";

/**
 * Tool Registry
 *
 * เพิ่ม tool ใหม่ 3 ขั้นตอน:
 * 1. สร้างไฟล์ใน src/tools/ (implement ToolDefinition)
 * 2. import เข้ามาที่นี่
 * 3. เพิ่มใน array ข้างล่าง
 */
const allTools: ToolDefinition[] = [
  datetimeTool,
  webSearchTool,
  webFetchTool,
  memorySearchTool,
  memoryGetTool,
  imageTool,
  ttsTool,
  messageTool,
  sessionStatusTool,
  sessionsListTool,
  sessionsHistoryTool,
  agentsListTool,
  cronTool,
  sessionsSpawnTool,
  subagentsTool,
  gatewayTool,
  canvasTool,
  browserTool,
  nodesTool,
  sessionsSendTool,
];

// Initialize cron jobs from DB on startup
try {
  initCronJobs(process.env.DATA_DIR || "./data");
} catch (err) {
  console.error("[cron] Failed to initialize:", err);
}

// หา tool จากชื่อ
export function findTool(name: string): ToolDefinition | undefined {
  return allTools.find((t) => t.name === name);
}

// แปลง tools เป็น format ที่ Claude API ต้องการ
export function getToolDefinitions() {
  return allTools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }));
}

// รัน tool ตามชื่อ
export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  context?: ToolContext,
): Promise<string> {
  const tool = findTool(name);
  if (!tool) {
    return `Error: tool "${name}" not found`;
  }
  try {
    return await tool.execute(input, context);
  } catch (err) {
    return `Error executing ${name}: ${err}`;
  }
}

export type { ToolDefinition, ToolContext } from "./types.js";
