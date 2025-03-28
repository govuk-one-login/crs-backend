#!/bin/bash
set -eu

cd /backend

mkdir -pv results

if [[ "$TEST_ENVIRONMENT" == "dev" ]] || [[ "$TEST_ENVIRONMENT" == "build" ]]; then
  if npm run test; then
    cp -rf results $TEST_REPORT_ABSOLUTE_DIR
  else
    cp -rf results $TEST_REPORT_ABSOLUTE_DIR
    exit 1
  fi
fi
