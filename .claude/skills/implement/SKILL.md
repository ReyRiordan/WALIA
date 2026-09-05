---
name: implement
description: Implement one ticket.
disable-model-invocation: true
---

Analyze and implement the Github issue: $ARGUMENTS

Follow this workflow:

# PLAN
1. Use 'gh issue view' to get issue details.
2. Understand the problem described in the issue.
3. Read any git issues or PRs relevant to the current issue.
4. Use the workflow described in CLAUDE.md to explore the codebase and find the necessary context.
5. Ask clarifying questions if necessary.
5. Think hard about how to break the issue down into a series of small, manageable tasks.

# CREATE
- Create a new branch for the issue (including issue # in the branch name).
- Solve the issue in small, manageable steps, according to your plan.
- Commit your changes after each step.

# TEST
- Write unit and integration tests as needed to describe the expected behavior of your code.
- Run the full test suite for the layer you worked on to ensure you haven't broken anything. Also run the linter(s).
- If any tests are failing, fix them.
- Ensure that ALL tests are passing before moving on to the next step.

# DOCUMENT
- Search for related documentation in ./docs/ and update them as needed for any changes you implemented. Remember that the docs are intended to be minimal and concise, aiding in efficient exploration and navigation to relevant code.

# DEPLOY
- Push the branch, open a PR targeting the branch you were on previously.