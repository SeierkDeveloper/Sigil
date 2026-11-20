import type { Metadata } from "next";
import { VaultApp } from "@/vault/VaultApp";

export const metadata: Metadata = {
  title: "Add a device",
  description: "A new device is waiting for your vault. Open the vault here to send it, sealed to that device's own key.",
  robots: { index: false },
};

/** Where a pairing QR code leads when it is scanned with a phone's camera: the vault, opened on its Devices tab. */
export default function PairPage() {
  return <VaultApp />;
}
