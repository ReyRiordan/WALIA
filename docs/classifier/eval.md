# Eval set

Code: `scripts/eval.ts`, the `--save-eval` flag in `scripts/scrape.ts`. Files live in `test/eval/eligibility/`, one per posting, named `<id>.json`. Biome ignores the directory.

## File format

```json
{
  "id": "4463646787",
  "title": "Software Engineer Intern",
  "company": "PayPal",
  "url": "https://www.linkedin.com/jobs/view/4463646787",
  "description": "...",
  "expected": { "relevant": "yes", "degreeOk": "yes", "workAuth": "no_sponsorship" },
  "note": "why the label is what it is, quoting the posting"
}
```

`expected` fields are null until someone labels them. A file with any field null is unlabelled: counted, skipped. Labels follow the rubric in prompt.md, quoting the deciding phrase in `note`.

## Capturing postings

```
pnpm scrape --save-eval --recency 86400 --pages 2
```

Writes one unlabelled file per scraped job that has a description. An existing file is never overwritten, so hand labels survive a re-run and a second run for the same ids adds nothing. Descriptions are real LinkedIn text, which is the point: a hand-written set would not have the wording the prompt has to handle.

## Running

```
pnpm eval:classifier
```

Runs every labelled file sequentially against real OpenRouter with the configured model and reasoning effort. It is not in CI: it needs the key and spends money per run. Output goes through pino-pretty: one line per call, a `mismatch` or `FALSE NO` warning with expected, actual, and the model's reason for every miss, a confusion matrix per field (rows expected, columns actual), and a summary with `mismatches`, `falseNo`, and `errors`.

## Pass bar

Exit 1 on any false `no` for `relevant` or `degreeOk` (label `yes` or `unclear`, actual `no`) or any non-null `error`. A suppressed good internship is the same failure as a suppressed eligible one. Everything else is reported, not gating. An `unclear` where the label is decisive is a mismatch to look at, not a failure, because failing on it would push the prompt toward `no`, and a suppressed eligible posting is the one outcome the students never see.

An `error` is almost always OpenRouter or a provider, not the prompt. Read the cause: `http 502` or `http 429` on some calls and clean answers on the rest means a provider route is down. Re-run later rather than changing code.

## When to re-run

After any change to `systemPrompt`, `VERDICT_JSON_SCHEMA`, `MAX_TOKENS`, `classifier.model`, or `classifier.reasoningEffort`. The model is not deterministic even at temperature 0, so a borderline degree posting can flip between runs; run twice before blaming a change. Add and label a posting whenever a real notification was wrong, so the set grows from mistakes.
