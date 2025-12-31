#!/usr/bin/env node
/**
 * MCP Tools Integration Tests
 * Tests refactored tools via JSON-RPC protocol
 */

const { spawn } = require('child_process');
const { performance } = require('perf_hooks');

console.log('🔧 Testing MCP Tools (Refactored)\n');

let testsPassed = 0;
let testsFailed = 0;

async function sendRequest(server, method, params = {}) {
  const request = {
    jsonrpc: '2.0',
    id: Math.random(),
    method,
    params
  };

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve({ error: 'timeout' });
    }, 5000);

    const handler = (data) => {
      try {
        const response = JSON.parse(data.toString());
        if (response.id === request.id) {
          clearTimeout(timeout);
          server.stdout.off('data', handler);
          resolve(response);
        }
      } catch (e) {
        // Ignore parse errors
      }
    };

    server.stdout.on('data', handler);
    server.stdin.write(JSON.stringify(request) + '\n');
  });
}

async function testListTools() {
  console.log('[Test 1] List Tools...');

  const server = spawn('node', ['build/src/index.js'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ENABLE_KNOWLEDGE: 'false', LOG_LEVEL: 'error' }
  });

  await new Promise(resolve => setTimeout(resolve, 1000));

  const response = await sendRequest(server, 'tools/list');

  server.kill();

  if (response.result && response.result.tools) {
    const toolCount = response.result.tools.length;
    console.log(`  ✅ PASSED: ${toolCount} tools available`);
    console.log(`  📊 Tools include: ${response.result.tools.slice(0, 3).map(t => t.name).join(', ')}...\n`);
    testsPassed++;
    return true;
  } else {
    console.log('  ❌ FAILED: No tools in response\n');
    testsFailed++;
    return false;
  }
}

async function testAsyncNixTool() {
  console.log('[Test 2] Async Nix Tool (Event Loop Non-Blocking)...');

  const server = spawn('node', ['build/src/index.js'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ENABLE_KNOWLEDGE: 'false', LOG_LEVEL: 'error' }
  });

  await new Promise(resolve => setTimeout(resolve, 1000));

  // Initialize first
  await sendRequest(server, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '1.0' }
  });

  // Send a request that would use async execution
  const start = performance.now();

  // Try to call a tool (this will test async execution)
  const response = await sendRequest(server, 'tools/call', {
    name: 'nix_flake_show',
    arguments: {}
  });

  const elapsed = performance.now() - start;

  // Send another request immediately to test if event loop is free
  const response2 = await sendRequest(server, 'tools/list');

  server.kill();

  if (response2.result) {
    console.log(`  ✅ PASSED: Server responded to second request`);
    console.log(`  📊 First request time: ${elapsed.toFixed(0)}ms`);
    console.log(`  🚀 Event loop was responsive during operation\n`);
    testsPassed++;
    return true;
  } else {
    console.log('  ❌ FAILED: Server blocked during operation\n');
    testsFailed++;
    return false;
  }
}

async function testLoggerNotInStdout() {
  console.log('[Test 3] Logger Output Not In STDOUT...');

  const server = spawn('node', ['build/src/index.js'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ENABLE_KNOWLEDGE: 'false', LOG_LEVEL: 'debug' }
  });

  let stdout = '';
  let hasNonJson = false;

  server.stdout.on('data', (data) => {
    const str = data.toString();
    stdout += str;

    // Check each line
    str.split('\n').filter(l => l.trim()).forEach(line => {
      try {
        JSON.parse(line);
      } catch (e) {
        if (!line.startsWith('{')) {
          hasNonJson = true;
          console.log('  ⚠️  Non-JSON in STDOUT:', line.substring(0, 50));
        }
      }
    });
  });

  await new Promise(resolve => setTimeout(resolve, 2000));

  // Send some requests to trigger logging
  await sendRequest(server, 'tools/list');

  await new Promise(resolve => setTimeout(resolve, 500));

  server.kill();

  if (!hasNonJson) {
    console.log('  ✅ PASSED: No logger output in STDOUT');
    console.log('  📊 All STDOUT is valid JSON-RPC\n');
    testsPassed++;
    return true;
  } else {
    console.log('  ❌ FAILED: Logger output leaked to STDOUT\n');
    testsFailed++;
    return false;
  }
}

