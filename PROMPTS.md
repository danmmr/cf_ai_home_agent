# PROMPTS.md

AI prompts used to build this project, in order. Built with Claude Code (Claude Opus 5.5).

---

## 1. Assignment brief

> I am applying for a job at cloudfare they want me to build the following:
>
> - LLM (recommend using Llama 3.3 on Workers AI), or an external LLM of your choice
> - Workflow / coordination (recommend using Workflows, Workers or Durable Objects)
> - User input via chat or voice (recommend using Pages or Realtime)
> - Memory or state
>
> I also need to save all prompts. Before we get into that, here is more documentation https://developers.cloudflare.com/agents/

## 2. First prompt

> Looking for a fast nimble agent that will compliment some of the local AI work being done at home.

## 3. Clarification

> AI work = applications developed with AI

## 4.

> I have an idea.

## 5. The idea

> Lets create an uber agent that ensures the following personal projects do not have issues.  Project 1:  eero pause at night.  Project 2: Plex Dash on railway Project 3:  NYC Dash on railway.  Project 4:  monitoring of generic SSD on mac mini

## 6. Design decision (answered via question prompt)

> Q: The agent repo will be public on GitHub. How should it handle the eero and SSD pieces?
> A: Generic reporter (Recommended): public repo has the agent + a generic 'report status' script; the private eero script stays private and gets a small POST added on the home server only. No family names, MACs, IPs, URLs or passwords in the repo.

## 7. Alerting decision (answered via question prompt)

> Q: When the agent confirms an incident, how should it reach you? (Chat always shows status either way.)
> A: #1 and #3 (phone push via ntfy on a private topic, plus chat)

## 8. Ground rules

> 1.  Rule:  No internal only projects src code sent to git hub.  2. Agent should be generic enough to hook in to any local application or service to determine health.

## 9. Friendly output

> The output should be user friendly.  Meaning if there is a typical cause for the error/issue include it and offer to fix.  Example: API errors in plex dash

## 10. Autonomous checks

> beyond being on demand, agent should check on its own the health of the apps.  It should do this once an hour

## 11. Account question

> for the login, can I use a SSO login or do I need to create one?

## 12.

> ! cd ~/projects/cf_ai_home_agent && npx wrangler login.

## 13.

> 404 | We can't find the page you're looking for.

## 14. Working rule (answer to the subdomain question)

> Moving forward, we should always use the API instead of doing manual work/configs

## 15.

> do not use that

## 16. Subdomain (answered via question prompt)

> Q: What subdomain should I register? The URL will be cf-ai-home-agent.<name>.workers.dev.
> A: homehealth-agent
>
> what are my choices

## 17. Publishing the prompts

> is there anything in the prompts that has self identifying info?  other than what apps that are checked.  If not, lets include the prompts in github

## 18. Transport

> The chat should be over https

## 19. Documentation

> In the readme include everything that was done to develop this agent.  Include test plan

## 20. Security audit

> once done with the readme.  Do a security audit of the code

## 20. Security audit

> once done with the readme.  Do a security audit of the code

## 21.

> proceed

## 22. Audit write-up

> update the readme with the security audit.  Include findings and how it was fixed
