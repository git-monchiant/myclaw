/**
 * sessions_spawn tool — สร้าง background AI task
 * Ported from OpenClaw: openclaw/src/agents/tools/sessions-spawn-tool.ts
 *
 * ใน OpenClaw: spawn isolated agent session ผ่าน Gateway
 * ใน MyClaw: spawn background AI call, เก็บผลใน DB, แจ้ง user ผ่าน LINE push
 *
 * Features:
 * - Background execution (ไม่ block main conversation)
 * - Model override (ใช้ model อื่นได้)
 * - Task timeout
 * - Auto-announce result กลับหา user
 * - Task state tracking (running/completed/failed/cancelled)
 * - AbortController สำหรับ cancel
 */

import crypto from "crypto";
import type { ToolDefinition, ToolContext } from "./types.js";
import { getDb } from "../memory/store.js";
import { lineClient } from "../line.js";

// ===== Types =====
export interface BackgroundTask {
  id: string;
  label: string;
  task: string;
  status: "running" | "completed" | "failed" | "cancelled";
  result: string | null;
  model: string | null;
  user_id: string;
  created_at: string;
  completed_at: string | null;
}

// In-memory registry of running tasks
const runningTasks = new Map<string, {
  task: BackgroundTask;
  abortController: AbortController;
  startedAt: number;
}>();

// ===== Exports for subagents tool =====
export function getRunningTasks(): Map<string, { task: BackgroundTask; abortController: AbortController; startedAt: number }> {
  return runningTasks;
}

export function getTasksFromDb(dataDir: string, limit = 20): BackgroundTask[] {
  ensureTasksTable(dataDir);
  const db = getDb(dataDir);
  return db.prepare("SELECT * FROM background_tasks ORDER BY created_at DESC LIMIT ?").all(limit) as BackgroundTask[];
}

export function cancelTask(taskId: string, dataDir: string): boolean {
  const running = runningTasks.get(taskId);
  if (running) {
    running.abortController.abort();
    running.task.status = "cancelled";
    runningTasks.delete(taskId);

    const db = getDb(dataDir);
    db.prepare("UPDATE background_tasks SET status = 'cancelled', completed_at = ? WHERE id = ?")
      .run(new Date().toISOString(), taskId);
    return true;
  }
  return false;
}

/**
 * Steer a running task — cancel current work and restart with new instructions.
 * Like OpenClaw's steer: interrupts, sends steer message, restarts.
 */
export function steerTask(taskId: string, newMessage: string, dataDir: string): { newTaskId: string } | null {
  const running = runningTasks.get(taskId);
  if (!running) return null;

  const originalTask = running.task;

  // Cancel the current task
  running.abortController.abort();
  runningTasks.delete(taskId);

  const db = getDb(dataDir);
  db.prepare("UPDATE background_tasks SET status = 'cancelled', result = 'Steered to new task', completed_at = ? WHERE id = ?")
    .run(new Date().toISOString(), taskId);

  // Create a new task with the steer message appended
  const newId = crypto.randomUUID().substring(0, 8);
  const now = new Date().toISOString();
  const combinedTask = `Original task: ${originalTask.task}\n\n--- UPDATED INSTRUCTIONS ---\n${newMessage}`;
  const newLabel = `[steered] ${originalTask.label}`;

  const newTaskRecord: BackgroundTask = {
    id: newId,
    label: newLabel,
    task: combinedTask,
    status: "running",
    result: null,
    model: originalTask.model,
    user_id: originalTask.user_id,
    created_at: now,
    completed_at: null,
  };

  db.prepare(`
    INSERT INTO background_tasks (id, label, task, status, result, model, user_id, created_at, completed_at)
    VALUES (?, ?, ?, 'running', NULL, ?, ?, ?, NULL)
  `).run(newId, newLabel, combinedTask, originalTask.model, originalTask.user_id, now);

  // Create new AbortController
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), 120 * 1000);

  runningTasks.set(newId, { task: newTaskRecord, abortController, startedAt: Date.now() });

  // Fire and forget
  executeBackgroundTask(newId, combinedTask, originalTask.user_id, originalTask.model, dataDir, abortController.signal)
    .finally(() => clearTimeout(timeoutId));

  console.log(`[spawn] Steered task ${taskId} → ${newId}`);
  return { newTaskId: newId };
}

