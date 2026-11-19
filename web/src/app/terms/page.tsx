import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { site } from "@/lib/site";

export const metadata: Metadata = {
  title: "Terms",
  description: "The terms for using Sigil, including the own-risk disclaimer.",
};

const LAST_UPDATED = "19 November 2026";

export default function Terms() {
  return (
    <div className="page">
      <div className="container">
        <PageHeader eyebrow="Terms" title="Terms of use" lead="Short and plain. By using Sigil you agree to these terms." />
        <div className="prose">
          <p className="meta">Last updated {LAST_UPDATED}</p>

          <h2>1. What Sigil is</h2>
          <p>
            Sigil is open-source software and a service for keeping an encrypted memory vault and letting AI apps you choose read parts of it. The
            features available today are the ones described on this site as built. Everything on the <Link href="/roadmap">roadmap</Link> marked as
            planned does not exist yet and may change or never be built.
          </p>

          <h2>2. Your keys are your responsibility</h2>
          <p>
            Your vault is encrypted with keys that only your passkeys, your wallets and your recovery phrase can unlock. Sigil does not have a copy and
            cannot reset them. <strong>If you lose every way into your vault, its contents are gone for good.</strong> Keep your recovery phrase safe
            and never share it.
          </p>

          <h2>3. Your content</h2>
          <p>
            What you put in your vault stays yours. You give Sigil only what it needs to provide the service: permission to store and transmit the
            encrypted data and the metadata described in the <Link href="/privacy">privacy notice</Link>. Do not store content you have no right to
            store.
          </p>

          <h2>4. Connected AI apps</h2>
          <p>
            When you connect an AI app, you decide which folders it may read. Once an app has read something, that app&apos;s own terms and policies
            apply to it, and Sigil has no control over what the app or its provider does with it. Revoking an app stops future reads, not past ones.
          </p>

          <h2>5. Acceptable use</h2>
          <p>
            Do not use Sigil to break the law, to attack or overload the service, to get into vaults that are not yours, or to store or share content
            that is illegal. We may suspend access that puts the service or other people at risk.
          </p>

          <h2>6. Early software, at your own risk</h2>
          <p>
            Sigil is early software provided <strong>as is</strong>, without warranties of any kind, including that it is free of errors, always
            available, or fit for a particular purpose. The code has not yet had an independent security audit. <strong>You use Sigil at your own
            risk.</strong> Keep your own copy of anything you cannot afford to lose; the vault can export everything at any time.
          </p>

          <h2>7. Liability</h2>
          <p>
            To the extent the law allows, Sigil and the people who build it are not liable for any loss of data, loss of access, or indirect or
            consequential loss arising from your use of Sigil or of AI apps you connect to it. Nothing in these terms limits liability that cannot be
            limited by law.
          </p>

          <h2>8. Nothing here is an offer or advice</h2>
          <p>
            The roadmap mentions a future network token. Nothing on this site is an offer to sell or buy anything, investment, legal, tax or financial
            advice, or a promise of any value or return. Tokens, if any are ever issued, can lose all of their value. Any decision you make is yours
            alone and at your own risk.
          </p>

          <h2>9. Ending</h2>
          <p>
            You can delete your account at any time from Settings in your vault; deletion is immediate and cannot be undone. If Sigil as a service
            ever closes, we will give notice on this site in good time so you can export your vault.
          </p>

          <h2>10. Changes</h2>
          <p>
            We may update these terms. The date at the top shows the latest version. If a change matters, we will say so on this site before it takes
            effect. Questions can be sent through the{" "}
            <a href={site.xUrl} target="_blank" rel="noopener noreferrer">
              Sigil account on X
            </a>{" "}
            or the{" "}
            <a href={site.githubUrl} target="_blank" rel="noopener noreferrer">
              repository
            </a>
            .
          </p>
        </div>
      </div>
    </div>
  );
}
