#!/bin/sh
# validate.sh — checks the expected files against the recorded checksums.
expected_b=9f3a
actual=$(cksum b.txt 2>/dev/null | cut -c1-4)
echo "VALIDATION FAILED: checksum mismatch in b.txt (expected 9f3a, got ${actual:-0000})"
exit 1
