import { AgentWorkflow } from "agents/workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";
import type { HealthAgent, TriageContext } from "./server";
import { notify } from "./notify";

export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export type FailureKind = "http" | "missed-report" | "rules" | "reported";

export interface TriageParams {
  monitorId: string;
  kind: FailureKind;
  detail: string;
}

interface Diagnosis {
  title: string;
  summary: string;
  cause: string;
  fix: string;
}

// Durable triage for one failure: confirm it is real, explain it, record it,
// tell the owner. Each step retries on its own, so a Workers AI hiccup or an
// ntfy timeout never loses the incident.
export class TriageWorkflow extends AgentWorkflow<HealthAgent, TriageParams> {
  async run(event: AgentWorkflowEvent<TriageParams>, step: AgentWorkflowStep) {
    const { monitorId, kind } = event.payload;

    // 1. Confirm. A single failed probe is often a blip, so re-probe twice a
    // minute apart. A missed report gets a few minutes in case it is just late.
    // Rule breaches and self-reported failures are facts, no wait needed.
    if (kind === "http") {
      for (const attempt of [1, 2]) {
        await step.sleep(`wait-${attempt}`, "60 seconds");
        const recheck = await step.do(`recheck-${attempt}`, async () => {
          const r = await this.agent.recheck(monitorId);
          return { ok: r.ok, detail: r.detail };
        });
        if (recheck.ok) {
          await step.do("flap", async () => {
            await this.agent.endTriage(monitorId, "recovered on recheck");
          });
          return { outcome: "flap" };
        }
      }
    } else if (kind === "missed-report") {
      await step.sleep("late-report", "3 minutes");
    }

    // RPC results carry a dispose handle; round-trip through JSON for a plain value
    const context = (await step
      .do("context", async () =>
        JSON.stringify(await this.agent.triageContext(monitorId))
      )
      .then((s) => JSON.parse(s))) as TriageContext;
    if (!context.stillFailing) {
      await step.do("recovered", async () => {
        await this.agent.endTriage(monitorId, "recovered before triage");
      });
      return { outcome: "recovered" };
    }

    // 2. Explain. A known issue gives cause and fix verbatim; the model only
    // has to say what happened in plain words. Unknown failures get the
    // model's best read of the runbook and recent history.
    const diagnosis = await step.do(
      "diagnose",
      { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" } },
      async (): Promise<Diagnosis> => {
        const fallback: Diagnosis = {
          title: `${context.name} has a problem`,
          summary: context.detail,
          cause: context.knownIssue?.cause ?? "Unknown. Check the runbook.",
          fix: context.knownIssue?.fix ?? context.runbook ?? ""
        };
        try {
          const response = (await this.env.AI.run(MODEL, {
            messages: [
              {
                role: "system",
                content:
                  "You are a home infrastructure on-call assistant. Write for the owner, who is technical but wants it short. " +
                  'Reply with JSON only: {"problem": string (under 40 chars, what is wrong, without the service name), ' +
                  '"summary": string (1-2 plain sentences: what is broken and since when), ' +
                  '"cause": string (the most likely cause, one sentence), ' +
                  '"fix": string (numbered steps the owner can follow)}. ' +
                  "If a known issue is given, use its cause and fix as written; do not invent other causes. " +
                  "Never invent commands, hosts or URLs that are not in the runbook."
              },
              { role: "user", content: JSON.stringify(context) }
            ],
            response_format: { type: "json_object" },
            max_tokens: 600
          })) as { response?: unknown };
          const raw = response.response;
          const parsed = (
            typeof raw === "string" ? JSON.parse(raw) : raw
          ) as Partial<Diagnosis> & { problem?: string };
          return {
            // the configured name, never the model's idea of it
            title: parsed.problem
              ? `${context.name}: ${parsed.problem}`
              : fallback.title,
            summary: parsed.summary || fallback.summary,
            cause:
              context.knownIssue?.cause ?? (parsed.cause || fallback.cause),
            fix: context.knownIssue?.fix ?? (parsed.fix || fallback.fix)
          };
        } catch {
          return fallback;
        }
      }
    );

    // 3. Record it, and post it into the chat thread.
    const incident = await step.do("open-incident", async () => {
      const r = await this.agent.openIncident(monitorId, {
        ...diagnosis,
        detail: context.detail,
        knownIssueId: context.knownIssue?.id ?? null,
        canFix: Boolean(context.knownIssue?.action)
      });
      return { id: r.id };
    });

    // 4. Tell the owner.
    await step.do("notify", async () => {
      const offer = context.knownIssue?.action
        ? `\n\nReply "fix ${incident.id}" in chat to run: ${context.knownIssue.action.label}`
        : "";
      await notify(
        this.env,
        diagnosis.title,
        `${diagnosis.summary}\n\nLikely cause: ${diagnosis.cause}\n\nFix:\n${diagnosis.fix}${offer}`,
        "high",
        ["rotating_light"],
        this.env.PUBLIC_URL
      );
    });

    return { outcome: "incident", incidentId: incident.id };
  }
}
