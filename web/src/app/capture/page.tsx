import type { Metadata } from "next";
import { CaptureApp } from "@/vault/CaptureApp";

export const metadata: Metadata = {
  title: "Quick capture",
  description: "Text, a link or a photo, sealed on your phone and put in your Sigil inbox.",
  robots: { index: false },
};

/** The fast capture screen, and where the phone's share sheet sends what is shared to Sigil. */
export default function CapturePage() {
  return <CaptureApp />;
}
