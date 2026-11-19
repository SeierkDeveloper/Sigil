import type { Metadata } from "next";
import { VaultApp } from "@/vault/VaultApp";

export const metadata: Metadata = {
  title: "Vault",
  description: "Your Sigil vault: memories, folders, connected apps and the read log, decrypted only on this device.",
  robots: { index: false },
};

export default function VaultPage() {
  return <VaultApp />;
}
