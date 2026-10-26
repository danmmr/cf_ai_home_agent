#!/bin/sh
# Report a local service's health to the agent. POSIX sh + curl, nothing else.
#
#   report.sh <monitor-id> ok|fail [message] [metrics-json]
#
#   report.sh nightly-job ok "paused 12 devices" '{"paused":12,"failed":0}'
#   report.sh disk-health ok "" '{"health":"PASSED","smart":{"5":0,"9":900}}'
#
# Settings come from the environment or ~/.config/health-agent/env:
#   AGENT_URL=https://your-agent.workers.dev
#   REPORT_TOKEN=...
# A failed report never fails the caller: it prints a warning and exits 0.

[ -f "$HOME/.config/health-agent/env" ] && . "$HOME/.config/health-agent/env"

monitor=$1
state=$2
message=${3:-}
metrics=${4:-null}

if [ -z "$monitor" ] || [ -z "$AGENT_URL" ] || [ -z "$REPORT_TOKEN" ]; then
  echo "report.sh: need a monitor id, AGENT_URL and REPORT_TOKEN" >&2
  exit 0
fi

case $state in
  ok) ok=true ;;
  *) ok=false ;;
esac

# escape backslashes, quotes and newlines for JSON
esc=$(printf '%s' "$message" | sed 's/\\/\\\\/g; s/"/\\"/g' | awk 'BEGIN{ORS="\\n"} {print}' | sed 's/\\n$//')

curl -fsS --max-time 15 -X POST "$AGENT_URL/api/report" \
  -H "Authorization: Bearer $REPORT_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"monitor\":\"$monitor\",\"ok\":$ok,\"message\":\"$esc\",\"metrics\":$metrics}" >/dev/null ||
  echo "report.sh: could not reach $AGENT_URL" >&2
exit 0
