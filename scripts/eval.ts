/**
 * Runs the classifier over every labelled file in test/eval/eligibility/ against real OpenRouter.
 * Prints a confusion matrix per field and every mismatch with the model's reason. Exits 1 on any
 * false `no` for relevant or degreeOk (label yes or unclear, actual no) or any non-null error.
 * Usage:
 *   pnpm eval:classifier
 */
import { readdirSync, readFileSync } from "node:fs";
import { z } from "zod";
import {
  createClassifier,
  type DegreeOk,
  type Relevant,
  type WorkAuth,
} from "../src/classifier/index.ts";
import { loadConfig, parseEnv } from "../src/config.ts";
import { log } from "../src/log.ts";

const EVAL_DIR = new URL("../test/eval/eligibility/", import.meta.url);

const RELEVANT: Relevant[] = ["yes", "no", "unclear"];
const DEGREE: DegreeOk[] = ["yes", "no", "unclear"];
const WORK: WorkAuth[] = ["none", "citizen_only", "no_sponsorship", "unclear"];

const EvalFile = z.object({
  id: z.string(),
  title: z.string(),
  company: z.string(),
  url: z.string(),
  description: z.string(),
  expected: z.object({
    relevant: z.enum(RELEVANT).nullable(),
    degreeOk: z.enum(DEGREE).nullable(),
    workAuth: z.enum(WORK).nullable(),
  }),
  note: z.string().default(""),
});
type EvalFile = z.infer<typeof EvalFile>;

const env = parseEnv();
const config = loadConfig(env.CONFIG_PATH);
const classifier = createClassifier(config, env);

const files = readdirSync(EVAL_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();
const labelled: EvalFile[] = [];
let unlabelled = 0;
for (const name of files) {
  const entry = EvalFile.parse(JSON.parse(readFileSync(new URL(name, EVAL_DIR), "utf8")));
  if (Object.values(entry.expected).some((v) => v === null)) {
    unlabelled += 1;
    continue;
  }
  labelled.push(entry);
}
log.info({ labelled: labelled.length, unlabelled, model: config.classifier.model }, "eval start");
if (labelled.length === 0) {
  log.error("no labelled files; fill in every expected field first");
  process.exit(1);
}

/** matrix[expected][actual] = count */
function emptyMatrix<T extends string>(values: T[]): Record<T, Record<T, number>> {
  const m = {} as Record<T, Record<T, number>>;
  for (const e of values) {
    m[e] = {} as Record<T, number>;
    for (const a of values) m[e][a] = 0;
  }
  return m;
}
const relevantMatrix = emptyMatrix(RELEVANT);
const degreeMatrix = emptyMatrix(DEGREE);
const workMatrix = emptyMatrix(WORK);

let falseNo = 0;
let errors = 0;
let mismatches = 0;
const started = Date.now();

for (const entry of labelled) {
  const { verdict, error } = await classifier.classify(entry);
  const expected = entry.expected as {
    relevant: Relevant;
    degreeOk: DegreeOk;
    workAuth: WorkAuth;
  };
  if (error !== null) {
    errors += 1;
    log.error({ id: entry.id, title: entry.title, error }, "classifier error");
    continue;
  }
  relevantMatrix[expected.relevant][verdict.relevant] += 1;
  degreeMatrix[expected.degreeOk][verdict.degreeOk] += 1;
  workMatrix[expected.workAuth][verdict.workAuth] += 1;
  const relevantMiss = verdict.relevant !== expected.relevant;
  const degreeMiss = verdict.degreeOk !== expected.degreeOk;
  const workMiss = verdict.workAuth !== expected.workAuth;
  const isFalseNo =
    (relevantMiss && verdict.relevant === "no") || (degreeMiss && verdict.degreeOk === "no");
  if (isFalseNo) falseNo += 1;
  if (relevantMiss || degreeMiss || workMiss) {
    mismatches += 1;
    log.warn(
      {
        id: entry.id,
        title: entry.title,
        company: entry.company,
        url: entry.url,
        expected,
        actual: {
          relevant: verdict.relevant,
          degreeOk: verdict.degreeOk,
          workAuth: verdict.workAuth,
        },
        reason: verdict.reason,
        note: entry.note || undefined,
      },
      isFalseNo ? "FALSE NO" : "mismatch",
    );
  } else {
    log.info({ id: entry.id, title: entry.title, ...expected, reason: verdict.reason }, "match");
  }
}

function printMatrix<T extends string>(
  field: string,
  values: T[],
  m: Record<T, Record<T, number>>,
) {
  const width = Math.max(...values.map((v) => v.length), 8) + 2;
  const cell = (s: string) => s.padStart(width);
  const lines = [`${field}: rows expected, columns actual`];
  lines.push(`${"".padStart(width)}${values.map(cell).join("")}`);
  for (const e of values) {
    lines.push(`${cell(e)}${values.map((a) => cell(String(m[e][a]))).join("")}`);
  }
  process.stdout.write(`\n${lines.join("\n")}\n\n`);
}

printMatrix("relevant", RELEVANT, relevantMatrix);
printMatrix("degreeOk", DEGREE, degreeMatrix);
printMatrix("workAuth", WORK, workMatrix);

const summary = {
  labelled: labelled.length,
  unlabelled,
  mismatches,
  falseNo,
  errors,
  elapsedSec: Math.round((Date.now() - started) / 1000),
};
if (falseNo > 0 || errors > 0) {
  log.error(summary, "eval FAILED: false no or classifier error");
  process.exit(1);
}
log.info(summary, "eval passed: zero false no, zero errors");
