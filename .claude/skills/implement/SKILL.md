---
name: implement
description: Implement one ticket.
disable-model-invocation: true
---

Implement GitHub issue $ARGUMENTS and open a PR.

# Plan
1. `gh issue view` the ticket, then every issue or PR it links to.
2. Follow the exploration workflow in CLAUDE.md for each component the ticket touches.
3. The ticket is the plan. Do not redesign what it already decides.
   If it contradicts the code or itself, and the readings lead to materially
   different work, stop and ask. Otherwise pick one and note it in the PR.
   If the ticket leaves the design open, decide, and record the decision in the PR.

# Build
- Branch from main as `<issue#>-<short-slug>`.
- Work in small steps, one commit each. Tests for new behaviour in the same commit.

# Verify
Before every commit, run what CI runs:
`pnpm lint && pnpm typecheck && pnpm test`. Fix failures, don't skip them.
If the Dockerfile or dependencies changed, also `docker build -t malja .`.

# Document
Update docs/ per the rule in CLAUDE.md. Check CLAUDE.md's Commands and Glossary too.

# Hand off
- Push, then `gh pr create` against main. Body: what changed, any decision made
  or deviation from the ticket and why, `Closes #<issue>`.
- Stop there. Do not merge.