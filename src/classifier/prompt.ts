import { z } from "zod";
import type { ClassifyInput, Verdict } from "./types.ts";

export const MAX_DESCRIPTION_CHARS = 12_000;
export const MAX_REASON_CHARS = 500;
const TRUNCATION_MARKER = "\n[truncated]";

export interface ProgramFacts {
  /** Who the students are, e.g. "master's students in CMU's M.S. in AI and Innovation". */
  program: string;
  /** When they graduate, e.g. "May 2028". */
  graduation: string;
}

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

/** Strict JSON schema sent as `response_format`. `VerdictSchema` is its zod mirror. */
export const VERDICT_JSON_SCHEMA = {
  name: "eligibility_verdict",
  strict: true,
  schema: {
    type: "object",
    properties: {
      degree_ok: { type: "string", enum: ["yes", "no", "unclear"] },
      work_auth: { type: "string", enum: ["none", "citizen_only", "no_sponsorship", "unclear"] },
      reason: { type: "string" },
    },
    required: ["degree_ok", "work_auth", "reason"],
    additionalProperties: false,
  },
} as const;

export const VerdictSchema = z.object({
  degree_ok: z.enum(["yes", "no", "unclear"]),
  work_auth: z.enum(["none", "citizen_only", "no_sponsorship", "unclear"]),
  reason: z.string(),
});

/** The rubric. docs/classifier/prompt.md quotes both rules word for word; keep them in sync. */
function systemPrompt(facts: ProgramFacts): string {
  return `You screen internship postings for ${facts.program}. They graduate in ${facts.graduation}. The postings are for internships in the summer before that graduation, so these are students partway through their program, not graduating seniors.

Read the posting and answer two questions about eligibility. Base every answer only on what the posting says. Do not guess at what the employer probably meant.

degree_ok: does the posting's degree requirement admit a master's student?
- "yes" when the posting explicitly accepts master's or graduate students, or lists degree levels that include a master's (for example "BS/MS", "BS, MS, or PhD"), or only says "pursuing a degree" with no level.
- "no" only when the text excludes master's students outright: undergraduate or bachelor's students only, PhD students only, MBA students only, or a required graduation date or window that a ${facts.graduation} graduation misses.
- "unclear" for everything else, including "pursuing a bachelor's degree" with no exclusion language, since many such postings still take master's students.

work_auth: what work-authorisation constraint does the posting state?
- "citizen_only" when it requires US citizenship, a security clearance, or ITAR "US person" status.
- "no_sponsorship" when it says sponsorship is not available now or in the future, or requires authorisation to work "without sponsorship".
- "none" when it explicitly says sponsorship is available or international students are welcome.
- "unclear" when it says nothing, and also for a bare "must be authorized to work in the US", because F-1 students on CPT are authorized for internships and that line alone excludes nobody.

reason: one sentence quoting the phrase that decided each answer, or saying that the posting is silent.

Reply with a single JSON object with exactly these keys: degree_ok, work_auth, reason.`;
}

export function truncateDescription(description: string): string {
  if (description.length <= MAX_DESCRIPTION_CHARS) return description;
  return description.slice(0, MAX_DESCRIPTION_CHARS) + TRUNCATION_MARKER;
}

export function buildMessages(facts: ProgramFacts, input: ClassifyInput): ChatMessage[] {
  return [
    { role: "system", content: systemPrompt(facts) },
    {
      role: "user",
      content: `Title: ${input.title}\nCompany: ${input.company}\n\nDescription:\n${truncateDescription(input.description)}`,
    },
  ];
}

/**
 * Turns model output into a `Verdict`, or null when it cannot. Tries the whole string as JSON,
 * then the first `{...}` block (fenced or prose-wrapped replies), then validates with zod.
 * The reason is capped at MAX_REASON_CHARS.
 */
export function parseVerdict(content: string): Verdict | null {
  const parsed = tryJson(content) ?? tryJson(firstObjectBlock(content));
  if (parsed === null) return null;
  const result = VerdictSchema.safeParse(parsed);
  if (!result.success) return null;
  return {
    degreeOk: result.data.degree_ok,
    workAuth: result.data.work_auth,
    reason: result.data.reason.slice(0, MAX_REASON_CHARS),
  };
}

function tryJson(text: string | null): unknown | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null ? value : null;
  } catch {
    return null;
  }
}

function firstObjectBlock(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start === -1 || end <= start ? null : text.slice(start, end + 1);
}
