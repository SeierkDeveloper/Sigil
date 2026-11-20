import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDb } from "@/server/db";
import { movedTo } from "@/server/nodes";
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
  // A vault that moved to another node: this address points there for the period its owner chose. The part after # goes along.
  const to = movedTo(getDb(), "public", handle.toLowerCase());
  if (to) redirect(`${to}/@${handle.toLowerCase()}`);
  return <PublicApp handle={handle.toLowerCase()} />;
}
