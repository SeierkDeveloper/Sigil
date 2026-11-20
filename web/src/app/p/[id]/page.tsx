import type { Metadata } from "next";
import { PackApp } from "@/packs/PackApp";

export const metadata: Metadata = {
  title: "Knowledge pack",
  description: "A knowledge pack: a folder its publisher made public, signed by their vault. Checked in your browser, and free to follow.",
  referrer: "no-referrer",
};

type Params = { params: Promise<{ id: string }> };

export default async function PackPage({ params }: Params) {
  const { id } = await params;
  return <PackApp packId={id} />;
}
