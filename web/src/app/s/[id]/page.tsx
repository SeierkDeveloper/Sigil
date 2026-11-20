import type { Metadata } from "next";
import { SessionApp } from "@/sessions/SessionApp";

export const metadata: Metadata = {
  title: "A session with an AI self",
  description: "A booked session with someone's AI self. Your questions are encrypted in your browser; every answer is written by an AI.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

type Params = { params: Promise<{ id: string }> };

export default async function SessionPage({ params }: Params) {
  const { id } = await params;
  return <SessionApp bookingId={id} />;
}
