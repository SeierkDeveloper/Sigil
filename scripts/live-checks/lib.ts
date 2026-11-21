// Shared helpers for the go-live checks: reading settings without echoing
// secrets, and printing results plainly.

import { createInterface } from "node:readline";

export async function ask(name: string, prompt: string, opts: { secret?: boolean; optional?: boolean } = {}): Promise<string> {
  const fromEnv = process.env[name]?.trim();
  if (fromEnv) return fromEnv;
  if (opts.optional && !process.stdin.isTTY) return "";
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
  if (opts.secret) out._writeToOutput = (s: string) => out.output.write(s.includes(prompt) ? s : "");
  const answer = await new Promise<string>((resolve) => rl.question(`${prompt}${opts.optional ? " (Enter to skip)" : ""}: `, resolve));
  rl.close();
  if (opts.secret) process.stdout.write("\n");
  if (!answer.trim() && !opts.optional) fail(`${name} is needed.`);
  return answer.trim();
}

export function secretShape(v: string | null | undefined): string {
  return v ? `present, ${v.length} characters` : "missing";
}

let failed = 0;
export function ok(what: string, detail = ""): void {
  process.stdout.write(`PASS  ${what}${detail ? `: ${detail}` : ""}\n`);
}
export function bad(what: string, detail = ""): void {
  failed++;
  process.stdout.write(`FAIL  ${what}${detail ? `: ${detail}` : ""}\n`);
}
export function note(what: string): void {
  process.stdout.write(`      ${what}\n`);
}
export function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
export function done(): never {
  process.stdout.write(failed ? `\n${failed} check(s) failed.\n` : "\nAll checks passed.\n");
  process.exit(failed ? 1 : 0);
}

export function baseUrl(v: string): string {
  const u = new URL(v);
  if (u.protocol !== "https:" && u.hostname !== "localhost" && u.hostname !== "127.0.0.1") fail("Use the https address of the node.");
  return u.origin;
}
