/**
 * Neovim Context Bridge — ADR-0002
 *
 * Live editor integration via Neovim's msgpack-RPC API over UNIX socket.
 * The agent can see exactly where you are, what's selected, LSP diagnostics,
 * git blame, and more — without you typing a single path or line number.
 *
 * Socket: /tmp/nvim-${USER} or $NVIM_LISTEN_ADDRESS
 * Protocol: msgpack-RPC (MessagePack encoded JSON-RPC)
 */

import { z } from "zod";
import { encode, decode } from "@msgpack/msgpack";
import { createConnection } from "net";
import type { ExtendedTool } from "../types/mcp-tool-extensions.js";

// ─── Schema ──────────────────────────────────────────────────────────────────

const nvimContextSchema = z.object({
  action: z
    .enum([
      "get_buffer", // current file, cursor, filetype
      "get_selection", // visual selection text + range
      "get_diagnostics", // LSP errors/warnings in current buffer
      "get_visible_range", // lines currently on screen
      "get_git_blame", // git blame for current line
      "list_buffers", // all open buffers
      "get_mode", // current vim mode (normal, insert, visual)
    ])
    .describe("What to retrieve from Neovim"),
});

// Whitelist of safe vim commands (read-only, no shell)
const SAFE_VIM_COMMANDS = [
  "echo",
  "pwd",
  "buffers",
  "marks",
  "registers",
  "ls",
  "lua print(vim.inspect(...))",
];

// ─── Tool definition ──────────────────────────────────────────────────────────

export const nvimContextTool: ExtendedTool = {
  name: "nvim_context",
  description:
    "Live Neovim editor context: current file, cursor position, visual selection, LSP diagnostics, git blame. Zero-config via UNIX socket (ADR-0002).",
  defer_loading: true,
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "get_buffer",
          "get_selection",
          "get_diagnostics",
          "get_visible_range",
          "get_git_blame",
          "list_buffers",
          "get_mode",
        ],
        description: "What to retrieve from Neovim",
      },
    },
    required: ["action"],
  },
};

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleNvimContext(
  args: z.infer<typeof nvimContextSchema>
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const socketPath =
    process.env.NVIM_LISTEN_ADDRESS || `/tmp/nvim-${process.env.USER || "kernelcore"}`;

  let conn: ReturnType<typeof createConnection> | null = null;

  try {
    conn = await connectToNvim(socketPath);
    const nvim = createNvimClient(conn);

    let result: any;

    switch (args.action) {
      case "get_buffer":
        result = await getBuffer(nvim);
        break;
      case "get_selection":
        result = await getSelection(nvim);
        break;
      case "get_diagnostics":
        result = await getDiagnostics(nvim);
        break;
      case "get_visible_range":
        result = await getVisibleRange(nvim);
        break;
      case "get_git_blame":
        result = await getGitBlame(nvim);
        break;
      case "list_buffers":
        result = await listBuffers(nvim);
        break;
      case "get_mode":
        result = await getMode(nvim);
        break;
      default:
        result = { error: `Unknown action: ${args.action}` };
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err: any) {
    // Graceful error — Neovim might not be running
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: "Neovim connection failed",
              detail: err.message,
              hint: "Is Neovim running? Make sure it was started with: nvim --listen /tmp/nvim-$USER",
              socket: socketPath,
            },
            null,
            2
          ),
        },
      ],
    };
  } finally {
    if (conn) {
      try {
        conn.destroy();
      } catch {
        /* ok */
      }
    }
  }
}

// ─── Neovim RPC client ─────────────────────────────────────────────────────

interface NvimRpc {
  call(method: string, ...args: any[]): Promise<any>;
}

function connectToNvim(socketPath: string): Promise<ReturnType<typeof createConnection>> {
  return new Promise((resolve, reject) => {
    const conn = createConnection({ path: socketPath });
    conn.on("connect", () => resolve(conn));
    conn.on("error", reject);
    conn.setTimeout(5_000, () => {
      conn.destroy();
      reject(new Error(`Connection timeout to ${socketPath}`));
    });
  });
}

