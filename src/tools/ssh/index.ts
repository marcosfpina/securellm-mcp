/**
 * SSH Tools - Remote Access and Maintenance
 * All SSH-related tools for secure remote operations
 */

// @ts-ignore
import { Client } from 'ssh2';
import { SSHConnectionManager } from './connection-manager.js';
import { SSHTunnelManager } from './tunnel-manager.js';
import { SSHJumpHostManager } from './jump-host-manager.js';
import { SSHSessionManager } from './session-manager.js';
import type {
  SSHExecuteArgs,
  SSHFileTransferArgs,
  SSHMaintenanceCheckArgs,
  ToolResult,
} from '../../types/extended-tools.js';
import path from 'path';

export { SSHConnectionManager, sshConnectSchema } from './connection-manager.js';

// Global connection manager instance
// In a real app, these would be initialized with config
const connectionManager = new SSHConnectionManager();
const tunnelManager = new SSHTunnelManager(connectionManager);
const jumpHostManager = new SSHJumpHostManager(connectionManager);

// We need a path for the SQLite DB. Using default location for now.
const DB_PATH = process.env.SSH_SESSION_DB_PATH || path.join(process.cwd(), 'ssh_sessions.db');
const sessionManager = new SSHSessionManager(
  DB_PATH,
  connectionManager,
  tunnelManager,
  jumpHostManager
);

/**
 * SSH Execute Tool
 */
export class SSHExecuteTool {
  private allowedCommands = [
    'ls', 'cat', 'grep', 'find', 'df', 'du', 'free', 'uptime',
    'systemctl status', 'journalctl', 'ps aux', 'netstat', 'ss'
  ];

  async execute(args: SSHExecuteArgs): Promise<ToolResult> {
    const { connection_id, command, timeout_seconds = 30, sudo = false } = args;

    const conn = connectionManager.getConnection(connection_id);
    if (!conn || !conn.connected) {
      return {
        success: false,
        error: 'Connection not found or not connected',
        timestamp: new Date().toISOString(),
      };
    }

    // Security: whitelist commands
    const isAllowed = this.allowedCommands.some(allowed => command.startsWith(allowed));
    if (!isAllowed && !sudo) {
      return {
        success: false,
        error: `Command '${command}' not in whitelist`,
        warnings: ['Only whitelisted commands are allowed for security'],
        timestamp: new Date().toISOString(),
      };
    }

    return new Promise((resolve) => {
      const fullCommand = sudo ? `sudo ${command}` : command;
      let stdout = '';
      let stderr = '';

      conn.client.exec(fullCommand, (err: any, stream: any) => {
        if (err) {
          resolve({
            success: false,
            error: `Execution failed: ${err.message}`,
            timestamp: new Date().toISOString(),
          });
          return;
        }

        stream.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        stream.on('close', (code: number) => {
          resolve({
            success: code === 0,
            data: {
              command: fullCommand,
              exit_code: code,
              stdout,
              stderr,
              connection_id,
            },
            timestamp: new Date().toISOString(),
          });
        });
      });
    });
  }
}

/**
 * SSH File Transfer Tool (SFTP)
 */
export class SSHFileTransferTool {
  async execute(args: SSHFileTransferArgs): Promise<ToolResult> {
    const { connection_id, action, local_path, remote_path } = args;

    const conn = connectionManager.getConnection(connection_id);
    if (!conn || !conn.connected) {
      return {
        success: false,
        error: 'Connection not found or not connected',
        timestamp: new Date().toISOString(),
      };
    }

    return new Promise((resolve) => {
      conn.client.sftp((err: any, sftp: any) => {
        if (err) {
          resolve({
            success: false,
            error: `SFTP failed: ${err.message}`,
            timestamp: new Date().toISOString(),
          });
          return;
        }

        if (action === 'upload') {
          sftp.fastPut(local_path, remote_path, (err: any) => {
            sftp.end();
            if (err) {
              resolve({
                success: false,
                error: `Upload failed: ${err.message}`,
                timestamp: new Date().toISOString(),
              });
            } else {
              resolve({
                success: true,
                data: {
                  action: 'upload',
                  local_path,
                  remote_path,
                  connection_id,
                },
                timestamp: new Date().toISOString(),
              });
            }
          });
        } else {
          sftp.fastGet(remote_path, local_path, (err: any) => {
            sftp.end();
            if (err) {
              resolve({
                success: false,
                error: `Download failed: ${err.message}`,
                timestamp: new Date().toISOString(),
              });
            } else {
              resolve({
                success: true,
                data: {
                  action: 'download',
                  local_path,
                  remote_path,
                  connection_id,
                },
                timestamp: new Date().toISOString(),
              });
            }
          });
        }
      });
    });
  }
}

/**
 * SSH Maintenance Check Tool
 */
export class SSHMaintenanceCheckTool {
  async execute(args: SSHMaintenanceCheckArgs): Promise<ToolResult> {
    const { connection_id, checks } = args;

    const conn = connectionManager.getConnection(connection_id);
    if (!conn || !conn.connected) {
      return {
        success: false,
        error: 'Connection not found or not connected',
        timestamp: new Date().toISOString(),
      };
    }

    const results: any = {};

    for (const check of checks) {
      try {
        results[check] = await this.runCheck(conn.client, check);
      } catch (error: any) {
        results[check] = { error: error.message };
      }
    }

    return {
      success: true,
      data: {
        connection_id,
        checks: results,
        host: conn.host,
      },
      timestamp: new Date().toISOString(),
    };
  }

