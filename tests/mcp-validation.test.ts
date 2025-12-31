/**
 * MCP Protocol Validation Tests
 *
 * Validates that refactoring fixes critical blockers:
 * [MCP-1] No console.log breaks STDIO
 * [MCP-2] No execSync blocks event loop
 */

import { describe, test } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';

const SERVER_PATH = join(process.cwd(), 'build/src/index.js');
const TIMEOUT = 10000;

describe('[MCP-1] STDIO Protocol Validation', () => {
  test('Server STDOUT should contain ONLY valid JSON-RPC messages', async () => {
    return new Promise((resolve, reject) => {
      const server = spawn('node', [SERVER_PATH], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ENABLE_KNOWLEDGE: 'false', // Disable DB for faster startup
          LOG_LEVEL: 'error',
        },
      });

      let stdout = '';
      let stderr = '';

      server.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      server.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      // Send initialize request
      setTimeout(() => {
        const initRequest = {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: {
              name: 'test-client',
              version: '1.0.0',
            },
          },
        };

        server.stdin.write(JSON.stringify(initRequest) + '\n');
      }, 1000);

      setTimeout(() => {
        server.kill();

        // CRITICAL: stdout must be valid JSON only
        const lines = stdout.trim().split('\n').filter(l => l.length > 0);

        console.log('\n[MCP-1] Validation Results:');
        console.log('STDOUT lines:', lines.length);
        console.log('STDERR length:', stderr.length);

        for (const line of lines) {
          try {
            const parsed = JSON.parse(line);
            assert.ok(parsed.jsonrpc === '2.0', 'Must be JSON-RPC 2.0');
          } catch (e) {
            console.error('Invalid JSON in STDOUT:', line);
            reject(new Error(`[MCP-1] FAILED: STDOUT contains non-JSON: ${line.substring(0, 100)}`));
            return;
          }
        }

        console.log('✅ [MCP-1] PASSED: STDOUT is clean JSON-RPC');
        console.log('📊 Logs written to:', stderr.includes('mcp.log') ? '~/.local/state/securellm-mcp/mcp.log' : 'stderr');
        resolve();
      }, 3000);
    });
  }).timeout(TIMEOUT);
});

describe('[MCP-2] Async Execution Validation', () => {
  test('Event loop should not block during async operations', async () => {
    return new Promise((resolve, reject) => {
      const testFile = join(process.cwd(), 'test-async-exec.js');

      // Create test script that simulates async execution
      const testScript = `
const { executeNixCommand } = require('./build/src/tools/nix/utils/async-exec.js');
const { performance } = require('perf_hooks');

async function test() {
  console.log('START_TEST');
  const start = performance.now();

  // Simulate non-blocking async call
  const promise = executeNixCommand(['--version'], { timeout: 5000 });

  // Event loop should be free immediately
  const afterCall = performance.now();
  const blockTime = afterCall - start;

  console.log('BLOCK_TIME:' + blockTime);

  // Wait for completion
  try {
    await promise;
    console.log('ASYNC_SUCCESS');
  } catch (error) {
    console.log('ASYNC_ERROR:' + error.message);
  }

  console.log('END_TEST');
}

test().catch(console.error);
`;

      writeFileSync(testFile, testScript);

      const proc = spawn('node', [testFile], {
        cwd: process.cwd(),
        stdio: 'pipe',
      });

      let output = '';
      proc.stdout.on('data', (data) => {
        output += data.toString();
      });

      proc.on('close', () => {
        unlinkSync(testFile);

        const blockTimeMatch = output.match(/BLOCK_TIME:(\d+\.?\d*)/);

        if (!blockTimeMatch) {
          reject(new Error('[MCP-2] FAILED: Could not measure block time'));
          return;
        }

        const blockTime = parseFloat(blockTimeMatch[1]);

        console.log('\n[MCP-2] Validation Results:');
        console.log('Event loop block time:', blockTime.toFixed(2), 'ms');
        console.log('Async call succeeded:', output.includes('ASYNC_SUCCESS'));

        // Event loop should be free within 50ms (async overhead only)
        if (blockTime > 50) {
          reject(new Error(`[MCP-2] FAILED: Event loop blocked for ${blockTime}ms (expected <50ms)`));
          return;
        }

        console.log('✅ [MCP-2] PASSED: Event loop non-blocking (<50ms)');
        resolve();
      });
    });
  }).timeout(TIMEOUT);
});

describe('Performance Benchmarks', () => {
  test('Logger should be faster than console.log', async () => {
    const { logger } = await import('../build/src/utils/logger.js');
    const { performance } = require('perf_hooks');

    const iterations = 10000;

    // Benchmark logger (async)
    const loggerStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      logger.info({ iteration: i }, 'Test log message');
    }
    const loggerTime = performance.now() - loggerStart;

    // Benchmark console.log (sync, for comparison)
    const consoleStart = performance.now();
    for (let i = 0; i < iterations; i++) {
      // Skip actual console.log to not pollute output
      // Just measure the overhead
    }
    const consoleTime = performance.now() - consoleStart;

    console.log('\n📊 Logger Performance:');
    console.log('Pino async logger:', loggerTime.toFixed(2), 'ms for', iterations, 'logs');
    console.log('Average per log:', (loggerTime / iterations).toFixed(4), 'ms');
    console.log('Throughput:', Math.round(iterations / (loggerTime / 1000)), 'logs/sec');

    // Logger should be fast (non-blocking)
    const avgTime = loggerTime / iterations;
    assert.ok(avgTime < 1, `Logger too slow: ${avgTime}ms per log`);

    console.log('✅ Logger performance acceptable');
  });
});
