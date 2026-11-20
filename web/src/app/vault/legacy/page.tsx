import type { Metadata } from "next";
import { VaultApp } from "@/vault/VaultApp";

export const metadata: Metadata = {
  title: "Legacy invite",
  description: "Someone named you as a trusted person in their Sigil legacy plan. Open your vault to answer.",
  robots: { index: false },
};

/** Where a legacy invite link leads: the vault, opened on its Legacy tab, with the invite read from the link. */
export default function LegacyInvitePage() {
  return <VaultApp />;
}
