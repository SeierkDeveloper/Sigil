import type { Metadata } from "next";
import { ConnectReturn } from "@/vault/ConnectReturn";

export const metadata: Metadata = {
  title: "Connecting",
  description: "Hands a sign-in back to your open vault.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/** Where a service sends you back after you sign in for live sync. It passes the code to the vault window that opened it, and closes. */
export default function ConnectPage() {
  return <ConnectReturn />;
}
