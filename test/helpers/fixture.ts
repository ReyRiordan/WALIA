import { readFileSync } from "node:fs";

/** Read a captured response from test/fixtures/ as a UTF-8 string. */
export function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
}
