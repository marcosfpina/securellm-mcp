#!/usr/bin/env bash
set -e

echo "🧪 MCP Server Refactoring Validation Tests"
echo "=========================================="
echo ""

# Build first
echo "📦 Building project..."
npm run build > /dev/null 2>&1
echo "✅ Build complete"
echo ""

# Run validation tests
echo "🔬 Running validation tests..."
node --test build/tests/mcp-validation.test.js

echo ""
echo "=========================================="
echo "✅ All validation tests passed!"
echo ""
echo "📊 Summary:"
echo "  [MCP-1] STDIO Protocol: ✅ Clean JSON-RPC only"
echo "  [MCP-2] Async Execution: ✅ Event loop non-blocking"
echo "  Performance: ✅ Logger benchmarks within spec"
