import type { Metadata } from "next";
import { AuthorizePage } from "@/vault/AuthorizePage";

export const metadata: Metadata = {
  title: "Sign in with Sigil",
  description: "A web app asks to read chosen folders of your Sigil vault. You decide which, and you can revoke it at any time.",
  robots: { index: false },
};

export default function Authorize() {
  return <AuthorizePage />;
}
