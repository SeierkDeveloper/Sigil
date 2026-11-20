import type { Metadata } from "next";
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
  return <EmergencyApp cardId={id} />;
}
