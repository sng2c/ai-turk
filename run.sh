#!/bin/bash
cd "$(dirname "$0")"
export TURK_PORT="${PORT:-8003}"   # web이 전달한 PORT 우선
exec node --env-file-if-exists=.env --import tsx server.ts