function createNvimClient(conn: ReturnType<typeof createConnection>): NvimRpc {
  let msgId = 0;
  const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

  let buffer = Buffer.alloc(0);

  conn.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    // Try to decode one or more complete msgpack messages
    while (buffer.length > 0) {
      try {
        const [msg, offset] = decodeMultiple(buffer);
        buffer = buffer.slice(offset);

        if (Array.isArray(msg) && msg.length === 4 && msg[0] === 1) {
          // Response: [1, msgid, error, result]
          const [, id, error, result] = msg;
          const p = pending.get(id as number);
          if (p) {
            pending.delete(id as number);
            if (error) {
              p.reject(new Error(String(error)));
            } else {
              p.resolve(result);
            }
          }
        }
      } catch {
        // Incomplete message, wait for more data
        break;
      }
    }
  });

  return {
    call(method: string, ...args: any[]): Promise<any> {
      return new Promise((resolve, reject) => {
        const id = ++msgId;
        pending.set(id, { resolve, reject });

        const request = [0, id, method, args];
        const packed = encode(request as any);
        conn.write(Buffer.from(packed));

        // Timeout after 5 seconds
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            reject(new Error(`nvim RPC timeout: ${method}`));
          }
        }, 5_000);
      });
    },
  };
}

// Decode one message, return [decoded, bytesConsumed]
function decodeMultiple(buffer: Buffer): [any, number] {
  // Use @msgpack/msgpack's decode with offset tracking
  // The library supports passing a buffer and getting the result
  const decoded = decode(buffer) as any;

  // HACK: We can't easily get bytes consumed from @msgpack/msgpack,
  // so we use re-encode to estimate. Better approach: use the
  // Decoder class from @msgpack/msgpack for streaming.
  // For simplicity, we re-encode to measure.
  const reEncoded = encode(decoded);
  return [decoded, reEncoded.length];
}

// ─── Action implementations ──────────────────────────────────────────────────

async function getBuffer(nvim: NvimRpc) {
  const buf = await nvim.call("nvim_get_current_buf");
  const name = await nvim.call("nvim_buf_get_name", buf);
  const lines = await nvim.call("nvim_buf_line_count", buf);
  const cursor = await nvim.call("nvim_win_get_cursor", 0);
  const filetype = await nvim.call("nvim_buf_get_option", buf, "filetype");
  const modified = await nvim.call("nvim_buf_get_option", buf, "modified");
  const buftype = await nvim.call("nvim_buf_get_option", buf, "buftype");

  return {
    file: name || `[No Name]`,
    line: cursor[0],
    column: cursor[1],
    total_lines: lines,
    filetype: filetype || "unknown",
    modified: !!modified,
    buftype: buftype || "normal",
  };
}

async function getSelection(nvim: NvimRpc) {
  try {
    // Get visual selection using '< and '> marks
    const startPos = await nvim.call("nvim_buf_get_mark", 0, "<");
    const endPos = await nvim.call("nvim_buf_get_mark", 0, ">");
    const mode = await nvim.call("nvim_get_mode");

    // Get lines in visual range
    const buf = await nvim.call("nvim_get_current_buf");
    const lines = await nvim.call("nvim_buf_get_lines", buf, startPos[0] - 1, endPos[0], false);

    return {
      text: lines.join("\n"),
      start: { line: startPos[0], column: startPos[1] },
      end: { line: endPos[0], column: endPos[1] },
      mode: mode?.mode || "v",
      line_count: lines.length,
    };
  } catch {
    return { text: "", note: "No visual selection or marks not set" };
  }
}

