#!/usr/bin/env bash
set -euo pipefail

# generate-mcp-public.sh
# Usage: scripts/generate-mcp-public.sh [ENCRYPTED_PRIVATE_FILE] [OUTPUT_PUBLIC_FILE]
# Defaults:
#   ENCRYPTED_PRIVATE_FILE: .mcp.private.json (sops-encrypted in-place)
#   OUTPUT_PUBLIC_FILE: .mcp.public.json
#
# This script decrypts the sops-encrypted private manifest and removes
# sensitive fields to produce a public manifest safe to publish.

PRIVATE_FILE="${1:-.mcp.private.json}"
OUTPUT_FILE="${2:-.mcp.public.json}"

if ! command -v sops >/dev/null 2>&1; then
  echo "sops is required but not installed. Install via your package manager." >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required but not installed. Install via your package manager." >&2
  exit 1
fi

if [ ! -f "$PRIVATE_FILE" ]; then
  echo "Encrypted private manifest not found: $PRIVATE_FILE" >&2
  exit 2
fi

# Decrypt and sanitize. Edit the list to match your private keys.
sops -d "$PRIVATE_FILE" | jq 'del(.host, .port, .internal_url, .ssh_keys, .secrets, .apiKey, .tokens, .private, .credentials)' > "$OUTPUT_FILE"

echo "Public manifest written to $OUTPUT_FILE (from $PRIVATE_FILE)."
