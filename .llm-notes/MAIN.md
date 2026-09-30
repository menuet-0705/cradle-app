## Workflow Orchestration

### 1. Plan Node Default

- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
- If something goes sideways, STOP and re-plan immediately - don't keep pushing
- Use plan mode for verification steps, not just building
- Write detailed specs upfront to reduce ambiguity

### 2. Subagent Strategy

- Use subagents liberally to keep main context window clean
- Offload research, exploration, and parallel analysis to subagents
- For complex problems, throw more compute at it via subagents
- One tack per subagent for focused execution

### 3. Self-Improvement Loop

- After ANY correction from the user: update `tasks/lessons.md` with the pattern
- Write rules for yourself that prevent the same mistake
- Ruthlessly iterate on these lessons until mistake rate drops
- Review lessons at session start for relevant project

### 4. Verification Before Done

- Never mark a task complete without proving it works
- Diff behavior between main and your changes when relevant
- Ask yourself: "Would a staff engineer approve this?"
- Run tests, check logs, demonstrate correctness

### 5. Demand Elegance (Balanced)

- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
- Skip this for simple, obvious fixes - don't over-engineer
- Challenge your own work before presenting it

### 6. Autonomous Bug Fixing

- When given a bug report: just fix it. Don't ask for hand-holding
- Point at logs, errors, failing tests - then resolve them
- Zero context switching required from the user
- Go fix failing CI tests without being told how

### 7. Mandatory Review After Code Changes

- After ANY code change, run TWO reviews before marking the task done:
  1. `code-reviewer` subagent — bugs, logic errors, readability, maintainability
  2. `security-reviewer` subagent — injection, auth/authz, secret leakage, input validation
- Run them explicitly by name, e.g. "Use the code-reviewer agent to check my recent changes"
- These reviewers are READ-ONLY: they report findings, they do NOT edit code
- Triage findings by severity. Fix Critical and High before reporting "done"
- For Medium/Low: fix if cheap, otherwise note them in the review section of the `.steering/` file
- If a reviewer flags something, fix it and RE-RUN that reviewer until it passes
- Do NOT say a task is complete until both reviews have been run and blocking issues resolved
- Skip ONLY for trivial non-code changes (docs, comments, config typos) — and say so explicitly

## Task Management

1. **Plan First**: Write plan to `.steering/yyyyMMdd-${task-name}.md` (date in JST, task-name in kebab-case) with checkable items
2. **Verify Plan**: Check in before starting implementation. Once the human approves, add `承認: 済み（yyyy-MM-dd）` right under the plan's title
3. **Track Progress**: Mark items complete as you go
4. **Explain Changes**: High-level summary at each step
5. **Document Results**: Add review section to the same `.steering/yyyyMMdd-${task-name}.md` file
6. **Capture Lessons**: Update `tasks/lessons.md` after corrections

## Unattended Cloud Runs (no human in the loop)

Flow: design locally → commit/push an approved plan → implement in a cloud session (Claude Code `claude --cloud`, Codex cloud, etc.) → open a PR → a human reviews and merges.
These rules apply ONLY when running in a cloud session with no human to answer. They override "Plan mode" and "Verify Plan" above; everything else (reviews, security, simplicity) still applies.

- **Start only from an approved plan**: The prompt names a `.steering/*.md` file that contains `承認: 済み`. If the file is missing or not approved, do not implement: report why and stop
- **Do not ask, decide**: Implement exactly the plan's scope. When something is ambiguous, choose the simplest option that fits the plan and record it under "判断したこと" in the plan. Do not expand scope (no unrelated refactors or dependency upgrades)
- **Stop instead of guessing on**: DB migrations that drop or rewrite data, new external services or paid APIs, auth/permission model changes, or anything needing a secret. Write the question in the plan and the PR, and open the PR as a draft
- **Verify before the PR**: Run the checks for what you touched and fix failures
  - backend: `npm run lint` / `npm run test` / `npm run test:e2e` (needs Postgres: `docker compose up -d --wait` from the repo root) / `npm run build`
  - mobile-app: `flutter analyze` / `flutter test`
  - If a check cannot run in the cloud environment, say which one and why in the PR — never claim it passed
- **Reviews are still mandatory**: Run code-reviewer and security-reviewer (section 7). Fix Critical/High and re-run until they pass. Record the results in the plan's review section
- **Git**: Work on a `claude/`-prefixed branch. Never push to `master`, never force-push, never merge. Commit the plan updates together with the code
- **Open the PR**: Title in Japanese. Body in Japanese with: 目的（link to the plan）/ 変更内容 / 判断したこと / 検証結果（commands and results, including skipped ones）/ レビュー結果 / 残るリスク・人に見てほしい点. If a Critical/High finding is unresolved, open it as a draft and say so at the top
- **Secrets**: The cloud environment has no secrets and needs none (e2e tests use the values in `vitest.config.e2e.ts`). Never add secret values to environment variables, code, or the PR

## Core Principles

- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.
- **Minimat Impact**: Changes should only touch what's necessary. Avoid introducing bugs.

## Security

- **Never read `.env` or `.env.keys`**: These hold encrypted secrets and the decryption key. Do not open them with the Read tool, and do not read them via Bash (`cat`, `head`, `tail`, etc.).
- **Never decrypt or dump secrets**: Do not run `dotenvx run`, `printenv`, `env`, or any command that would expose secret values in output or logs.
- These rules are also enforced for Claude Code by the deny rules in `.claude/settings.json` and the `.claude/hooks/block-secrets.mjs` hook. Codex has no per-file deny, so this section is the only guard there: follow it strictly.

## Agent Config (Claude Code / Codex)

- `CLAUDE.md` and `AGENTS.md` are symlinks to `.llm-notes/MAIN.md`. Keep this file tool-neutral.
- Source of truth: `.llm-notes/agents/*.md` (subagents) and `.mcp.json` (MCP servers).
- `.codex/agents/*.toml` and the marked block in `.codex/config.toml` are generated. Never edit them by hand; after changing a source, run `node .llm-notes/sync.mjs` (`--check` fails if they are stale).
- MCP `env` in `.mcp.json` must be written as `"NAME": "${NAME}"` (inherited from the shell). Never write secret values into these files.
