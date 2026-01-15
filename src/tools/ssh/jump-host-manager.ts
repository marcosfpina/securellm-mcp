/**
 * SSH Jump Host Manager
 * Manages multi-hop SSH connections
 */

import { SSHConnectionManager, Connection } from './connection-manager.js';
import type { 
  JumpChainConfig, 
  JumpHostConfig, 
  JumpChainResult 
} from '../../types/ssh-advanced.js';

interface JumpChain {
  id: string;
  config: JumpChainConfig;
  status: 'connected' | 'failed';
  connection_id: string;
  actual_path: Array<{ host: string; latency_ms: number; connected_at: Date }>;
  total_latency_ms: number;
  hop_count: number;
  created_at: Date;
  reconnect_attempts: number;
}

export class SSHJumpHostManager {
  private chains: Map<string, JumpChain> = new Map();
  private connectionManager: SSHConnectionManager;
  private pathCache: Map<string, { path: JumpHostConfig[]; expires: Date }> = new Map();

  constructor(connectionManager: SSHConnectionManager) {
    this.connectionManager = connectionManager;
  }

  async connectThroughJumps(config: JumpChainConfig): Promise<JumpChainResult> {
    const chainId = this.generateChainId();

    // Check cache
    if (config.cache_successful_path) {
      const cached = this.getCachedPath(config.target.host);
      if (cached) {
        (config as any).jumps = cached;
      }
    }

    let path: Array<{ host: string; latency_ms: number; connected_at: Date }> = [];
    
    try {
      if (config.strategy === 'optimal') {
        path = await this.connectOptimal(config);
      } else {
        path = await this.connectSequential(config);
      }

      // Final connection
      // In a real implementation, we would tunnel the connection through the jumps.
      // Since ssh2 doesn't support easy "ProxyJump" config directly like OpenSSH,
      // we typically chain `forwardOut` calls or use `socksv5` proxying.
      // For this implementation, we will simulate the chaining logic by establishing
      // the connections sequentially and assuming the final connection object represents the chain.
      // A full implementation would involve:
      // Client 1 -> forwardOut -> Client 2 -> forwardOut -> Target
      
      // We will perform the actual chaining logic here:
      const finalConn = await this.chainConnections(config.jumps as JumpHostConfig[], config.target as JumpHostConfig);

      const chain: JumpChain = {
        id: chainId,
        config,
        status: 'connected',
        connection_id: finalConn.id,
        actual_path: path,
        total_latency_ms: path.reduce((sum, hop) => sum + hop.latency_ms, 0),
        hop_count: path.length,
        created_at: new Date(),
        reconnect_attempts: 0
      };

      this.chains.set(chainId, chain);

      if (config.cache_successful_path) {
        this.cachePath(config.target.host, config.jumps as JumpHostConfig[], config.cache_duration_minutes || 60);
      }

      return {
        success: true,
        data: {
          chain_id: chainId,
          connection_id: finalConn.id,
          target: config.target.host,
          jumps: config.jumps.map(j => j.host),
          path_taken: path.map(p => p.host),
          total_latency_ms: chain.total_latency_ms,
          hop_count: chain.hop_count
        },
        timestamp: new Date().toISOString()
      };

    } catch (error: any) {
      return {
        success: false,
        error: `Jump chain failed: ${error.message}`,
        timestamp: new Date().toISOString()
      };
    }
  }

  // Chain connections using forwardOut
  private async chainConnections(jumps: JumpHostConfig[], target: JumpHostConfig): Promise<Connection> {
    // This is a simplified sequential chain.
    // 1. Connect to Jump 1
    // 2. ForwardOut from Jump 1 to Jump 2 (or Target)
    // 3. Connect Client 2 to the forwarded stream
    // ... repeat
    
    // NOTE: This complex logic requires creating a new Client that uses the stream from the previous
    // `forwardOut` as its underlying stream. `ssh2` Client supports this via `connect({ sock: stream })`.
    
    // We start with the first jump
    if (jumps.length === 0) {
      return this.connectionManager.getOrCreateConnection(target);
    }

    // Connect to first jump
    let currentConn = await this.connectionManager.getOrCreateConnection(jumps[0]);
    
    // Iterate through remaining jumps
    for (let i = 1; i < jumps.length; i++) {
      const nextJump = jumps[i];
      currentConn = await this.forwardConnection(currentConn, nextJump);
    }

    // Connect to target through last jump
    return this.forwardConnection(currentConn, target);
  }

  private async forwardConnection(sourceConn: Connection, destination: JumpHostConfig): Promise<Connection> {
    const { Client } = require('ssh2'); // Dynamic import to avoid top-level side effects if needed
    
    return new Promise((resolve, reject) => {
      sourceConn.client.forwardOut(
        '127.0.0.1', 
        0, 
        destination.host, 
        destination.port || 22, 
        (err, stream) => {
          if (err) return reject(err);

          const nextClient = new Client();
          const nextId = `ssh-jump-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;

          nextClient.on('ready', () => {
            // Register this new connection with manager so it can be tracked/closed
            // We create a "virtual" connection object
            const newConn: Connection = {
              id: nextId,
              client: nextClient,
              host: destination.host,
              username: destination.username,
              connected: true,
              created: new Date(),
              config: destination,
              created_at: new Date(),
              last_used: new Date(),
              error_count: 0,
              health_status: 'healthy',
              bytes_sent: 0,
              bytes_received: 0,
              commands_executed: 0
            };
            
            // We might want to register this with connectionManager to track it
            // connectionManager.registerConnection(newConn); 
            // (Assuming we added a register method, or we just manage it here)
            
            resolve(newConn);
          });

          nextClient.on('error', reject);

          nextClient.connect({
            sock: stream,
            username: destination.username,
            privateKey: destination.key_path ? require('fs').readFileSync(destination.key_path) : undefined,
            password: destination.password,
            // ... other auth options
          });
        }
      );
    });
  }

  private async connectSequential(config: JumpChainConfig): Promise<Array<{ host: string; latency_ms: number; connected_at: Date }>> {
    const path = [];
    // Validate each jump is reachable (ping check)
    // In reality, we rely on the chainConnections to fail if unreachable
    for (const jump of config.jumps) {
      path.push({
        host: jump.host,
        latency_ms: 0, // Mock latency for now
        connected_at: new Date()
      });
    }
    return path;
  }

  private async connectOptimal(config: JumpChainConfig): Promise<Array<{ host: string; latency_ms: number; connected_at: Date }>> {
    // Basic implementation: just use sequential. 
    // Optimal would require probing multiple redundant jump paths if config.jumps was a graph,
    // but here it's a linear list.
    return this.connectSequential(config);
  }

  private cachePath(targetHost: string, path: JumpHostConfig[], durationMinutes: number): void {
    const expires = new Date();
    expires.setMinutes(expires.getMinutes() + durationMinutes);
    this.pathCache.set(targetHost, { path, expires });
  }

  private getCachedPath(targetHost: string): JumpHostConfig[] | null {
    const cached = this.pathCache.get(targetHost);
    if (!cached) return null;
    if (cached.expires < new Date()) {
      this.pathCache.delete(targetHost);
      return null;
    }
    return cached.path;
  }

  private generateChainId(): string {
    return `chain-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}
