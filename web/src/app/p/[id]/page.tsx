import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDb } from "@/server/db";
import { movedTo } from "@/server/nodes";
import { PackApp } from "@/packs/PackApp";

export const metadata: Metadata = {
  title: "Knowledge pack",
  description: "A knowledge pack: a folder its publisher made public, signed by their vault. Checked in your browser, and free to follow.",
  referrer: "no-referrer",
};

type Params = { params: Promise<{ id: string }> };

export default async function PackPage({ params }: Params) {
  const { id } = await params;
  // A vault that moved to another node: this address points there for the period its owner chose. The part after # goes along.
  const to = movedTo(getDb(), "pack", id);
  if (to) redirect(`${to}/p/${id}`);
  return <PackApp packId={id} />;
}
