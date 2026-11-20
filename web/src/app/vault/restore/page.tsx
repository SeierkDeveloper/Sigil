import type { Metadata } from "next";
import { VaultApp } from "@/vault/VaultApp";

export const metadata: Metadata = {
  title: "Restore a vault",
  description: "Restore your Sigil vault on this node from a bundle you kept, or move it here from another node. It opens only with your recovery phrase or wallet.",
  robots: { index: false },
};

/** Restoring a bundle, or arriving with a move code from another node: the vault page, starting on the restore step. */
export default function RestorePage() {
  return <VaultApp restore />;
}