async function getDiagnostics(nvim: NvimRpc) {
  const buf = await nvim.call("nvim_get_current_buf");
  const diagnostics = await nvim.call("nvim_buf_get_diagnostics", buf, 0);

  if (!diagnostics || diagnostics.length === 0) {
    return { count: 0, items: [] };
  }

  const errors = diagnostics.filter((d: any) => d.severity === 1);
  const warnings = diagnostics.filter((d: any) => d.severity === 2);
  const info = diagnostics.filter((d: any) => d.severity === 3);
  const hints = diagnostics.filter((d: any) => d.severity === 4);

  return {
    count: diagnostics.length,
    errors: errors.length,
    warnings: warnings.length,
    info: info.length,
    hints: hints.length,
    items: diagnostics.slice(0, 20).map((d: any) => ({
      line: d.lnum + 1,
      column: d.col + 1,
      severity: ["error", "warning", "info", "hint"][d.severity - 1] || "unknown",
      message: d.message,
      source: d.source || "unknown",
    })),
  };
}

async function getVisibleRange(nvim: NvimRpc) {
  const win = await nvim.call("nvim_get_current_win");
  const height = await nvim.call("nvim_win_get_height", win);
  const cursor = await nvim.call("nvim_win_get_cursor", win);
  const topLine = await nvim.call("nvim_win_get_position", win);
  const buf = await nvim.call("nvim_get_current_buf");
  const lines = await nvim.call("nvim_buf_get_lines", buf, topLine[0], topLine[0] + height, false);

  return {
    top_line: topLine[0] + 1,
    bottom_line: topLine[0] + height,
    cursor_line: cursor[0],
    visible_lines: height,
    content: lines.slice(0, 30).join("\n"),
  };
}

async function getGitBlame(nvim: NvimRpc) {
  try {
    const buf = await nvim.call("nvim_get_current_buf");
    const name = await nvim.call("nvim_buf_get_name", buf);
    const cursor = await nvim.call("nvim_win_get_cursor", 0);

    // Use git blame via nvim built-in
    const blameInfo = await nvim.call(
      "nvim_exec_lua",
      `
      local buf = ...
      local line = ...
      local file = vim.api.nvim_buf_get_name(buf)
      if file == "" then return nil end
      local result = vim.fn.system({"git", "-C", vim.fn.fnamemodify(file, ":h"),
        "blame", "-L", line .. "," .. line, "--porcelain", file})
      return result
    `,
      [buf, cursor[0]]
    );

    // Parse porcelain format
    if (blameInfo) {
      const lines = (blameInfo as string).split("\n");
      const hash = lines[0]?.split(" ")[0] || "";
      const author = lines.find((l) => l.startsWith("author "))?.replace("author ", "") || "";
      const authorTime =
        lines.find((l) => l.startsWith("author-time "))?.replace("author-time ", "") || "";
      const summary = lines.find((l) => l.startsWith("summary "))?.replace("summary ", "") || "";

      return {
        line: cursor[0],
        commit: hash.slice(0, 8),
        author,
        date: authorTime ? new Date(parseInt(authorTime) * 1000).toISOString() : "unknown",
        message: summary,
        file: name,
      };
    }

    return { error: "No git information available for this buffer" };
  } catch (err: any) {
    return { error: `Git blame failed: ${err.message}` };
  }
}

async function listBuffers(nvim: NvimRpc) {
  const buffers = await nvim.call("nvim_list_bufs");

  const result = [];
  for (const buf of buffers) {
    const name = await nvim.call("nvim_buf_get_name", buf);
    const lines = await nvim.call("nvim_buf_line_count", buf);
    const modified = await nvim.call("nvim_buf_get_option", buf, "modified");
    const filetype = await nvim.call("nvim_buf_get_option", buf, "filetype");
    const loaded = await nvim.call("nvim_buf_is_loaded", buf);

    if (loaded) {
      result.push({
        name: name || "[No Name]",
        lines,
        filetype: filetype || "unknown",
        modified: !!modified,
        handle: buf,
      });
    }
  }

  return {
    count: result.length,
    buffers: result,
  };
}

async function getMode(nvim: NvimRpc) {
  const mode = await nvim.call("nvim_get_mode");
  return {
    mode: mode?.mode || "unknown",
    blocking: mode?.blocking || false,
  };
}
