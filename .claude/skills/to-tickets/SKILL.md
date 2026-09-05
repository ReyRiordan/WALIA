---
name: to-tickets
description: Turn a grilled plan into GitHub issue(s) ready for /implement.
disable-model-invocation: true
---

Write the plan we just settled into GitHub issue(s) that /implement can execute without asking questions.

Where to write it:
- If a stub issue for this work exists (label `needs-grill`), rewrite its body with `gh issue edit`, remove `needs-grill`, keep the component label.
- Create new issues only if the plan needs splitting. Split at a module boundary another ticket depends on, and only if one PR would otherwise be too big to review in one sitting. Never split for its own sake.
- If you split, cross-link the issues with depends on / blocks so the order is recoverable from the tickets alone.

Tickets run in order, so "depends on #N" is fine. There are no users yet, so breakage between tickets is fine too.

Each issue body:
- **Scope.** Two or three sentences. Depends on / blocks.
- **Decisions.** Every design decision from the grilling, one bold lead-in each, with the reason and the alternative rejected. If it was discussed, it goes here. Nothing else records it.
- **Files.** Each file to create or change, with exported signatures.
- **Done when.** A checklist that can be verified by running something.

Do not restate CLAUDE.md or the docs. Link to them.