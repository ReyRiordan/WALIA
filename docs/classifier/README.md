# classifier

The LLM eligibility check. One call per new dedupe-key group with a description, via OpenRouter, returning a degree-level verdict and a work-authorisation flag that the core loop uses as a soft filter. Everything is under `src/classifier/`, re-exported from `src/classifier/index.ts`, which also holds the `createClassifier` factory. `Verdict` and the store columns that hold it belong to core; this component produces the verdict.

## Docs

- [prompt.md](prompt.md) - program facts from config, both rubrics word for word, the JSON schema, truncation, `null` versus `unclear`.
- [client.md](client.md) - the OpenRouter transport, reasoning effort, timeout and retry, failure causes, the `ClassifyResult` contract, logging, the factory.
- [eval.md](eval.md) - the labelled eval set, `--save-eval`, `pnpm eval:classifier`, the pass bar, when to re-run.