// ===== DB Schema =====
let tableReady = false;

function ensureTasksTable(dataDir: string): void {
  if (tableReady) return;
  const db = getDb(dataDir);
  db.exec(`
    CREATE TABLE IF NOT EXISTS background_tasks (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      task TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      result TEXT,
      model TEXT,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
  `);
  tableReady = true;
}

// ===== Provider detection (same as ai.ts) =====
function getActiveProvider(): { provider: string; model: string } {
  if (process.env.GEMINI_API_KEY?.trim()) {
    return { provider: "gemini", model: process.env.GEMINI_MODEL?.trim() || "gemini-2.0-flash" };
  }
  if (process.env.OLLAMA_MODEL?.trim()) {
    return { provider: "ollama", model: process.env.OLLAMA_MODEL.trim() };
  }
  if (process.env.ANTHROPIC_API_KEY?.trim()) {
    return { provider: "anthropic", model: "claude-sonnet-4-20250514" };
  }
  return { provider: "none", model: "" };
}

// ===== Background AI execution =====
async function executeBackgroundTask(
  taskId: string,
  taskPrompt: string,
  userId: string,
  model: string | null,
  dataDir: string,
  signal: AbortSignal,
): Promise<void> {
  const { provider, model: defaultModel } = getActiveProvider();
  const useModel = model || defaultModel;

  try {
    let result: string;

    if (signal.aborted) throw new Error("Task cancelled before start");

    if (provider === "gemini") {
      result = await callGeminiSimple(taskPrompt, useModel, signal);
    } else if (provider === "ollama") {
      result = await callOllamaSimple(taskPrompt, useModel, signal);
    } else if (provider === "anthropic") {
      result = await callAnthropicSimple(taskPrompt, useModel, signal);
    } else {
      throw new Error("No AI provider configured");
    }

    if (signal.aborted) throw new Error("Task cancelled");

    // Update DB
    const db = getDb(dataDir);
    db.prepare("UPDATE background_tasks SET status = 'completed', result = ?, completed_at = ? WHERE id = ?")
      .run(result.substring(0, 10000), new Date().toISOString(), taskId);

    // Announce result to user
    const shortResult = result.length > 1500 ? result.substring(0, 1500) + "..." : result;
    try {
      await lineClient.pushMessage({
        to: userId,
        messages: [{ type: "text", text: `✅ Task เสร็จแล้ว!\n\n${shortResult}` }],
      });
    } catch (pushErr) {
      console.error(`[spawn] Failed to push result to ${userId}:`, pushErr);
    }

    console.log(`[spawn] Task ${taskId} completed (${result.length} chars)`);
  } catch (err: any) {
    if (signal.aborted) {
      console.log(`[spawn] Task ${taskId} cancelled`);
      return;
    }

    const errorMsg = err?.message || String(err);
    console.error(`[spawn] Task ${taskId} failed:`, errorMsg);

    const db = getDb(dataDir);
    db.prepare("UPDATE background_tasks SET status = 'failed', result = ?, completed_at = ? WHERE id = ?")
      .run(`Error: ${errorMsg.substring(0, 5000)}`, new Date().toISOString(), taskId);

    // Notify user about failure
    try {
      await lineClient.pushMessage({
        to: userId,
        messages: [{ type: "text", text: `❌ Task ล้มเหลว: ${errorMsg.substring(0, 200)}` }],
      });
    } catch { /* ignore push errors */ }
  } finally {
    runningTasks.delete(taskId);
  }
}

// ===== Simple AI calls (one-shot, no tool use) =====

async function callGeminiSimple(task: string, model: string, signal: AbortSignal): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: "You are a helpful assistant. Complete the given task thoroughly and return the result." }] },
        contents: [{ role: "user", parts: [{ text: task }] }],
        generationConfig: { maxOutputTokens: 8192 },
      }),
      signal,
    },
  );

  if (!res.ok) throw new Error(`Gemini ${res.status}: ${await res.text()}`);
  const json = await res.json() as any;
  return json.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("\n") || "(no response)";
}

async function callOllamaSimple(task: string, model: string, signal: AbortSignal): Promise<string> {
  const baseUrl = process.env.OLLAMA_BASE_URL?.trim() || "http://localhost:11434";

  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "You are a helpful assistant. Complete the given task thoroughly and return the result." },
        { role: "user", content: task },
      ],
      max_tokens: 4096,
      stream: false,
    }),
    signal,
  });

  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  const json = await res.json() as any;
  return json.choices?.[0]?.message?.content || "(no response)";
}

