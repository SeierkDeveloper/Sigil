import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDb } from "@/server/db";
import { movedTo } from "@/server/nodes";
import { EmergencyApp } from "@/emergency/EmergencyApp";

export const metadata: Metadata = {
  title: "Emergency information",
  description: "A medical card its owner chose to share in an emergency. It is decrypted in this browser with the key in the link.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

type Params = { params: Promise<{ id: string }> };

export default async function EmergencyPage({ params }: Params) {
  const { id } = await params;
  // A vault that moved to another node: this address points there for the period its owner chose. The part after # goes along.
  const to = movedTo(getDb(), "emergency", id);
  if (to) redirect(`${to}/e/${id}`);
  return <EmergencyApp cardId={id} />;
}
