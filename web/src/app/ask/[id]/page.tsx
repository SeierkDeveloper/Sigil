import type { Metadata } from "next";
import { AskApp } from "@/ask/AskApp";

export const metadata: Metadata = {
  title: "Ask an AI self",
  description: "Ask someone's AI self a question. The conversation is encrypted in your browser; the server passes it on without being able to read it.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

type Params = { params: Promise<{ id: string }> };

export default async function AskPage({ params }: Params) {
  const { id } = await params;
  return <AskApp linkId={id} />;
}
