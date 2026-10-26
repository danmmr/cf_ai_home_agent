#!/usr/bin/env node
// Upload the monitor list to the agent.
//   npm run push-config                     -> local dev (http://localhost:5173)
//   AGENT_URL=https://... npm run push-config -> deployed agent
// ADMIN_TOKEN comes from the environment, or from .dev.vars for local dev.
import { readFileSync, existsSync } from "node:fs";

const file = process.argv[2] ?? "monitors.json";
const url = process.env.AGENT_URL ?? "http://localhost:5173";

let token = process.env.ADMIN_TOKEN;
if (!token && existsSync(".dev.vars")) {
  token = readFileSync(".dev.vars", "utf8").match(/^ADMIN_TOKEN=(.+)$/m)?.[1];
}
if (!token) {
  console.error("ADMIN_TOKEN is not set");
  process.exit(1);
}

const res = await fetch(`${url}/api/config`, {
  method: "PUT",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: readFileSync(file, "utf8")
});
console.log(res.status, await res.text());
process.exit(res.ok ? 0 : 1);
