#!/usr/bin/env bash
# selfcode を systemd なしで起動するシンプルなスクリプト
cd "$(dirname "$0")"
PORT="${PORT:-3339}" exec node server.js
