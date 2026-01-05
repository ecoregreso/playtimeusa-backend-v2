#!/usr/bin/env bash
PORT=${PORT:-3000}

echo ">>> Killing anything on port $PORT..."
PIDS=$(sudo lsof -t -i:$PORT)
if [ -n "$PIDS" ]; then
  echo "$PIDS" | xargs -r sudo kill -9
fi

echo ">>> Starting backend dev server on $PORT..."
npm run dev
