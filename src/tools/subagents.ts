/**
 * subagents tool — จัดการ background tasks ที่ spawn ไว้
 * Ported from OpenClaw: openclaw/src/agents/tools/subagents-tool.ts
 *
 * ใน OpenClaw: จัดการ subagent sessions (list, kill, steer)
 * ใน MyClaw: จัดการ background AI tasks (list, kill, status)
 *
 * Actions:
 * - list: แสดง tasks ทั้งหมด (active + recent)
 * - kill: ยกเลิก task ที่กำลังรัน
 * - status: ดูรายละเอียดของ task
 */

import type { ToolDefinition, ToolContext } from "./types.js";
import { getRunningTasks, getTasksFromDb, cancelTask, steerTask, type BackgroundTask } from "./sessions-spawn.js";

function formatTask(task: BackgroundTask, isRunning: boolean): Record<string, unknown> {
  const runtimeMs = isRunning
    ? Date.now() - new Date(task.created_at).getTime()
    : task.completed_at
      ? new Date(task.completed_at).getTime() - new Date(task.created_at).getTime()
      : 0;

  return {
    id: task.id,
    label: task.label,
    status: task.status,
    model: task.model,
    runtimeSeconds: Math.round(runtimeMs / 1000),
    task: task.task.length > 200 ? task.task.substring(0, 200) + "..." : task.task,
    result: task.result
      ? (task.result.length > 300 ? task.result.substring(0, 300) + "..." : task.result)
      : null,
    createdAt: task.created_at,
    completedAt: task.completed_at,
    isRunning,
  };
}

export const subagentsTool: ToolDefinition = {
  name: "subagents",
  description:
    "Manage background AI tasks spawned by sessions_spawn. Actions: " +
    '"list" to show all active and recent tasks, ' +
    '"kill" to cancel a running task (provide target: task ID or "all"), ' +
    '"steer" to redirect a running task with new instructions (cancels current work, restarts with new message), ' +
    '"status" to view detailed status of a specific task.',
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["list", "kill", "steer", "status"],
        description: "Action to perform. Default: list.",
      },
      target: {
        type: "string",
        description: 'Task ID for kill/steer/status, or "all" to kill all running tasks.',
      },
      message: {
        type: "string",
        description: "New instructions for steer action (max 4000 chars). The task will restart with this new direction.",
      },
      recentMinutes: {
        type: "number",
        description: "Time window for recent tasks in minutes (default 30, max 1440).",
      },
    },
    required: [],
  },

  execute: async (input, context?: ToolContext) => {
    const dataDir = process.env.DATA_DIR || "./data";
    const action = typeof input.action === "string" ? input.action.trim() : "list";
    const running = getRunningTasks();

    try {
      switch (action) {
        // ===== list =====
        case "list": {
          const recentMinutes = typeof input.recentMinutes === "number"
            ? Math.max(1, Math.min(1440, input.recentMinutes))
            : 30;

          const allTasks = getTasksFromDb(dataDir, 50);
          const cutoff = Date.now() - recentMinutes * 60 * 1000;

          const activeTasks = allTasks.filter((t) => t.status === "running");
          const recentTasks = allTasks.filter(
            (t) => t.status !== "running" && t.completed_at && new Date(t.completed_at).getTime() >= cutoff,
          );

          return JSON.stringify({
            active: activeTasks.map((t) => formatTask(t, running.has(t.id))),
            recent: recentTasks.map((t) => formatTask(t, false)),
            activeCount: activeTasks.length,
            recentCount: recentTasks.length,
            recentMinutes,
          });
        }

        // ===== kill =====
        case "kill": {
          const target = typeof input.target === "string" ? input.target.trim() : "";
          if (!target) {
            return JSON.stringify({ error: "missing_target", message: 'Provide target: task ID or "all".' });
          }

          if (target === "all" || target === "*") {
            let killed = 0;
            const killedLabels: string[] = [];

            for (const [taskId, entry] of running) {
              // Only kill tasks for this user (or all if no context)
              if (!context?.userId || entry.task.user_id === context.userId) {
                cancelTask(taskId, dataDir);
                killedLabels.push(entry.task.label);
                killed++;
              }
            }

            return JSON.stringify({
              success: true,
              action: "kill",
              target: "all",
              killedCount: killed,
              killedLabels,
            });
          }

          // Single task
          const entry = running.get(target);
          if (!entry) {
            return JSON.stringify({
              error: "not_found",
              message: `Task "${target}" not found or not running. Use "list" to see tasks.`,
            });
          }

          cancelTask(target, dataDir);

          return JSON.stringify({
            success: true,
            action: "kill",
            killedTask: { id: target, label: entry.task.label },
          });
        }

        // ===== steer =====
        case "steer": {
          const target = typeof input.target === "string" ? input.target.trim() : "";
          const message = typeof input.message === "string" ? input.message.trim().substring(0, 4000) : "";
          if (!target) return JSON.stringify({ error: "missing_target", message: "Provide target: task ID." });
          if (!message) return JSON.stringify({ error: "missing_message", message: "Provide message: new instructions for the task." });

          const result = steerTask(target, message, process.env.DATA_DIR || "./data");
          if (!result) {
            return JSON.stringify({
              error: "not_found",
              message: `Task "${target}" not found or not running. Use "list" to see tasks.`,
            });
          }

          return JSON.stringify({
            success: true,
            action: "steer",
            oldTaskId: target,
            newTaskId: result.newTaskId,
            message: "Task interrupted and restarted with new instructions.",
          });
        }

        // ===== status =====
        case "status": {
          const target = typeof input.target === "string" ? input.target.trim() : "";
          if (!target) {
            return JSON.stringify({ error: "missing_target", message: "Provide target: task ID." });
          }

          // Check running first
          const runEntry = running.get(target);
          if (runEntry) {
            return JSON.stringify({
              found: true,
              ...formatTask(runEntry.task, true),
            });
          }

          // Check DB
          const allTasks = getTasksFromDb(dataDir, 100);
          const dbTask = allTasks.find((t) => t.id === target);
          if (dbTask) {
            return JSON.stringify({
              found: true,
              ...formatTask(dbTask, false),
              // Show full result for status query
              fullResult: dbTask.result,
            });
          }

          return JSON.stringify({
            error: "not_found",
            message: `Task "${target}" not found.`,
          });
        }

        default:
          return JSON.stringify({
            error: "unknown_action",
            message: `Unknown action "${action}". Available: list, kill, steer, status.`,
          });
      }
    } catch (err: any) {
      return JSON.stringify({ error: "action_failed", action, message: err?.message || String(err) });
    }
  },
};
