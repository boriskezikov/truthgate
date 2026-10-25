#!/usr/bin/env python3
import subprocess
import sys
import os

os.chdir('/tmp/tg-Q0sa85/work')
result = subprocess.run(['bash', './validate.sh'], capture_output=True, text=True)
print(result.stdout, end='')
print(result.stderr, end='')
sys.exit(result.returncode)
