/**
 * SSH Tunnel Manager
 * Manages SSH tunnels (Local, Remote, Dynamic)
 */

import * as net from 'net';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { SSHConnectionManager } from './connection-manager.js';
import type { 
  TunnelConfig, 
  LocalTunnelConfig, 
  RemoteTunnelConfig, 
  DynamicTunnelConfig,
  TunnelResult 
} from '../../types/ssh-advanced.js';

// Simple SOCKS5 implementation helpers since we can't easily pull in a full server lib
import { EventEmitter } from 'events';

interface Tunnel {
  id: string;
  config: TunnelConfig;
  connection_id: string;
  status: 'active' | 'closed' | 'failed';
  created_at: Date;
  local_endpoint: string;
  remote_endpoint: string;
  bytes_transferred: number;
  connections_count: number;
  errors_count: number;
  reconnect_attempts: number;
  last_error?: string;
  server?: net.Server;
}

export class SSHTunnelManager {
  private tunnels: Map<string, Tunnel> = new Map();
  private connectionManager: SSHConnectionManager;

  constructor(connectionManager: SSHConnectionManager) {
    this.connectionManager = connectionManager;
  }

  async createTunnel(config: TunnelConfig): Promise<TunnelResult> {
    switch (config.type) {
      case 'local':
        return this.createLocalTunnel(config as LocalTunnelConfig);
      case 'remote':
        return this.createRemoteTunnel(config as RemoteTunnelConfig);
      case 'dynamic':
        return this.createDynamicTunnel(config as DynamicTunnelConfig);
      default:
        throw new Error(`Unknown tunnel type: ${(config as any).type}`);
    }
  }

  async createLocalTunnel(config: LocalTunnelConfig): Promise<TunnelResult> {
    const conn = this.connectionManager.getConnection(config.connection_id);
    if (!conn) {
      throw new Error('Connection not found');
    }

    const tunnelId = this.generateTunnelId();
    const server = net.createServer(async (socket) => {
      try {
        conn.client.forwardOut(
          socket.remoteAddress || '127.0.0.1',
          socket.remotePort || 0,
          config.remote_host,
          config.remote_port,
          (err, stream) => {
            if (err) {
              socket.end();
              return;
            }

            const tunnel = this.tunnels.get(tunnelId);
            if (tunnel) tunnel.connections_count++;

            socket.pipe(stream).pipe(socket);

            stream.on('data', (data: Buffer) => {
              const tunnel = this.tunnels.get(tunnelId);
              if (tunnel) tunnel.bytes_transferred += data.length;
            });
          }
        );
      } catch (err) {
        socket.end();
      }
    });

    return new Promise((resolve, reject) => {
      server.listen(config.local_port, config.bind_address || 'localhost', () => {
        const tunnel: Tunnel = {
          id: tunnelId,
          config,
          connection_id: config.connection_id,
          status: 'active',
          created_at: new Date(),
          local_endpoint: `${config.bind_address || 'localhost'}:${config.local_port}`,
          remote_endpoint: `${config.remote_host}:${config.remote_port}`,
          bytes_transferred: 0,
          connections_count: 0,
          errors_count: 0,
          reconnect_attempts: 0,
          server
        };

        this.tunnels.set(tunnelId, tunnel);

        resolve({
          success: true,
          data: {
            tunnel_id: tunnelId,
            type: 'local',
            local_endpoint: tunnel.local_endpoint,
            remote_endpoint: tunnel.remote_endpoint,
            status: 'active'
          },
          timestamp: new Date().toISOString()
        });
      });

      server.on('error', (err) => {
        reject(err);
      });
    });
  }

  async createRemoteTunnel(config: RemoteTunnelConfig): Promise<TunnelResult> {
    const conn = this.connectionManager.getConnection(config.connection_id);
    if (!conn) {
      throw new Error('Connection not found');
    }

    const tunnelId = this.generateTunnelId();

    return new Promise((resolve, reject) => {
      conn.client.forwardIn(
        config.bind_address || 'localhost',
        config.remote_port,
        (err) => {
          if (err) {
            reject(err);
            return;
          }

          conn.client.on('tcp connection', (info: any, accept: any, reject: any) => {
            const stream = accept();
            
            // Forward to local destination
            const localSocket = net.connect(
              config.local_port,
              config.local_host
            );

            stream.pipe(localSocket).pipe(stream);

            const tunnel = this.tunnels.get(tunnelId);
            if (tunnel) {
              tunnel.connections_count++;
              stream.on('data', (data: Buffer) => {
                tunnel.bytes_transferred += data.length;
              });
            }
          });

          const tunnel: Tunnel = {
            id: tunnelId,
            config,
            connection_id: config.connection_id,
            status: 'active',
            created_at: new Date(),
            local_endpoint: `${config.local_host}:${config.local_port}`,
            remote_endpoint: `${config.bind_address || 'localhost'}:${config.remote_port}`,
            bytes_transferred: 0,
            connections_count: 0,
            errors_count: 0,
            reconnect_attempts: 0
          };

          this.tunnels.set(tunnelId, tunnel);

          resolve({
            success: true,
            data: {
              tunnel_id: tunnelId,
              type: 'remote',
              local_endpoint: tunnel.local_endpoint,
              remote_endpoint: tunnel.remote_endpoint,
              status: 'active'
            },
            timestamp: new Date().toISOString()
          });
        }
      );
    });
  }