  private runCheck(client: Client, check: string): Promise<any> {
    return new Promise((resolve, reject) => {
      let command = '';
      switch (check) {
        case 'disk':
          command = 'df -h';
          break;
        case 'services':
          command = 'systemctl list-units --state=failed';
          break;
        case 'updates':
          command = 'apt list --upgradable 2>/dev/null || yum check-update || true';
          break;
        case 'security':
          command = 'last -n 10';
          break;
        case 'logs':
          command = 'journalctl -p err -n 20 --no-pager';
          break;
      }

      client.exec(command, (err: any, stream: any) => {
        if (err) {
          reject(err);
          return;
        }

        let output = '';
        stream.on('data', (data: Buffer) => {
          output += data.toString();
        });

        stream.on('close', () => {
          resolve({ check, output, status: 'completed' });
        });
      });
    });
  }
}

/**
 * SSH Tunnel Tool
 */
export class SSHTunnelTool {
  async execute(args: any): Promise<ToolResult> {
    try {
      const result = await tunnelManager.createTunnel(args);
      return {
        success: true,
        data: result.data,
        timestamp: result.timestamp
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }
}

/**
 * SSH Jump Host Tool
 */
export class SSHJumpHostTool {
  async execute(args: any): Promise<ToolResult> {
    try {
      const result = await jumpHostManager.connectThroughJumps(args);
      return {
        success: result.success,
        data: result.data,
        error: result.error,
        timestamp: result.timestamp
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }
}

/**
 * SSH Session Tool
 */
export class SSHSessionTool {
  async execute(args: any): Promise<ToolResult> {
    try {
      if (args.action === 'save') {
        const result = await sessionManager.persistSession(args);
        return {
          success: true,
          data: result,
          timestamp: new Date().toISOString()
        };
      } else if (args.action === 'restore') {
        const result = await sessionManager.restoreSession(args.session_id);
        return {
          success: result.success,
          data: result.data,
          error: result.error,
          timestamp: result.timestamp
        };
      } else {
        return {
          success: false,
          error: `Unknown action: ${args.action}`,
          timestamp: new Date().toISOString()
        };
      }
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }
}

// Export schemas
export const sshExecuteSchema = {
  name: "ssh_execute",
  description: "Execute command on remote server via SSH",
  inputSchema: {
    type: "object",
    properties: {
      connection_id: { type: "string", description: "SSH connection ID" },
      command: { type: "string", description: "Command to execute" },
      timeout_seconds: { type: "number", description: "Timeout in seconds (default: 30)" },
      sudo: { type: "boolean", description: "Execute with sudo (default: false)" },
    },
    required: ["connection_id", "command"],
  },
};

export const sshFileTransferSchema = {
  name: "ssh_file_transfer",
  description: "Transfer files via SFTP (upload/download)",
  inputSchema: {
    type: "object",
    properties: {
      connection_id: { type: "string", description: "SSH connection ID" },
      action: { type: "string", enum: ["upload", "download"] },
      local_path: { type: "string", description: "Local file path" },
      remote_path: { type: "string", description: "Remote file path" },
    },
    required: ["connection_id", "action", "local_path", "remote_path"],
  },
};

export const sshMaintenanceCheckSchema = {
  name: "ssh_maintenance_check",
  description: "Run maintenance checks on remote server",
  inputSchema: {
    type: "object",
    properties: {
      connection_id: { type: "string", description: "SSH connection ID" },
      checks: {
        type: "array",
        items: { type: "string", enum: ["disk", "services", "updates", "security", "logs"] },
        description: "Checks to perform",
      },
    },
    required: ["connection_id", "checks"],
  },
};

export const sshTunnelSchema = {
  name: "ssh_tunnel",
  description: "Create SSH tunnel (Local, Remote, or Dynamic)",
  inputSchema: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["local", "remote", "dynamic"] },
      connection_id: { type: "string" },
      local_port: { type: "number" },
      remote_host: { type: "string" },
      remote_port: { type: "number" },
      socks_port: { type: "number" },
      bind_address: { type: "string" },
      keep_alive: { type: "boolean" },
      auto_restart: { type: "boolean" }
    },
    required: ["type", "connection_id"]
  }
};

export const sshJumpHostSchema = {
  name: "ssh_jump_host",
  description: "Connect via Jump Host(s)",
  inputSchema: {
    type: "object",
    properties: {
      target: { type: "object" }, // Full schema in types
      jumps: { type: "array", items: { type: "object" } },
      strategy: { type: "string", enum: ["sequential", "optimal"] },
      cache_successful_path: { type: "boolean" }
    },
    required: ["target", "jumps"]
  }
};

export const sshSessionSchema = {
  name: "ssh_session_manager",
  description: "Manage persistent SSH sessions",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["save", "restore"] },
      connection_id: { type: "string" }, // for save
      session_id: { type: "string" }, // for restore
      persist: { type: "boolean" },
      auto_recover: { type: "boolean" }
    },
    required: ["action"]
  }
};

// Export tool instances
export const sshTools = [
  new SSHExecuteTool(),
  new SSHFileTransferTool(),
  new SSHMaintenanceCheckTool(),
  new SSHTunnelTool(),
  new SSHJumpHostTool(),
  new SSHSessionTool()
];