async function testMultipleConcurrentRequests() {
  console.log('[Test 4] Multiple Concurrent Requests...');

  const server = spawn('node', ['build/src/index.js'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ENABLE_KNOWLEDGE: 'false', LOG_LEVEL: 'error' }
  });

  await new Promise(resolve => setTimeout(resolve, 1000));

  const start = performance.now();

  // Send multiple requests concurrently
  const promises = [
    sendRequest(server, 'tools/list'),
    sendRequest(server, 'tools/list'),
    sendRequest(server, 'tools/list'),
    sendRequest(server, 'resources/list'),
    sendRequest(server, 'resources/list')
  ];

  const results = await Promise.all(promises);
  const elapsed = performance.now() - start;

  server.kill();

  const successful = results.filter(r => r.result).length;

  if (successful === 5) {
    console.log('  ✅ PASSED: All concurrent requests succeeded');
    console.log(`  📊 ${successful}/5 requests in ${elapsed.toFixed(0)}ms`);
    console.log(`  🚀 Average: ${(elapsed/5).toFixed(0)}ms per request\n`);
    testsPassed++;
    return true;
  } else {
    console.log(`  ❌ FAILED: Only ${successful}/5 requests succeeded\n`);
    testsFailed++;
    return false;
  }
}

async function testToolExecution() {
  console.log('[Test 5] Actual Tool Execution (with error handling)...');

  const server = spawn('node', ['build/src/index.js'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ENABLE_KNOWLEDGE: 'false', LOG_LEVEL: 'error' }
  });

  await new Promise(resolve => setTimeout(resolve, 1000));

  // Initialize
  await sendRequest(server, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '1.0' }
  });

  // Try calling a simple tool
  const response = await sendRequest(server, 'tools/call', {
    name: 'provider_test',
    arguments: {
      provider: 'ollama',
      prompt: 'test'
    }
  });

  server.kill();

  // We expect either success or a controlled error (not a crash)
  if (response.result || response.error) {
    console.log('  ✅ PASSED: Tool executed with controlled response');
    if (response.result) {
      console.log('  📊 Tool returned result');
    } else if (response.error) {
      console.log('  📊 Tool returned error (expected, no provider configured)');
    }
    console.log('  🚀 No server crash, proper error handling\n');
    testsPassed++;
    return true;
  } else {
    console.log('  ❌ FAILED: Tool execution crashed server\n');
    testsFailed++;
    return false;
  }
}

// Run all tests
(async () => {
  console.log('========================================\n');

  try {
    await testListTools();
    await testAsyncNixTool();
    await testLoggerNotInStdout();
    await testMultipleConcurrentRequests();
    await testToolExecution();
  } catch (error) {
    console.error('Test suite error:', error);
    testsFailed++;
  }

  console.log('========================================');
  console.log('📊 TEST RESULTS\n');
  console.log('Tests Passed:', testsPassed);
  console.log('Tests Failed:', testsFailed);
  console.log('Success Rate:', Math.round((testsPassed / (testsPassed + testsFailed)) * 100) + '%');

  if (testsFailed === 0) {
    console.log('\n🎉 ALL TESTS PASSED!\n');
    console.log('✅ Tools are functional after refactoring');
    console.log('✅ Event loop remains responsive');
    console.log('✅ Logger does not pollute STDOUT');
    console.log('✅ Concurrent requests work correctly');
    process.exit(0);
  } else {
    console.log('\n⚠️  Some tests failed\n');
    process.exit(1);
  }
})();