  async createDynamicTunnel(config: DynamicTunnelConfig): Promise<TunnelResult> {
    const conn = this.connectionManager.getConnection(config.connection_id);
    if (!conn) {
      throw new Error('Connection not found');
    }

    const tunnelId = this.generateTunnelId();

    // Basic SOCKS5 server implementation
    const server = net.createServer((socket) => {
      socket.once('data', (data) => {
        // SOCKS handshake
        if (data[0] !== 0x05) {
          socket.end();
          return;
        }

        // No auth required
        socket.write(Buffer.from([0x05, 0x00]));

        socket.once('data', (data) => {
          // Request details
          if (data[0] !== 0x05 || data[1] !== 0x01) { // 0x01 = CONNECT
            socket.end();
            return;
          }

          let addr: string;
          let port: number;
          let offset = 3; // VER, CMD, RSV

          const addrType = data[3];
          if (addrType === 0x01) { // IPv4
            addr = data.subarray(4, 8).join('.');
            offset = 8;
          } else if (addrType === 0x03) { // Domain
            const len = data[4];
            addr = data.subarray(5, 5 + len).toString();
            offset = 5 + len;
          } else if (addrType === 0x04) { // IPv6
             // IPv6 support omitted for brevity/complexity in raw parsing
             socket.end();
             return;
          } else {
            socket.end();
            return;
          }

          port = data.readUInt16BE(offset);

          // Forward through SSH
          conn.client.forwardOut(
            socket.remoteAddress || '127.0.0.1',
            socket.remotePort || 0,
            addr!,
            port!,
            (err, stream) => {
              if (err) {
                // Reply connection failed
                socket.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 0,0,0,0, 0,0]));
                socket.end();
                return;
              }

              // Reply success
              socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0,0,0,0, 0,0]));
              
              socket.pipe(stream).pipe(socket);

              const tunnel = this.tunnels.get(tunnelId);
              if (tunnel) {
                tunnel.connections_count++;
                stream.on('data', (d: Buffer) => {
                  tunnel.bytes_transferred += d.length;
                });
              }
            }
          );
        });
      });
    });

    return new Promise((resolve, reject) => {
      server.listen(config.socks_port, config.bind_address || 'localhost', () => {
        const tunnel: Tunnel = {
          id: tunnelId,
          config,
          connection_id: config.connection_id,
          status: 'active',
          created_at: new Date(),
          local_endpoint: `socks5://${config.bind_address || 'localhost'}:${config.socks_port}`,
          remote_endpoint: 'dynamic',
          bytes_transferred: 0,
          connections_count: 0,
          errors_count: 0,
          reconnect_attempts: 0,
          server
        };

        this.tunnels.set(tunnelId, tunnel);

        resolve({
          success: true,
          data: {
            tunnel_id: tunnelId,
            type: 'dynamic',
            local_endpoint: tunnel.local_endpoint,
            remote_endpoint: 'dynamic',
            status: 'active'
          },
          timestamp: new Date().toISOString()
        });
      });
      
      server.on('error', reject);
    });
  }

  async closeTunnel(tunnelId: string): Promise<boolean> {
    const tunnel = this.tunnels.get(tunnelId);
    if (!tunnel) return false;

    if (tunnel.server) {
      tunnel.server.close();
    }
    
    // If remote, we should ideally unforward, but ssh2 client logic for unforwarding
    // depends on keeping track of the listener. For now, we assume connection close handles it
    // or we'll need to expand Connection interface to track forwards.

    tunnel.status = 'closed';
    this.tunnels.delete(tunnelId);
    return true;
  }

  private generateTunnelId(): string {
    return `tunnel-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}
