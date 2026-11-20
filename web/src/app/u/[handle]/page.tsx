import type { Metadata } from "next";
import { PublicApp } from "@/public/PublicApp";

type Params = { params: Promise<{ handle: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { handle } = await params;
  return {
    title: `@${handle.toLowerCase()}`,
    description: "Ask this person's AI self. It answers only from what they made public, and every answer is marked as written by an AI.",
    referrer: "no-referrer",
  };
}

/** The public AI self at /@handle (rewritten here). */
export default async function PublicSelfPage({ params }: Params) {
  const { handle } = await params;
  return <PublicApp handle={handle.toLowerCase()} />;
}
