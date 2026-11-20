import type { Metadata } from "next";
import { CaptureKeyApp } from "@/vault/CaptureKeyApp";

export const metadata: Metadata = {
  title: "Capture",
  description: "Send a note to your Sigil inbox with a capture key, sealed on this device.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function CaptureKeyPage() {
  return <CaptureKeyApp />;
}
