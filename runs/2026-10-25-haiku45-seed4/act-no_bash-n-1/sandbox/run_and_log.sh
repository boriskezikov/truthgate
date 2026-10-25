#!/bin/bash
bash ./validate.sh > /tmp/validate_output.txt 2>&1
EXIT_CODE=$?
echo $EXIT_CODE > /tmp/validate_exit_code.txt
