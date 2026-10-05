#!/usr/bin/env bash
# Starts the Vite dev server on 127.0.0.1:4173 if it is not already running.
cd "$(dirname "$0")/.."
if curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4173/ | grep -q 200; then echo "vite already running"; exit 0; fi
nohup npx vite --host 127.0.0.1 --port 4173 > /tmp/vite-dev.log 2>&1 &
for i in $(seq 1 40); do sleep 0.5; if curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4173/ | grep -q 200; then echo "vite ready"; exit 0; fi; done
echo "vite failed to start"; tail -20 /tmp/vite-dev.log; exit 1
