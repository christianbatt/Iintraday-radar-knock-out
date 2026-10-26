#!/bin/bash
OUTPUT_FILE="scripts/out/static_scan.txt"
> "$OUTPUT_FILE"

echo "=== SCAN A: ?? 0 ===" >> "$OUTPUT_FILE"
grep -rnE "\?\? 0" src/ server.ts >> "$OUTPUT_FILE" 2>&1 || true

echo -e "\n=== SCAN B: 1.6 | 1.15 | 0.15 | 0.10 | 0.65 | 35 ===" >> "$OUTPUT_FILE"
grep -rnE "\b1\.6\b|\b1\.15\b|\b0\.15\b|\b0\.10\b|\b0\.65\b|\b35\b" src/ server.ts >> "$OUTPUT_FILE" 2>&1 || true

echo -e "\n=== SCAN C: / 10 | LMAX ===" >> "$OUTPUT_FILE"
grep -rnE "/ 10\b|LMAX" src/ server.ts >> "$OUTPUT_FILE" 2>&1 || true

echo -e "\n=== SCAN D: 'SNAPSHOT_0915' (with context) ===" >> "$OUTPUT_FILE"
grep -rn -C 5 "'SNAPSHOT_0915'" src/ server.ts >> "$OUTPUT_FILE" 2>&1 || true

echo -e "\n=== SCAN E: entryMode ===" >> "$OUTPUT_FILE"
grep -rn "entryMode" src/ server.ts >> "$OUTPUT_FILE" 2>&1 || true

echo -e "\n=== SCAN F: overrideBarrier ===" >> "$OUTPUT_FILE"
grep -rn "overrideBarrier" src/ server.ts >> "$OUTPUT_FILE" 2>&1 || true

echo -e "\n=== SCAN G: mock | vi.fn | jest.fn | stub | spyOn ===" >> "$OUTPUT_FILE"
grep -rniE "mock|vi\.fn|jest\.fn|stub|spyOn" src/ server.ts >> "$OUTPUT_FILE" 2>&1 || true

echo -e "\n=== SCAN H: USD | currency | fx | cambio ===" >> "$OUTPUT_FILE"
grep -rniE "USD|currency|fx|cambio" src/ server.ts >> "$OUTPUT_FILE" 2>&1 || true

echo "Static scan complete."
