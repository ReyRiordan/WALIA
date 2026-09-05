import { describe, expect, it } from "vitest";
import {
  buildMessages,
  MAX_DESCRIPTION_CHARS,
  MAX_REASON_CHARS,
  parseVerdict,
  VERDICT_JSON_SCHEMA,
  VerdictSchema,
} from "./prompt.ts";

const FACTS = { program: "master's students in the Test Program", graduation: "May 2028" };
const INPUT = { title: "SWE Intern", company: "Acme", description: "Build things." };

describe("buildMessages", () => {
  it("puts the program facts in the system message and the job in the user message", () => {
    const [system, user] = buildMessages(FACTS, INPUT);
    expect(system?.role).toBe("system");
    expect(system?.content).toContain(FACTS.program);
    expect(system?.content).toContain(FACTS.graduation);
    expect(user?.role).toBe("user");
    expect(user?.content).toContain("Title: SWE Intern");
    expect(user?.content).toContain("Company: Acme");
    expect(user?.content).toContain("Build things.");
  });

  it("truncates the description past the cap with a marker", () => {
    const long = "x".repeat(MAX_DESCRIPTION_CHARS + 500);
    const [, user] = buildMessages(FACTS, { ...INPUT, description: long });
    expect(user?.content).toContain("x".repeat(MAX_DESCRIPTION_CHARS));
    expect(user?.content).not.toContain("x".repeat(MAX_DESCRIPTION_CHARS + 1));
    expect(user?.content).toMatch(/\[truncated\]$/);
  });

  it("leaves a description at the cap untouched", () => {
    const exact = "y".repeat(MAX_DESCRIPTION_CHARS);
    const [, user] = buildMessages(FACTS, { ...INPUT, description: exact });
    expect(user?.content).not.toContain("[truncated]");
  });
});

describe("VERDICT_JSON_SCHEMA", () => {
  it("lists the same enum values as the zod mirror", () => {
    const props = VERDICT_JSON_SCHEMA.schema.properties;
    expect([...props.degree_ok.enum]).toEqual(VerdictSchema.shape.degree_ok.options);
    expect([...props.work_auth.enum]).toEqual(VerdictSchema.shape.work_auth.options);
    expect([...VERDICT_JSON_SCHEMA.schema.required]).toEqual(Object.keys(VerdictSchema.shape));
  });
});

describe("parseVerdict", () => {
  const good = { degree_ok: "yes", work_auth: "no_sponsorship", reason: "Says BS/MS." };
  const expected = { degreeOk: "yes", workAuth: "no_sponsorship", reason: "Says BS/MS." };

  it("parses strict JSON", () => {
    expect(parseVerdict(JSON.stringify(good))).toEqual(expected);
  });

  it("parses fenced JSON", () => {
    expect(parseVerdict(`\`\`\`json\n${JSON.stringify(good)}\n\`\`\``)).toEqual(expected);
  });

  it("parses JSON wrapped in prose", () => {
    expect(parseVerdict(`Here is my answer: ${JSON.stringify(good)} Hope that helps.`)).toEqual(
      expected,
    );
  });

  it("rejects a bad enum value", () => {
    expect(parseVerdict(JSON.stringify({ ...good, degree_ok: "maybe" }))).toBeNull();
  });

  it("rejects a missing key", () => {
    expect(parseVerdict(JSON.stringify({ degree_ok: "yes", work_auth: "none" }))).toBeNull();
  });

  it("rejects an empty string and non-object JSON", () => {
    expect(parseVerdict("")).toBeNull();
    expect(parseVerdict("42")).toBeNull();
    expect(parseVerdict("not json at all")).toBeNull();
  });

  it("caps the reason", () => {
    const reason = "r".repeat(MAX_REASON_CHARS + 100);
    expect(parseVerdict(JSON.stringify({ ...good, reason }))?.reason).toHaveLength(
      MAX_REASON_CHARS,
    );
  });
});
