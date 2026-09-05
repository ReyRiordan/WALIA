/** Whether the posting's degree requirement admits a master's student. */
export type DegreeOk = "yes" | "no" | "unclear";

/** Work authorisation constraint found in the description. */
export type WorkAuth = "none" | "citizen_only" | "no_sponsorship" | "unclear";

/** The classifier's answer for one job. Stored on the job row and read by the loop. */
export interface Verdict {
  degreeOk: DegreeOk;
  workAuth: WorkAuth;
  reason: string;
}
