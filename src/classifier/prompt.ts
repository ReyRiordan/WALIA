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
  /** The internship term the searches target, e.g. "summer 2027". */
  term: string;
  /** The fields a posting must be in, in prose, e.g. "software engineering, machine learning, ...". */
  fields: string;
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
      relevant: { type: "string", enum: ["yes", "no", "unclear"] },
      degree_ok: { type: "string", enum: ["yes", "no", "unclear"] },
      work_auth: { type: "string", enum: ["none", "citizen_only", "no_sponsorship", "unclear"] },
      reason: { type: "string" },
    },
    required: ["relevant", "degree_ok", "work_auth", "reason"],
    additionalProperties: false,
  },
} as const;

export const VerdictSchema = z.object({
  relevant: z.enum(["yes", "no", "unclear"]),
  degree_ok: z.enum(["yes", "no", "unclear"]),
  work_auth: z.enum(["none", "citizen_only", "no_sponsorship", "unclear"]),
  reason: z.string(),
});

/** The rubric. docs/classifier/prompt.md quotes all three rules word for word; keep them in sync. */
function systemPrompt(facts: ProgramFacts): string {
  return `You screen job postings for ${facts.program}. They graduate in ${facts.graduation} and are looking for ${facts.term} internships, so these are students partway through their program, not graduating seniors.

Read the posting and answer three questions: is this a ${facts.term} internship that ${facts.program} might want to apply to, and if so, are they eligible? Base every answer only on what the posting says. Do not guess at what the employer probably meant.

relevant: is this a ${facts.term} internship in ${facts.fields}?
- "yes" only when all three hold: the posting is an internship or co-op, not a full-time, contract, new-grad, or rotational analyst role; it is for ${facts.term}, or names no term at all; and the work is in ${facts.fields}.
- "no" when the posting states a mismatch on any of the three: it is a full-time, contract, new-grad, or rotational analyst role; it names a different term (for example fall, spring, or year-round only); or the work is in another field (for example mechanical, civil, chemistry, marketing, or finance), even if it mentions Python.
- "unclear" when the posting is silent or mixed on one of the three, for example a bare "Engineering Intern" with no field named.

degree_ok: does the posting's degree requirement admit a master's student?
- "yes" when the posting explicitly accepts master's or graduate students, or lists degree levels that include a master's (for example "BS/MS", "BS, MS, or PhD"), or only says "pursuing a degree" with no level.
- "no" only when the text excludes master's students outright: undergraduate or bachelor's students only, PhD students only, MBA students only, or a required graduation date or window that a ${facts.graduation} graduation misses.
- "unclear" for everything else, including "pursuing a bachelor's degree" with no exclusion language, since many such postings still take master's students. A graduation window stated next to a bachelor's degree (for example "graduating Spring 2028 with a Bachelor's degree", or "enrolled in a bachelor's program" with an expected graduation range) is bachelor's wording, not an exclusion: check the window against ${facts.graduation} and answer "unclear" when it fits.

work_auth: what work-authorisation constraint does the posting state?
- "citizen_only" when it requires US citizenship, a security clearance, or ITAR "US person" status.
- "no_sponsorship" when it says sponsorship is not available now or in the future, or requires authorisation to work "without sponsorship".
- "none" when it explicitly says sponsorship is available or international students are welcome.
- "unclear" when it says nothing, and also for a bare "must be authorized to work in the US", because F-1 students on CPT are authorized for internships and that line alone excludes nobody.

reason: one sentence quoting the phrase that decided each of the three answers, or saying that the posting is silent.

Reply with a single JSON object with exactly these keys: relevant, degree_ok, work_auth, reason.`;
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
    relevant: result.data.relevant,
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
