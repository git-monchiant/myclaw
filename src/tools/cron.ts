/**
 * cron tool — ตั้งเวลาทำงานอัตโนมัติ (scheduled messages / reminders)
 * Ported from OpenClaw: openclaw/src/agents/tools/cron-tool.ts
 *
 * Actions:
 * - status: สถานะ scheduler
 * - list: แสดง jobs ทั้งหมด
 * - add: เพิ่ม job ใหม่ (cron expression หรือ ISO datetime)
 * - update: แก้ไข job (partial update)
 * - remove: ลบ job
 * - run: trigger job ทันที
 *
 * เก็บ jobs ใน SQLite, schedule ด้วย node-cron
 * เมื่อถึงเวลา → push message ไปหา user ผ่าน LINE API
 */

import cron from "node-cron";
import crypto from "crypto";
import type { ToolDefinition, ToolContext } from "./types.js";
import { getDb } from "../memory/store.js";
import { lineClient } from "../line.js";

// ===== Types =====
interface CronJob {
  id: string;
  name: string;
  schedule: string;
  schedule_type: "cron" | "once";
  message: string;
  target_user_id: string;
  timezone: string;
  enabled: number;
  delete_after_run: number;
  run_count: number;
  last_run_at: string | null;
  last_status: string | null;
  last_error: string | null;
  created_at: string;
}

// Active scheduled tasks (in-memory, rebuilt from DB on startup)
const activeTasks = new Map<string, { stop: () => void }>();
const schedulerStartedAt = Date.now();

// ===== DB Schema =====
let tableReady = false;

function ensureCronTable(dataDir: string): void {
  if (tableReady) return;

  const db = getDb(dataDir);
  db.exec(`
    CREATE TABLE IF NOT EXISTS cron_jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      schedule TEXT NOT NULL,
      schedule_type TEXT NOT NULL DEFAULT 'cron',
      message TEXT NOT NULL,
      target_user_id TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'Asia/Bangkok',
      enabled INTEGER DEFAULT 1,
      delete_after_run INTEGER DEFAULT 0,
      run_count INTEGER DEFAULT 0,
      last_run_at TEXT,
      last_status TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL
    );
  `);

  // Execution history table (runs)
  db.exec(`
    CREATE TABLE IF NOT EXISTS cron_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL,
      job_name TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (job_id) REFERENCES cron_jobs(id) ON DELETE CASCADE
    );
  `);

  // Safe migrations for existing DBs
  const cols = db.prepare("PRAGMA table_info(cron_jobs)").all() as Array<{ name: string }>;
  const colNames = new Set(cols.map((c) => c.name));
  if (!colNames.has("timezone")) db.exec("ALTER TABLE cron_jobs ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Asia/Bangkok'");
  if (!colNames.has("delete_after_run")) db.exec("ALTER TABLE cron_jobs ADD COLUMN delete_after_run INTEGER DEFAULT 0");
  if (!colNames.has("run_count")) db.exec("ALTER TABLE cron_jobs ADD COLUMN run_count INTEGER DEFAULT 0");
  if (!colNames.has("last_status")) db.exec("ALTER TABLE cron_jobs ADD COLUMN last_status TEXT");
  if (!colNames.has("last_error")) db.exec("ALTER TABLE cron_jobs ADD COLUMN last_error TEXT");

  tableReady = true;
}

