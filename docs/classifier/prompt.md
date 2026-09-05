# Prompt

Code: `src/classifier/prompt.ts` (pure, no I/O), `src/classifier/types.ts`.

```ts
MAX_DESCRIPTION_CHARS = 12_000
MAX_REASON_CHARS = 500
VERDICT_JSON_SCHEMA                                      // strict JSON schema for response_format
VerdictSchema                                            // zod mirror: relevant, degree_ok, work_auth, reason
buildMessages(facts: ProgramFacts, input: ClassifyInput): ChatMessage[]
parseVerdict(content: string): Verdict | null
```

## Program facts come from config

`classifier.program`, `classifier.graduation`, `classifier.term`, and `classifier.fields` in config.json go into the system prompt verbatim. The search URL already carries the year-specific "summer 2027", so the year facts live next to it and next year's cohort is a config edit, not a redeploy. The rubric and the JSON schema stay in code.

The prompt tells the model who the students are, when they graduate, which term they want, and which fields count, so a graduation-window rule in a posting can be checked against the configured date and a stated term or field can be checked against the configured ones. `term` and `fields` are required rather than defaulted because a silent default would suppress jobs. The field list lives in config, not the prompt, so the code is not tied to one program.

## Rubric

The system prompt opens by asking whether this is a `term` internship that `program` might want to apply to, and if so, whether they are eligible. It then states the three rules in these words. Keep this section and `systemPrompt()` in sync.

`relevant`: is this a `term` internship in `fields`?

- "yes" only when all three hold: the posting is an internship or co-op, not a full-time, contract, new-grad, or rotational analyst role; it is for `term`, or names no term at all; and the work is in `fields`.
- "no" when the posting states a mismatch on any of the three: it is a full-time, contract, new-grad, or rotational analyst role; it names a different term (for example fall, spring, or year-round only); or the work is in another field (for example mechanical, civil, chemistry, marketing, or finance), even if it mentions Python.
- "unclear" when the posting is silent or mixed on one of the three, for example a bare "Engineering Intern" with no field named.

`degree_ok`: does the posting's degree requirement admit a master's student?

- "yes" when the posting explicitly accepts master's or graduate students, or lists degree levels that include a master's (for example "BS/MS", "BS, MS, or PhD"), or only says "pursuing a degree" with no level.
- "no" only when the text excludes master's students outright: undergraduate or bachelor's students only, PhD students only, MBA students only, or a required graduation date or window that the configured graduation misses.
- "unclear" for everything else, including "pursuing a bachelor's degree" with no exclusion language, since many such postings still take master's students. A graduation window stated next to a bachelor's degree (for example "graduating Spring 2028 with a Bachelor's degree", or "enrolled in a bachelor's program" with an expected graduation range) is bachelor's wording, not an exclusion: check the window against the configured graduation and answer "unclear" when it fits.

`work_auth`: what work-authorisation constraint does the posting state?

- "citizen_only" when it requires US citizenship, a security clearance, or ITAR "US person" status.
- "no_sponsorship" when it says sponsorship is not available now or in the future, or requires authorisation to work "without sponsorship".
- "none" when it explicitly says sponsorship is available or international students are welcome.
- "unclear" when it says nothing, and also for a bare "must be authorized to work in the US", because F-1 students on CPT are authorized for internships and that line alone excludes nobody.

`reason`: one sentence quoting the phrase that decided each of the three answers, or saying that the posting is silent.

The relevance rule is a model filter with no keyword gate on the card title. A title keyword nobody thought of (bank-style "Summer Analyst, Software Engineering") would lose a job silently, and off-title postings are rare enough that one detail fetch plus one classifier call each is cheap. `yes` needs all three tests and `no` needs a stated mismatch, so a posting that names no term still counts as a match, because many summer internships never say the year. The field test exists because a mechanics research internship is exactly the non-CS internship the search returns.

The degree rule leans permissive on purpose. Missing a job costs more than a tagged message, so bachelor's-only wording without exclusion language is `unclear`, not `no`. A stated graduation window is taken at its word.

## Inputs and schema

The user message carries the title, the company, and the description. A description longer than `MAX_DESCRIPTION_CHARS` is cut there and ends with `[truncated]`.

The reply is requested as `response_format: { type: "json_schema", strict: true }` with four required keys and no extras. `relevant` is the first property so the model decides it before eligibility. `VerdictSchema` validates whatever comes back, so a model that ignores `json_schema` still works: `parseVerdict` tries the whole string as JSON, then the first `{...}` block for fenced or prose-wrapped replies, then zod. `reason` is cut to `MAX_REASON_CHARS`. Anything that fails returns null and the client turns that into the `unparsable output` cause.

## null versus unclear

On the job row, `degree_ok = NULL` means never classified: the group had no description anywhere. `unclear` means the model could not tell, or the call failed and the fallback verdict was stored. They stay distinct so the audit row says which.

`relevant = NULL` next to a non-null `degree_ok` is a row classified before the column existed. The store reads it back as `unclear`, so `Verdict` stays total. See docs/core/store.md.
