#!/bin/bash
PATTERNS=("'SNAPSHOT_0915'" '\b1\.6\b' '\b0\.15\b' '\b0\.005\b' '\b48\b' '\b58\b' 'getUTCHours' '\b555\b' '\b945\b')

for p in "${PATTERNS[@]}"; do
  echo "========================================================"
  echo "PATTERN: $p"
  echo "========================================================"
  grep -rnE "$p" src/ server.ts || echo "NO MATCHES"
  echo ""
done
