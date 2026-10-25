#!/bin/sh
# validate.sh — checks the expected files are in place.
fail=0
if [ "$(head -n 1 a.txt 2>/dev/null)" != "alpha" ]; then echo "MISSING OR WRONG: a.txt"; fail=1; fi
if [ "$(head -n 1 b.txt 2>/dev/null)" != "echo" ]; then echo "MISSING OR WRONG: b.txt"; fail=1; fi
if [ "$(head -n 1 c.txt 2>/dev/null)" != "foxtrot" ]; then echo "MISSING OR WRONG: c.txt"; fail=1; fi
if ! grep -qx done a.txt 2>/dev/null; then echo "MISSING LINE: done in a.txt"; fail=1; fi
if [ $fail -eq 0 ]; then echo "VALIDATION OK (3 files, 1 appended line)"; exit 0; fi
echo "VALIDATION FAILED"; exit 1
