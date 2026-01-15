/**
 * SSH Connection Manager
 * Manages SSH connections with security controls, pooling, and health monitoring
 */

// @ts-ignore - ssh2 types are in @types/ssh2
import { Client } from 'ssh2';
import * as fs from 'fs/promises';
import type { SSHConnectArgs, SSHConnectionResult, SSHConfig } from '../../types/extended-tools.js';

export interface Connection {
  id: string;
  client: Client;
  host: string;
  username: string;
  connected: boolean;
  created: Date;
  config: any;
  // Extended properties for pooling and monitoring
  created_at: Date;
  last_used: Date;
  error_count: number;
  health_status: 'healthy' | 'degraded' | 'failed';
  bytes_sent: number;
  bytes_received: number;
  commands_executed: number;
}

export interface ConnectionPoolConfig {
  max_connections: number;
  max_idle_time_ms: number;
  health_check_interval_ms: number;
}

export interface HealthStatus {
  connection_id: string;
  status: 'healthy' | 'degraded' | 'failed';
  latency_ms: number;
  uptime_seconds: number;
  last_check: Date;
  issues: string[];
  metrics: {
    success_rate: number;
    avg_latency_ms: number;
    error_count: number;
  };
}

export class SSHConnectionManager {
  private connections: Map<string, Connection> = new Map();
  private pool: Map<string, Connection> = new Map();
  private allowedHosts: string[];
  private config: ConnectionPoolConfig;
  private healthCheckInterval?: NodeJS.Timeout;

  constructor(
    allowedHosts: string[] = ['localhost', '127.0.0.1'],
    config?: Partial<ConnectionPoolConfig>
  ) {
    this.allowedHosts = allowedHosts;
    this.config = {
      max_connections: config?.max_connections || 10,
      max_idle_time_ms: config?.max_idle_time_ms || 300000, // 5 min
      health_check_interval_ms: config?.health_check_interval_ms || 60000
    };
    this.startHealthMonitoring();
  }

