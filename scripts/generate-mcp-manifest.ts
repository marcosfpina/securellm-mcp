/**
 * ADR-0057: Generate .mcp.json by actually calling tools/list on the server.
 *
 * This is the ONLY way to get 100% accurate tool list — regex on source
 * picks up internal function names, resource names, and misses spread operators.
 *
 * Usage:
 *   nix develop --command npm run build
 *   nix develop --command npx tsx scripts/generate-mcp-manifest.ts
 *   nix develop --command npx tsx scripts/generate-mcp-manifest.ts --check
 *
 * The server must be the freshly built version.
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { spawn } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const MCP_JSON_PATH = join(REPO_ROOT, ".mcp.json");
const BUILD_PATH = join(REPO_ROOT, "build", "src", "index.js");
const CHECK_MODE = process.argv.includes("--check");

function mcpServerArgs(): string[] {
  return [
    "develop",
    REPO_ROOT,
    "--command",
    "bash",
    "-lc",
    `cd ${JSON.stringify(REPO_ROOT)} && exec node ${JSON.stringify(BUILD_PATH)}`,
  ];
}

// ─── Call tools/list via MCP JSON-RPC over stdio ───────────────────────────

function callToolsList(): Promise<{ tools: Array<{ name: string; description: string }> }> {
  return new Promise((resolve, reject) => {
    const child = spawn("nix", mcpServerArgs(), {
      cwd: REPO_ROOT,
      stdio: ["pipe", "pipe", "inherit"],
      env: {
        ...process.env,
        PROJECT_ROOT: process.env.PROJECT_ROOT || REPO_ROOT,
        ENABLE_KNOWLEDGE: "true",
        LLAMA_CPP_URL: process.env.LLAMA_CPP_URL || "http://localhost:8081",
        PHANTOM_URL: process.env.PHANTOM_URL || "http://localhost:8008",
        CEREBRO_API_URL: process.env.CEREBRO_API_URL || "http://localhost:8009",
        NATS_URL: process.env.NATS_URL || "nats://localhost:4222",
        SECURELLM_MCP_QUIET: "1",
      },
    });

    let output = "";

    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();

      // MCP JSON-RPC: each message is a line of JSON
      const lines = output.split("\n");
      for (const line of lines) {
        try {
          const msg = JSON.parse(line.trim());
          // Response to our tools/list request
          if (msg.id === 1 && msg.result?.tools) {
            child.kill();
            resolve({ tools: msg.result.tools });
            return;
          }
          // Initialization response
          if (msg.id === 0 && msg.result) {
            // Server initialized, send tools/list
            const request =
              JSON.stringify({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/list",
                params: {},
              }) + "\n";
            child.stdin.write(request);
          }
        } catch {
          // Not JSON yet or partial line
        }
      }
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        // Try one more time — maybe output had the response
        try {
          const lastLine = output.split("\n").filter(Boolean).pop();
          if (lastLine) {
            const msg = JSON.parse(lastLine);
            if (msg.result?.tools) {
              resolve({ tools: msg.result.tools });
              return;
            }
          }
        } catch {}
        reject(new Error(`Server exited with code ${code}`));
      }
    });

    // Send initialize first
    const initRequest =
      JSON.stringify({
        jsonrpc: "2.0",
        id: 0,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "manifest-generator", version: "1.0.0" },
        },
      }) + "\n";
    child.stdin.write(initRequest);

    setTimeout(() => {
      child.kill();
      reject(new Error("Timeout waiting for tools/list response"));
    }, 15_000);
  });
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  let tools: Array<{ name: string }> = [];

  try {
    console.log("Calling tools/list on server...");
    const { tools: serverTools } = await callToolsList();
    tools = serverTools;
    console.log(`  Received ${tools.length} tools from server`);
  } catch (err: any) {
    console.error(`ERROR: Failed to get tools from server: ${err.message}`);
    console.error("Make sure you ran: nix develop --command npm run build");
    console.error("The server must be the freshly compiled version.");
    process.exit(1);
  }

  const toolNames = tools.map((t) => t.name).sort();

  if (CHECK_MODE) {
    if (!existsSync(MCP_JSON_PATH)) {
      console.error("ERROR: .mcp.json not found");
      process.exit(1);
    }
    const mcpJson = JSON.parse(readFileSync(MCP_JSON_PATH, "utf-8"));
    const declared = new Set(mcpJson.capabilities?.tools?.names || []);
    const actual = new Set(toolNames);

    const missing = [...actual].filter((t) => !declared.has(t));
    const extra = [...declared].filter((t) => !actual.has(t));

    if (missing.length > 0) {
      console.error(`  NEW tools (missing from .mcp.json): ${missing.join(", ")}`);
    }
    if (extra.length > 0) {
      console.error(`  REMOVED tools (extra in .mcp.json): ${extra.join(", ")}`);
    }

    if (missing.length > 0 || extra.length > 0) {
      console.error(`ERROR: manifest drift — declared=${declared.size} vs actual=${actual.size}`);
      console.error("Run: nix develop --command npm run build:manifest");
      process.exit(1);
    }

    console.log(`✅ .mcp.json in sync: ${actual.size} tools`);
    process.exit(0);
  }

  // Generate .mcp.json
  const mcpJson = {
    mcpServers: {
      securellm: {
        command: "nix",
        args: mcpServerArgs(),
        env: {
          PROJECT_ROOT: REPO_ROOT,
          ENABLE_KNOWLEDGE: "true",
          LLAMA_CPP_URL: process.env.LLAMA_CPP_URL || "http://localhost:8081",
          PHANTOM_URL: process.env.PHANTOM_URL || "http://localhost:8008",
          CEREBRO_API_URL: process.env.CEREBRO_API_URL || "http://localhost:8009",
          NATS_URL: process.env.NATS_URL || "nats://localhost:4222",
          SECURELLM_MCP_QUIET: "1",
        },
      },
    },
    capabilities: {
      tools: {
        count: toolNames.length,
        names: toolNames,
      },
    },
    _generated: {
      by: "scripts/generate-mcp-manifest.ts",
      adr: "ADR-0057",
      method: "MCP tools/list (server-side, 100% accurate)",
      at: new Date().toISOString(),
    },
  };

  writeFileSync(MCP_JSON_PATH, JSON.stringify(mcpJson, null, 2) + "\n", "utf-8");

  console.log(`✅ .mcp.json generated: ${toolNames.length} tools (from live server)`);
  const newTools = toolNames.filter(
    (n) =>
      n.startsWith("session_") ||
      n.startsWith("nvim_") ||
      n.startsWith("nix_") ||
      n.startsWith("git_") ||
      n.startsWith("notify_") ||
      n.startsWith("meta_") ||
      n.startsWith("journal_") ||
      n.startsWith("process_") ||
      n.startsWith("systemd_") ||
      n.startsWith("network_") ||
      n.startsWith("disk_") ||
      n.startsWith("security_")
  );
  if (newTools.length > 0) {
    console.log(`  🆕 New tools: ${newTools.join(", ")}`);
  }
}

main();