async function callAnthropicSimple(task: string, model: string, signal: AbortSignal): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: "You are a helpful assistant. Complete the given task thoroughly and return the result.",
      messages: [{ role: "user", content: task }],
    }),
    signal,
  });

  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const json = await res.json() as any;
  const textBlocks = json.content?.filter((b: any) => b.type === "text") || [];
  return textBlocks.map((b: any) => b.text).join("\n") || "(no response)";
}

// ===== Tool definition =====
const MAX_CHILDREN = 5;

export const sessionsSpawnTool: ToolDefinition = {
  name: "sessions_spawn",
  description:
    "Spawn a background AI task that runs independently from the current conversation. " +
    "The result will be automatically sent back to the user when complete. " +
    "Use for tasks that take long to process, research tasks, or when you need to work on something " +
    "while keeping the conversation responsive. " +
    "Examples: summarize a long article, research a topic, generate content, translate large text.",
  inputSchema: {
    type: "object" as const,
    properties: {
      task: {
        type: "string",
        description: "The task to execute (be specific and detailed).",
      },
      label: {
        type: "string",
        description: "Short label for the task (e.g. 'Summarize article', 'Research topic'). Default: auto-generated.",
      },
      model: {
        type: "string",
        description: "Model override (e.g. 'gemini-2.0-flash', 'gemini-2.5-pro'). Default: current provider's model.",
      },
      timeoutSeconds: {
        type: "number",
        description: "Execution timeout in seconds (default 120, max 600).",
      },
    },
    required: ["task"],
  },

  execute: async (input, context?: ToolContext) => {
    const dataDir = process.env.DATA_DIR || "./data";
    ensureTasksTable(dataDir);

    const task = typeof input.task === "string" ? input.task.trim() : "";
    if (!task) return JSON.stringify({ error: "missing_task", message: "task is required." });

    const userId = context?.userId;
    if (!userId) return JSON.stringify({ error: "no_user", message: "No userId available." });

    // Check running tasks limit
    let userRunning = 0;
    for (const [, entry] of runningTasks) {
      if (entry.task.user_id === userId) userRunning++;
    }
    if (userRunning >= MAX_CHILDREN) {
      return JSON.stringify({
        error: "limit_exceeded",
        message: `Maximum ${MAX_CHILDREN} concurrent tasks per user. Use subagents tool to manage existing tasks.`,
      });
    }

    const label = typeof input.label === "string" && input.label.trim()
      ? input.label.trim()
      : task.substring(0, 50) + (task.length > 50 ? "..." : "");

    const model = typeof input.model === "string" && input.model.trim()
      ? input.model.trim()
      : null;

    const timeoutSec = typeof input.timeoutSeconds === "number"
      ? Math.max(10, Math.min(600, input.timeoutSeconds))
      : 120;

    const id = crypto.randomUUID().substring(0, 8);
    const now = new Date().toISOString();

    const taskRecord: BackgroundTask = {
      id,
      label,
      task,
      status: "running",
      result: null,
      model,
      user_id: userId,
      created_at: now,
      completed_at: null,
    };

    // Save to DB
    const db = getDb(dataDir);
    db.prepare(`
      INSERT INTO background_tasks (id, label, task, status, result, model, user_id, created_at, completed_at)
      VALUES (?, ?, ?, 'running', NULL, ?, ?, ?, NULL)
    `).run(id, label, task, model, userId, now);

    // Create AbortController with timeout
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), timeoutSec * 1000);

    // Register in memory
    runningTasks.set(id, { task: taskRecord, abortController, startedAt: Date.now() });

    // Fire and forget
    executeBackgroundTask(id, task, userId, model, dataDir, abortController.signal)
      .finally(() => clearTimeout(timeoutId));

    const { provider, model: defaultModel } = getActiveProvider();

    console.log(`[spawn] Started task ${id} "${label}" for ${userId} (model: ${model || defaultModel})`);

    return JSON.stringify({
      status: "accepted",
      taskId: id,
      label,
      model: model || defaultModel,
      provider,
      timeoutSeconds: timeoutSec,
      message: "Task started in background. Result will be sent to you automatically when complete.",
    });
  },
};