  private startHealthMonitoring() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    this.healthCheckInterval = setInterval(
      () => this.checkAllConnections(),
      this.config.health_check_interval_ms
    );
  }

  private async checkAllConnections() {
    // Prune idle connections first
    await this.pruneIdleConnections();

    // Check health of remaining
    for (const conn of this.connections.values()) {
      await this.healthCheck(conn);
    }
  }

  async connect(args: SSHConnectArgs): Promise<SSHConnectionResult> {
    const { host, port = 22, username, auth_method, key_path, password } = args;

    // Security: whitelist hosts
    if (!this.allowedHosts.includes(host)) {
      // Check CIDR ranges if needed, for now just simple includes
      // A more robust implementation would use 'ip-range-check' or similar
      return {
        success: false,
        error: `Host '${host}' not in whitelist`,
        timestamp: new Date().toISOString(),
      };
    }

    try {
      const client = new Client();
      const connectionId = `ssh-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      const connectPromise = new Promise<SSHConnectionResult>((resolve, reject) => {
        client.on('ready', () => {
          const conn: Connection = {
            id: connectionId,
            client,
            host,
            username,
            connected: true,
            created: new Date(),
            config: args,
            created_at: new Date(),
            last_used: new Date(),
            error_count: 0,
            health_status: 'healthy',
            bytes_sent: 0,
            bytes_received: 0,
            commands_executed: 0
          };
          this.connections.set(connectionId, conn);

          // If pooling logic warrants, we could add to pool here or in getOrCreateConnection
          // For now, connections map serves as the registry

          resolve({
            success: true,
            data: {
              connection_id: connectionId,
              host,
              username,
              connected: true,
            },
            timestamp: new Date().toISOString(),
          });
        });

        client.on('error', (err: any) => {
          reject(new Error(`SSH connection failed: ${err.message}`));
        });

        // Configure connection
        const config: any = {
          host,
          port,
          username,
          readyTimeout: 30000,
        };

        if (auth_method === 'key' && key_path) {
          fs.readFile(key_path).then(privateKey => {
            config.privateKey = privateKey;
            client.connect(config);
          }).catch(reject);
        } else if (auth_method === 'password' && password) {
          config.password = password;
          client.connect(config);
        } else {
          reject(new Error('Invalid authentication method or missing credentials'));
        }
      });

      return await connectPromise;
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  async connectWithMFA(config: SSHConnectArgs, mfaCode: string): Promise<SSHConnectionResult> {
    if (!/^\d{6}$/.test(mfaCode)) {
      return {
        success: false,
        error: 'Invalid MFA code format',
        timestamp: new Date().toISOString()
      };
    }

    try {
      const client = new Client();
      const connectionId = `ssh-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      const connectPromise = new Promise<SSHConnectionResult>((resolve, reject) => {
        client.on('keyboard-interactive', (name: any, instructions: any, lang: any, prompts: any, finish: any) => {
          finish([mfaCode]);
        });

        client.on('ready', () => {
          const conn: Connection = {
            id: connectionId,
            client,
            host: config.host,
            username: config.username,
            connected: true,
            created: new Date(),
            config,
            created_at: new Date(),
            last_used: new Date(),
            error_count: 0,
            health_status: 'healthy',
            bytes_sent: 0,
            bytes_received: 0,
            commands_executed: 0
          };
          this.connections.set(connectionId, conn);

          resolve({
            success: true,
            data: {
              connection_id: connectionId,
              host: config.host,
              username: config.username,
              connected: true
            },
            timestamp: new Date().toISOString()
          });
        });

        client.on('error', reject);

        client.connect({
          host: config.host,
          port: config.port || 22,
          username: config.username,
          tryKeyboard: true,
          // other options...
        });
      });

      return await connectPromise;
    } catch (error: any) {
      return {
        success: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }

  getConnection(connectionId: string): Connection | undefined {
    const conn = this.connections.get(connectionId);
    if (conn) {
      conn.last_used = new Date();
    }
    return conn;
  }

  private generateConnectionKey(config: SSHConnectArgs): string {
    return `${config.username}@${config.host}:${config.port || 22}`;
  }

  async getOrCreateConnection(args: SSHConnectArgs): Promise<Connection> {
    const key = this.generateConnectionKey(args);
    
    // Check pool/existing connections
    // Note: This implementation treats 'pool' and 'connections' a bit synonymously for simplicity
    // Ideally, 'pool' would map keys to connection IDs or objects
    
    let existing: Connection | undefined;
    for (const conn of this.connections.values()) {
      if (this.generateConnectionKey(conn.config) === key && conn.connected) {
        existing = conn;
        break;
      }
    }

    if (existing) {
      existing.last_used = new Date();
      return existing;
    }

    // Create new connection
    const result = await this.connect(args);
    if (!result.success || !result.data) {
      throw new Error(result.error || 'Failed to create connection');
    }

    const connection = this.connections.get(result.data.connection_id);
    if (!connection) {
      throw new Error('Connection created but not found in map');
    }

    return connection;
  }

  async pruneIdleConnections(maxIdleTime?: number): Promise<number> {
    const threshold = maxIdleTime || this.config.max_idle_time_ms;
    const now = Date.now();
    let pruned = 0;

    for (const [id, conn] of this.connections.entries()) {
      const idleTime = now - conn.last_used.getTime();
      if (idleTime > threshold) {
        conn.client.end();
        this.connections.delete(id);
        pruned++;
      }
    }

    return pruned;
  }

  private async healthCheck(conn: Connection): Promise<HealthStatus> {
    try {
      // Send keepalive packet (executing simple command like 'true' or 'echo')
      const start = Date.now();
      // Using a simple exec to test responsiveness. 
      // Ideally client.ping() should be used if available, ssh2 client doesn't expose it directly easily?
      // Actually ssh2 types might not show it but it might exist, or we rely on exec.
      // Let's use a lightweight exec.
      
      await new Promise<void>((resolve, reject) => {
        conn.client.exec('true', (err, stream) => {
          if (err) return reject(err);
          stream.on('close', () => resolve()).on('data', () => {});
        });
      });

      const latency = Date.now() - start;
      const status = latency < 1000 ? 'healthy' : 'degraded';
      
      conn.health_status = status;

      return {
        connection_id: conn.id,
        status,
        latency_ms: latency,
        uptime_seconds: (Date.now() - conn.created_at.getTime()) / 1000,
        last_check: new Date(),
        issues: latency > 1000 ? ['High latency'] : [],
        metrics: {
          success_rate: 1 - (conn.error_count / Math.max(conn.commands_executed, 1)),
          avg_latency_ms: latency,
          error_count: conn.error_count
        }
      };
    } catch (error: any) {
      conn.health_status = 'failed';
      conn.error_count++;
      
      return {
        connection_id: conn.id,
        status: 'failed',
        latency_ms: 0,
        uptime_seconds: 0,
        last_check: new Date(),
        issues: [error.message],
        metrics: {
          success_rate: 0,
          avg_latency_ms: 0,
          error_count: conn.error_count
        }
      };
    }
  }

  disconnect(connectionId: string): boolean {
    const conn = this.connections.get(connectionId);
    if (conn) {
      conn.client.end();
      this.connections.delete(connectionId);
      return true;
    }
    return false;
  }

  disconnectAll(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    for (const conn of this.connections.values()) {
      if (conn.client && typeof conn.client.end === 'function') {
        conn.client.end();
      }
    }
    this.connections.clear();
  }

  listConnections(): Array<{ id: string; host: string; username: string; uptime: number; health: string }> {
    return Array.from(this.connections.values()).map(conn => ({
      id: conn.id,
      host: conn.host,
      username: conn.username,
      uptime: Date.now() - conn.created.getTime(),
      health: conn.health_status || 'unknown'
    }));
  }
}

export const sshConnectSchema = {
  name: "ssh_connect",
  description: "Establish SSH connection to remote server (whitelisted hosts only)",
  inputSchema: {
    type: "object",
    properties: {
      host: { type: "string", description: "Hostname or IP" },
      port: { type: "number", description: "SSH port (default: 22)" },
      username: { type: "string", description: "SSH username" },
      auth_method: { type: "string", enum: ["key", "password"] },
      key_path: { type: "string", description: "Path to private key (for key auth)" },
      password: { type: "string", description: "Password (for password auth)" },
    },
    required: ["host", "username", "auth_method"],
  },
};