// ===== Job execution =====
async function executeJob(job: CronJob, dataDir: string): Promise<{ success: boolean; error?: string }> {
  console.log(`[cron] Executing job "${job.name}" → ${job.target_user_id}`);
  const db = getDb(dataDir);
  const startedAt = new Date().toISOString();

  try {
    await lineClient.pushMessage({
      to: job.target_user_id,
      messages: [{ type: "text", text: `⏰ ${job.message}` }],
    });

    const completedAt = new Date().toISOString();

    // Update state
    db.prepare(`
      UPDATE cron_jobs SET last_run_at = ?, last_status = 'success', last_error = NULL, run_count = run_count + 1
      WHERE id = ?
    `).run(completedAt, job.id);

    // Log run history
    db.prepare(`
      INSERT INTO cron_runs (job_id, job_name, status, error, started_at, completed_at)
      VALUES (?, ?, 'success', NULL, ?, ?)
    `).run(job.id, job.name, startedAt, completedAt);

    // If one-time or delete_after_run → cleanup
    if (job.schedule_type === "once" || job.delete_after_run) {
      if (job.delete_after_run) {
        db.prepare("DELETE FROM cron_jobs WHERE id = ?").run(job.id);
        console.log(`[cron] Job "${job.name}" deleted after run`);
      } else {
        db.prepare("UPDATE cron_jobs SET enabled = 0 WHERE id = ?").run(job.id);
        console.log(`[cron] One-time job "${job.name}" completed and disabled`);
      }
      const task = activeTasks.get(job.id);
      if (task) {
        task.stop();
        activeTasks.delete(job.id);
      }
    }

    return { success: true };
  } catch (err: any) {
    const errorMsg = err?.message || String(err);
    const completedAt = new Date().toISOString();
    console.error(`[cron] Job "${job.name}" failed:`, errorMsg);

    db.prepare(`
      UPDATE cron_jobs SET last_run_at = ?, last_status = 'error', last_error = ?, run_count = run_count + 1
      WHERE id = ?
    `).run(completedAt, errorMsg.substring(0, 500), job.id);

    // Log run history
    db.prepare(`
      INSERT INTO cron_runs (job_id, job_name, status, error, started_at, completed_at)
      VALUES (?, ?, 'error', ?, ?, ?)
    `).run(job.id, job.name, errorMsg.substring(0, 500), startedAt, completedAt);

    return { success: false, error: errorMsg };
  }
}

// ===== Schedule a job =====
function scheduleJob(job: CronJob, dataDir: string): boolean {
  // Stop existing task if any
  const existing = activeTasks.get(job.id);
  if (existing) {
    existing.stop();
    activeTasks.delete(job.id);
  }

  if (!job.enabled) return false;

  if (job.schedule_type === "once") {
    const targetTime = new Date(job.schedule).getTime();
    const delay = targetTime - Date.now();

    if (delay <= 0) {
      console.log(`[cron] One-time job "${job.name}" is in the past, skipping`);
      return false;
    }

    const timeoutId = setTimeout(() => {
      executeJob(job, dataDir);
      activeTasks.delete(job.id);
    }, delay);

    activeTasks.set(job.id, { stop: () => clearTimeout(timeoutId) });
    console.log(`[cron] Scheduled one-time "${job.name}" at ${job.schedule} (in ${Math.round(delay / 60000)}m)`);
    return true;
  }

  // Recurring: cron expression
  if (!cron.validate(job.schedule)) {
    console.error(`[cron] Invalid cron expression for "${job.name}": ${job.schedule}`);
    return false;
  }

  const task = cron.schedule(job.schedule, () => {
    executeJob(job, dataDir);
  }, { timezone: job.timezone || "Asia/Bangkok" });

  activeTasks.set(job.id, task);
  console.log(`[cron] Scheduled recurring "${job.name}": ${job.schedule} (${job.timezone})`);
  return true;
}

// ===== Load all jobs from DB on startup =====
export function initCronJobs(dataDir: string): void {
  ensureCronTable(dataDir);

  const db = getDb(dataDir);
  const jobs = db.prepare("SELECT * FROM cron_jobs WHERE enabled = 1").all() as CronJob[];

  console.log(`[cron] Loading ${jobs.length} active job(s)`);
  for (const job of jobs) {
    scheduleJob(job, dataDir);
  }
}

// ===== Format job for response =====
function formatJob(j: CronJob): Record<string, unknown> {
  return {
    id: j.id,
    name: j.name,
    schedule: j.schedule,
    scheduleType: j.schedule_type,
    message: j.message,
    timezone: j.timezone,
    enabled: !!j.enabled,
    deleteAfterRun: !!j.delete_after_run,
    runCount: j.run_count || 0,
    lastRunAt: j.last_run_at,
    lastStatus: j.last_status,
    lastError: j.last_error,
    createdAt: j.created_at,
    isScheduled: activeTasks.has(j.id),
  };
}

