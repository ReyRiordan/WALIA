# Prompt

Code: `src/classifier/prompt.ts` (pure, no I/O), `src/classifier/types.ts`.

```ts
MAX_DESCRIPTION_CHARS = 12_000
MAX_REASON_CHARS = 500
VERDICT_JSON_SCHEMA                                      // strict JSON schema for response_format
VerdictSchema                                            // zod mirror: degree_ok, work_auth, reason
buildMessages(facts: ProgramFacts, input: ClassifyInput): ChatMessage[]
parseVerdict(content: string): Verdict | null
```

## Program facts come from config

`classifier.program` and `classifier.graduation` in config.json go into the system prompt verbatim. The search URL already carries the year-specific "summer 2027", so the year facts live next to it and next year's cohort is a config edit, not a redeploy. The rubric and the JSON schema stay in code.

The prompt tells the model who the students are, when they graduate, and that the postings are for the summer before that graduation, so a graduation-window rule in a posting can be checked against the configured date.

## Rubric

The system prompt states both rules in these words. Keep this section and `systemPrompt()` in sync.

`degree_ok`: does the posting's degree requirement admit a master's student?

- "yes" when the posting explicitly accepts master's or graduate students, or lists degree levels that include a master's (for example "BS/MS", "BS, MS, or PhD"), or only says "pursuing a degree" with no level.
- "no" only when the text excludes master's students outright: undergraduate or bachelor's students only, PhD students only, MBA students only, or a required graduation date or window that the configured graduation misses.
- "unclear" for everything else, including "pursuing a bachelor's degree" with no exclusion language, since many such postings still take master's students.

`work_auth`: what work-authorisation constraint does the posting state?

- "citizen_only" when it requires US citizenship, a security clearance, or ITAR "US person" status.
- "no_sponsorship" when it says sponsorship is not available now or in the future, or requires authorisation to work "without sponsorship".
- "none" when it explicitly says sponsorship is available or international students are welcome.
- "unclear" when it says nothing, and also for a bare "must be authorized to work in the US", because F-1 students on CPT are authorized for internships and that line alone excludes nobody.

`reason`: one sentence quoting the phrase that decided each answer, or saying that the posting is silent.

The degree rule leans permissive on purpose. Missing a job costs more than a tagged message, so bachelor's-only wording without exclusion language is `unclear`, not `no`. A stated graduation window is taken at its word.

## Inputs and schema

The user message carries the title, the company, and the description. A description longer than `MAX_DESCRIPTION_CHARS` is cut there and ends with `[truncated]`.

The reply is requested as `response_format: { type: "json_schema", strict: true }` with three required keys and no extras. `VerdictSchema` validates whatever comes back, so a model that ignores `json_schema` still works: `parseVerdict` tries the whole string as JSON, then the first `{...}` block for fenced or prose-wrapped replies, then zod. `reason` is cut to `MAX_REASON_CHARS`. Anything that fails returns null and the client turns that into the `unparsable output` cause.

## null versus unclear

On the job row, `degree_ok = NULL` means never classified: the group had no description anywhere. `unclear` means the model could not tell, or the call failed and the fallback verdict was stored. They stay distinct so the audit row says which.
