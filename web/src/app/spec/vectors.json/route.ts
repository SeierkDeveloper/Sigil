import { specVectors } from "@/lib/spec";

export const dynamic = "force-static";

/** The test vectors of the open standard, as generated from the reference code. */
export function GET() {
  return new Response(specVectors(), { headers: { "content-type": "application/json; charset=utf-8" } });
}