// ===== Tool definition =====
export const cronTool: ToolDefinition = {
  name: "cron",
  description:
    "Schedule recurring or one-time messages/reminders. Actions: " +
    '"status" to show scheduler health, ' +
    '"list" to show all scheduled jobs, ' +
    '"add" to create a new job (provide name, schedule, message), ' +
    '"update" to modify an existing job (provide jobId + fields to change), ' +
    '"remove" to delete a job by ID, ' +
    '"run" to trigger a job immediately, ' +
    '"runs" to view execution history for a job (or all jobs), ' +
    '"wake" to re-enable a disabled/paused job and reschedule it. ' +
    'Schedule formats: cron expression (e.g. "0 8 * * *" = daily 8am, "30 18 * * 1-5" = weekdays 6:30pm) or ISO datetime for one-time (e.g. "2026-03-01T09:00"). ' +
    "Default timezone: Asia/Bangkok. Use this for reminders, alarms, periodic notifications.",
  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: ["status", "list", "add", "update", "remove", "run", "runs", "wake"],
        description: "Action to perform.",
      },
      jobId: {
        type: "string",
        description: 'Job ID (for "update", "remove", "run", "runs", or "wake").',
      },
      limit: {
        type: "number",
        description: 'Number of run history entries to return (for "runs", default 20, max 100).',
      },
      name: {
        type: "string",
        description: 'Job name (for "add" or "update").',
      },
      schedule: {
        type: "string",
        description: 'Cron expression or ISO datetime (for "add" or "update").',
      },
      message: {
        type: "string",
        description: 'Message to send when triggered (for "add" or "update").',
      },
      timezone: {
        type: "string",
        description: 'Timezone (e.g. "Asia/Bangkok", "Asia/Tokyo"). Default: Asia/Bangkok.',
      },
      enabled: {
        type: "boolean",
        description: 'Enable/disable job (for "update").',
      },
      deleteAfterRun: {
        type: "boolean",
        description: "If true, delete job after it runs once (for add/update).",
      },
    },
    required: ["action"],
  },

  execute: async (input, context?: ToolContext) => {
    const dataDir = process.env.DATA_DIR || "./data";
    ensureCronTable(dataDir);

    const action = typeof input.action === "string" ? input.action.trim() : "";
    const db = getDb(dataDir);

    try {
      switch (action) {
        // ===== status =====
        case "status": {
          const total = (db.prepare("SELECT COUNT(*) as cnt FROM cron_jobs").get() as { cnt: number }).cnt;
          const active = (db.prepare("SELECT COUNT(*) as cnt FROM cron_jobs WHERE enabled = 1").get() as { cnt: number }).cnt;
          const errored = (db.prepare("SELECT COUNT(*) as cnt FROM cron_jobs WHERE last_status = 'error'").get() as { cnt: number }).cnt;

          return JSON.stringify({
            schedulerUptime: Math.round((Date.now() - schedulerStartedAt) / 1000),
            totalJobs: total,
            activeJobs: active,
            scheduledInMemory: activeTasks.size,
            erroredJobs: errored,
            timezone: "Asia/Bangkok",
          });
        }

        // ===== list =====
        case "list": {
          const jobs = db.prepare("SELECT * FROM cron_jobs ORDER BY enabled DESC, created_at DESC").all() as CronJob[];

          return JSON.stringify({
            totalJobs: jobs.length,
            activeJobs: jobs.filter((j) => j.enabled).length,
            jobs: jobs.map(formatJob),
          });
        }

        // ===== add =====
        case "add": {
          const name = typeof input.name === "string" ? input.name.trim() : "";
          const schedule = typeof input.schedule === "string" ? input.schedule.trim() : "";
          const message = typeof input.message === "string" ? input.message.trim() : "";
          const timezone = typeof input.timezone === "string" ? input.timezone.trim() : "Asia/Bangkok";
          const deleteAfterRun = input.deleteAfterRun === true;

          if (!name) return JSON.stringify({ error: "missing_name", message: "name is required." });
          if (!schedule) return JSON.stringify({ error: "missing_schedule", message: "schedule is required." });
          if (!message) return JSON.stringify({ error: "missing_message", message: "message is required." });

          const targetUserId = context?.userId;
          if (!targetUserId) return JSON.stringify({ error: "no_user", message: "No userId available." });

          // Detect schedule type
          let scheduleType: "cron" | "once" = "cron";
          if (/^\d{4}-\d{2}-\d{2}/.test(schedule)) {
            scheduleType = "once";
            const d = new Date(schedule);
            if (isNaN(d.getTime())) {
              return JSON.stringify({ error: "invalid_date", message: `Invalid datetime: ${schedule}` });
            }
            if (d.getTime() <= Date.now()) {
              return JSON.stringify({ error: "past_date", message: "Cannot schedule in the past." });
            }
          } else if (!cron.validate(schedule)) {
            return JSON.stringify({
              error: "invalid_schedule",
              message: `Invalid cron expression: "${schedule}". Examples: "0 8 * * *" (daily 8am), "*/30 * * * *" (every 30min).`,
            });
          }

          const id = crypto.randomUUID().substring(0, 8);
          const now = new Date().toISOString();
          const job: CronJob = {
            id, name, schedule, schedule_type: scheduleType, message,
            target_user_id: targetUserId, timezone, enabled: 1,
            delete_after_run: deleteAfterRun ? 1 : 0,
            run_count: 0, last_run_at: null, last_status: null, last_error: null,
            created_at: now,
          };

          db.prepare(`
            INSERT INTO cron_jobs (id, name, schedule, schedule_type, message, target_user_id, timezone, enabled, delete_after_run, run_count, last_run_at, last_status, last_error, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(id, name, schedule, scheduleType, message, targetUserId, timezone, 1, job.delete_after_run, 0, null, null, null, now);

          const scheduled = scheduleJob(job, dataDir);

          console.log(`[cron] Added job "${name}" (${id}): ${schedule}`);
          return JSON.stringify({ success: true, action: "add", job: formatJob(job), scheduled });
        }

        // ===== update =====
        case "update": {
          const jobId = typeof input.jobId === "string" ? input.jobId.trim() : "";
          if (!jobId) return JSON.stringify({ error: "missing_job_id", message: "jobId is required." });

          const existing = db.prepare("SELECT * FROM cron_jobs WHERE id = ?").get(jobId) as CronJob | undefined;
          if (!existing) return JSON.stringify({ error: "not_found", message: `Job "${jobId}" not found.` });

          // Build patch
          const updates: string[] = [];
          const values: unknown[] = [];

          if (typeof input.name === "string" && input.name.trim()) {
            updates.push("name = ?");
            values.push(input.name.trim());
          }
          if (typeof input.message === "string" && input.message.trim()) {
            updates.push("message = ?");
            values.push(input.message.trim());
          }
          if (typeof input.timezone === "string" && input.timezone.trim()) {
            updates.push("timezone = ?");
            values.push(input.timezone.trim());
          }
          if (typeof input.enabled === "boolean") {
            updates.push("enabled = ?");
            values.push(input.enabled ? 1 : 0);
          }
          if (typeof input.deleteAfterRun === "boolean") {
            updates.push("delete_after_run = ?");
            values.push(input.deleteAfterRun ? 1 : 0);
          }

          // Schedule change requires re-validation
          if (typeof input.schedule === "string" && input.schedule.trim()) {
            const newSchedule = input.schedule.trim();
            let newType: "cron" | "once" = "cron";

            if (/^\d{4}-\d{2}-\d{2}/.test(newSchedule)) {
              newType = "once";
              const d = new Date(newSchedule);
              if (isNaN(d.getTime())) {
                return JSON.stringify({ error: "invalid_date", message: `Invalid datetime: ${newSchedule}` });
              }
            } else if (!cron.validate(newSchedule)) {
              return JSON.stringify({ error: "invalid_schedule", message: `Invalid cron expression: "${newSchedule}".` });
            }

            updates.push("schedule = ?", "schedule_type = ?");
            values.push(newSchedule, newType);
          }

          if (updates.length === 0) {
            return JSON.stringify({ error: "no_changes", message: "No fields to update. Provide name, schedule, message, timezone, enabled, or deleteAfterRun." });
          }

          values.push(jobId);
          db.prepare(`UPDATE cron_jobs SET ${updates.join(", ")} WHERE id = ?`).run(...values);

          // Reload and reschedule
          const updated = db.prepare("SELECT * FROM cron_jobs WHERE id = ?").get(jobId) as CronJob;
          scheduleJob(updated, dataDir);

          console.log(`[cron] Updated job "${updated.name}" (${jobId})`);
          return JSON.stringify({ success: true, action: "update", job: formatJob(updated) });
        }

        // ===== remove =====
        case "remove": {
          const jobId = typeof input.jobId === "string" ? input.jobId.trim() : "";
          if (!jobId) return JSON.stringify({ error: "missing_job_id", message: "jobId is required." });

          const job = db.prepare("SELECT * FROM cron_jobs WHERE id = ?").get(jobId) as CronJob | undefined;
          if (!job) return JSON.stringify({ error: "not_found", message: `Job "${jobId}" not found.` });

          const task = activeTasks.get(jobId);
          if (task) {
            task.stop();
            activeTasks.delete(jobId);
          }

          db.prepare("DELETE FROM cron_jobs WHERE id = ?").run(jobId);

          console.log(`[cron] Removed job "${job.name}" (${jobId})`);
          return JSON.stringify({ success: true, action: "remove", removedJob: { id: jobId, name: job.name } });
        }

        // ===== run =====
        case "run": {
          const jobId = typeof input.jobId === "string" ? input.jobId.trim() : "";
          if (!jobId) return JSON.stringify({ error: "missing_job_id", message: "jobId is required." });

          const job = db.prepare("SELECT * FROM cron_jobs WHERE id = ?").get(jobId) as CronJob | undefined;
          if (!job) return JSON.stringify({ error: "not_found", message: `Job "${jobId}" not found.` });

          const result = await executeJob(job, dataDir);

          return JSON.stringify({
            success: result.success,
            action: "run",
            job: { id: jobId, name: job.name, message: job.message },
            error: result.error || undefined,
          });
        }

        // ===== runs (execution history) =====
        case "runs": {
          const jobId = typeof input.jobId === "string" ? input.jobId.trim() : "";
          const limit = typeof input.limit === "number" ? Math.max(1, Math.min(100, input.limit)) : 20;

          let runs;
          if (jobId) {
            // Runs for specific job
            runs = db.prepare(
              "SELECT * FROM cron_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?",
            ).all(jobId, limit) as Array<{
              id: number; job_id: string; job_name: string; status: string;
              error: string | null; started_at: string; completed_at: string | null;
            }>;
          } else {
            // All recent runs
            runs = db.prepare(
              "SELECT * FROM cron_runs ORDER BY started_at DESC LIMIT ?",
            ).all(limit) as Array<{
              id: number; job_id: string; job_name: string; status: string;
              error: string | null; started_at: string; completed_at: string | null;
            }>;
          }

          return JSON.stringify({
            action: "runs",
            jobId: jobId || null,
            count: runs.length,
            runs: runs.map((r) => ({
              runId: r.id,
              jobId: r.job_id,
              jobName: r.job_name,
              status: r.status,
              error: r.error,
              startedAt: r.started_at,
              completedAt: r.completed_at,
              durationMs: r.completed_at && r.started_at
                ? new Date(r.completed_at).getTime() - new Date(r.started_at).getTime()
                : null,
            })),
          });
        }

        // ===== wake (re-enable disabled job) =====
        case "wake": {
          const jobId = typeof input.jobId === "string" ? input.jobId.trim() : "";
          if (!jobId) return JSON.stringify({ error: "missing_job_id", message: "jobId is required." });

          const job = db.prepare("SELECT * FROM cron_jobs WHERE id = ?").get(jobId) as CronJob | undefined;
          if (!job) return JSON.stringify({ error: "not_found", message: `Job "${jobId}" not found.` });

          if (job.enabled) {
            // Already enabled, just re-schedule
            const scheduled = scheduleJob(job, dataDir);
            return JSON.stringify({ success: true, action: "wake", message: "Job was already enabled.", job: formatJob(job), scheduled });
          }

          // Re-enable
          db.prepare("UPDATE cron_jobs SET enabled = 1, last_error = NULL WHERE id = ?").run(jobId);
          const updated = db.prepare("SELECT * FROM cron_jobs WHERE id = ?").get(jobId) as CronJob;
          const scheduled = scheduleJob(updated, dataDir);

          console.log(`[cron] Woke job "${updated.name}" (${jobId})`);
          return JSON.stringify({ success: true, action: "wake", job: formatJob(updated), scheduled });
        }

        default:
          return JSON.stringify({ error: "unknown_action", message: `Unknown action "${action}". Available: status, list, add, update, remove, run, runs, wake.` });
      }
    } catch (err: any) {
      console.error(`[cron] Error (${action}):`, err?.message || err);
      return JSON.stringify({ error: "action_failed", action, message: err?.message || String(err) });
    }
  },
};
