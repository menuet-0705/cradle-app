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
2. **Verify Plan**: Check in before starting implementation
3. **Track Progress**: Mark items complete as you go
4. **Explain Changes**: High-level summary at each step
5. **Document Results**: Add review section to the same `.steering/yyyyMMdd-${task-name}.md` file
6. **Capture Lessons**: Update `tasks/lessons.md` after corrections

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
