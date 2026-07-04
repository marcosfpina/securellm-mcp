/**
 * Notify Hook — ADR-0005
 *
 * Async notifications for long-running operations.
 *
 * Channels:
 *   ntfy.sh  — zero-config, public/private topics
 *   gotify   — self-hosted push notifications
 *   discord  — webhook-based
 *   local    — notify-send (D-Bus, Linux desktop)
 *
 * Modes:
 *   send  — fire a notification now
 *   watch — monitor a PID and notify on exit
 */

import { z } from "zod";
import type { ExtendedTool } from "../types/mcp-tool-extensions.js";

// ─── Schema ──────────────────────────────────────────────────────────────────

const notifyHookSchema = z.object({
  action: z.enum(["send", "watch"]).describe("Send now or watch a process"),
  // send
  channel: z
    .enum(["ntfy.sh", "gotify", "discord", "local"])
    .optional()
    .default("local")
    .describe("Notification channel"),
  message: z.string().describe("Notification body"),
  title: z.string().optional().default("MCP Server").describe("Notification title"),
  priority: z.enum(["low", "normal", "high"]).optional().default("normal"),
  url: z.string().optional().describe("Custom webhook URL (overrides default channel URL)"),
  // watch
  pid: z.number().int().positive().optional().describe("PID to watch"),
  command: z.string().optional().describe("Run command and notify when it finishes"),
  notify_on_exit: z.boolean().optional().default(true),
  timeout_ms: z.number().int().min(1000).max(300000).optional().default(60000),
});

// ─── Tool definition ──────────────────────────────────────────────────────────

export const notifyHookTool: ExtendedTool = {
  name: "notify_hook",
  description:
    "Async notifications: send to ntfy.sh, Gotify, Discord, or local desktop. Also supports PID watch mode for long-running tasks (ADR-0005).",
  defer_loading: true,
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["send", "watch"],
        description: "Send now or watch a process",
      },
      channel: {
        type: "string",
        enum: ["ntfy.sh", "gotify", "discord", "local"],
        description: "Notification channel (default: local)",
      },
      message: { type: "string", description: "Notification body" },
      title: { type: "string", description: "Notification title" },
      priority: { type: "string", enum: ["low", "normal", "high"], description: "Priority level" },
      url: { type: "string", description: "Custom webhook URL" },
      pid: { type: "number", description: "PID to watch" },
      command: { type: "string", description: "Run command and notify when done" },
      notify_on_exit: { type: "boolean", description: "Notify when process exits (default: true)" },
      timeout_ms: { type: "number", description: "Max wait time in ms (default: 60000)" },
    },
    required: ["action", "message"],
  },
};

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleNotifyHook(
  args: z.infer<typeof notifyHookSchema>
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const { action } = args;

  try {
    if (action === "send") {
      return await sendNotification(args);
    } else if (action === "watch") {
      return await watchProcess(args);
    }
    return {
      content: [{ type: "text", text: JSON.stringify({ error: `Unknown action: ${action}` }) }],
    };
  } catch (err: any) {
    return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }] };
  }
}

// ─── Send ────────────────────────────────────────────────────────────────────

async function sendNotification(args: {
  channel?: string;
  message: string;
  title?: string;
  priority?: string;
  url?: string;
}) {
  const { channel = "local", message, title = "MCP Server", priority = "normal", url } = args;
  const result: any = { channel, sent: false };

  try {
    switch (channel) {
      case "ntfy.sh": {
        const topic = process.env.NTFY_TOPIC || "securellm-mcp";
        const ntfyUrl = url || `https://ntfy.sh/${topic}`;
        const resp = await fetch(ntfyUrl, {
          method: "POST",
          headers: {
            Title: title,
            Priority: priority,
            Tags: "computer",
          },
          body: message,
          signal: AbortSignal.timeout(5_000),
        });
        result.sent = resp.ok;
        result.status = resp.status;
        break;
      }

      case "gotify": {
        const gotifyUrl = url || process.env.GOTIFY_URL;
        const gotifyToken = process.env.GOTIFY_TOKEN;
        if (!gotifyUrl || !gotifyToken) {
          result.error = "GOTIFY_URL and GOTIFY_TOKEN env vars required";
          break;
        }
        const resp = await fetch(`${gotifyUrl}/message?token=${gotifyToken}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title,
            message,
            priority: priority === "high" ? 8 : priority === "low" ? 2 : 5,
          }),
          signal: AbortSignal.timeout(5_000),
        });
        result.sent = resp.ok;
        break;
      }

      case "discord": {
        const discordUrl = url || process.env.DISCORD_WEBHOOK_URL;
        if (!discordUrl) {
          result.error = "DISCORD_WEBHOOK_URL env var required";
          break;
        }
        const color = priority === "high" ? 0xff0000 : priority === "low" ? 0x888888 : 0x00ff00;
        const resp = await fetch(discordUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            embeds: [
              {
                title,
                description: message,
                color,
                timestamp: new Date().toISOString(),
              },
            ],
          }),
          signal: AbortSignal.timeout(5_000),
        });
        result.sent = resp.ok;
        break;
      }

      case "local": {
        // Use notify-send via child_process
        const { exec } = await import("child_process");
        await new Promise<void>((resolve, reject) => {
          exec(
            `notify-send "${title.replace(/"/g, '\\"')}" "${message.replace(/"/g, '\\"')}" --urgency=${priority}`,
            (error) => (error ? reject(error) : resolve())
          );
        });
        result.sent = true;
        break;
      }

      default:
        result.error = `Unknown channel: ${channel}`;
    }
  } catch (err: any) {
    result.error = err.message;
    result.sent = false;
  }

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}

// ─── Watch ───────────────────────────────────────────────────────────────────

async function watchProcess(args: {
  pid?: number;
  command?: string;
  title?: string;
  channel?: string;
  message: string;
  notify_on_exit?: boolean;
  timeout_ms?: number;
}) {
  const {
    pid,
    command,
    title = "MCP Server",
    channel = "local",
    message,
    notify_on_exit = true,
    timeout_ms = 60000,
  } = args;

  let targetPid: number | undefined = pid;

  // If a command is given, spawn it
  if (command && !pid) {
    const { exec } = await import("child_process");
    const child = exec(command);
    targetPid = child.pid;
  }

  if (!targetPid) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: "No PID to watch. Provide pid or command.",
          }),
        },
      ],
    };
  }

  // Poll until process exits or timeout
  const startTime = Date.now();
  let exited = false;
  const exitCode: number | null = null;

  while (Date.now() - startTime < timeout_ms) {
    try {
      // Check if process exists
      process.kill(targetPid, 0); // signal 0 = check existence
      await sleep(500);
    } catch {
      // Process no longer exists
      exited = true;
      // Try to get exit code from /proc if available
      try {
        const { readFileSync } = await import("fs");
        const statPath = `/proc/${targetPid}/stat`;
        // Process is gone, can't read stat
      } catch {
        /* process already gone */
      }
      break;
    }
  }

  const status = exited ? "exited" : "timeout";
  const finalMessage = exited
    ? `${message}\n\nProcess ${targetPid} finished (${status})`
    : `${message}\n\nProcess ${targetPid} still running after ${timeout_ms}ms (${status})`;

  // Notify on exit if requested
  if (exited && notify_on_exit) {
    await sendNotification({
      channel,
      message: finalMessage,
      title: `${title} — Process ${targetPid} completed`,
      priority: "normal",
    });
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            pid: targetPid,
            status,
            duration_ms: Date.now() - startTime,
            notified: exited && notify_on_exit,
            message: finalMessage,
          },
          null,
          2
        ),
      },
    ],
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
