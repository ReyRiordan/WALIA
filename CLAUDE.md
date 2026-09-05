# WALIA

WALIA (WhatsApp LinkedIn Internship Alert) polls LinkedIn's public job search for new internship postings that match a saved search, dedupes them against a persistent store, and sends new matches to a WhatsApp group of students.

## Codebase

No source tree exists yet. All documentation lives in docs/, split by component:

- docs/scraper/ - LinkedIn fetching and parsing
- docs/notifier/ - WhatsApp delivery
- docs/core/ - polling loop, store, config
- docs/operations/ - running, deploying, alerting

## Commands

Language and tooling are not chosen yet. Fill in run, test, and lint commands when the first code lands.

Use the GitHub CLI (`gh`) for all GitHub-related tasks.

## Exploration Workflow

When starting a task, read docs/<component>/README.md for the relevant component first. Its doc map points to the specific docs, and those docs point to the code files. Do this before opening any code.

Keep the docs current. Do not end a session with changes and stale docs. Docs describe the current state only, never history or specific issues/PRs. Cut anything redundant with another layer of the chain.

## Glossary

Project-specific terms that would otherwise be misread in prompts. Add entries as they appear. None yet.
