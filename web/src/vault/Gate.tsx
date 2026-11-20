"use client";

import { useEffect, useState } from "react";
import { isValidPhrase } from "@sigil/core";
import { PasskeyIcon, PhraseIcon, WalletIcon, ArrowIcon, PhoneIcon, QrIcon } from "@/components/icons";
import type { Api } from "./api";
import { ApiError } from "./api";
import * as ops from "./ops";
import { browserPasskeys, passkeysAvailable } from "./passkey";
import { connectWallet, listenForWallets, signVaultMessage, WalletRedirect } from "./wallet";
import { errorText } from "./context";
import { Notice } from "./ui";
import { PairNewDevice } from "./PairNewDevice";
import { DeviceRevoked, signInWithDevice } from "./deviceOps";
import { thisDevice } from "./offline";

export type GateMode = "create" | "signin" | "unlock";

interface Props {
  api: Api;
  mode: GateMode;
  onMode(mode: GateMode): void;
  onCreated(result: ops.NewVault): void;
  onUnlocked(vault: ops.Unlocked): void;
  onSignOut?(): void;
}

type Busy = null | "passkey" | "wallet" | "phrase" | "device";

export function Gate({ api, mode, onMode, onCreated, onUnlocked, onSignOut }: Props) {
  const [busy, setBusy] = useState<Busy>(null);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPhrase, setShowPhrase] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [pairing, setPairing] = useState(false);
  const [deviceName, setDeviceName] = useState<string | null>(null);

  useEffect(() => listenForWallets(), []);
  useEffect(() => {
    let alive = true;
    thisDevice()
      .then((d) => alive && setDeviceName(d?.name ?? null))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const run = async (which: Exclude<Busy, null>, fn: () => Promise<void>) => {
    setBusy(which);
    setError(null);
    try {
      await fn();
    } catch (err) {
      if (err instanceof WalletRedirect) {
        setStep("Opening this page in your wallet app.");
        return;
      }
      if (err instanceof ApiError && err.code === "unknown_wallet" && mode !== "create") {
        setError("No vault opens with this wallet. Create a vault with it, or sign in another way.");
      } else {
        setError(errorText(err));
      }
      setStep(null);
    } finally {
      setBusy(null);
    }
  };

  const withPasskey = () =>
    run("passkey", async () => {
      if (!passkeysAvailable()) throw new Error("This browser does not support passkeys. Use a wallet, or a recent browser.");
      if (mode === "create") {
        setStep("Create the passkey, then confirm it once more so Sigil can make your vault key.");
        onCreated(await ops.signUpWithPasskey(api, browserPasskeys));
      } else {
        setStep("Choose your Sigil passkey.");
        onUnlocked(await ops.signInWithPasskey(api, browserPasskeys));
      }
    });

  const withWallet = () =>
    run("wallet", async () => {
      setStep("Connect your wallet.");
      const { provider, address } = await connectWallet();
      if (mode === "create") {
        setStep("Approve the signature in your wallet. It is free and allows no transaction.");
        const first = await signVaultMessage(provider, address);
        setStep("Approve it once more, so Sigil can check that your wallet signs the same way every time.");
        const second = await signVaultMessage(provider, address);
        ops.assertStableSignature(first, second);
        setStep("Creating your vault.");
        onCreated(await ops.signUpWithWallet(api, address, first));
      } else {
        setStep("Approve the signature in your wallet. It is free and allows no transaction.");
        const sig = await signVaultMessage(provider, address);
        setStep("Opening your vault.");
        onUnlocked(await ops.signInWithWallet(api, address, sig));
      }
    });

  const withDevice = () =>
    run("device", async () => {
      setStep("Opening your vault with this device's key.");
      try {
        onUnlocked(await signInWithDevice(api));
      } catch (err) {
        if (err instanceof DeviceRevoked) setDeviceName(null);
        throw err;
      }
    });

  const withPhrase = (e: React.FormEvent) => {
    e.preventDefault();
    void run("phrase", async () => {
      if (!isValidPhrase(phrase)) throw new Error("That is not a valid recovery phrase. Check the 24 words and their order.");
      setStep("Opening your vault.");
      onUnlocked(await ops.signInWithPhrase(api, phrase));
      setPhrase("");
    });
  };

  const title = mode === "create" ? "Create your vault" : mode === "unlock" ? "Unlock your vault" : "Sign in to your vault";
  const lead =
    mode === "create"
      ? "Choose how you will sign in. Your vault key is made on this device, and you will get a recovery phrase to keep."
      : mode === "unlock"
        ? "Your vault locks whenever the page is closed or reloaded. Sign in again to unlock it on this device."
        : "Use the passkey or wallet you created your vault with, or your recovery phrase.";

  if (pairing) return <PairNewDevice api={api} onUnlocked={onUnlocked} onCancel={() => setPairing(false)} />;

  return (
    <section className="vault-gate" aria-labelledby="gate-title" data-mode={mode}>
      {mode !== "unlock" ? (
        <div className="segmented" role="group" aria-label="Create or sign in">
          <button type="button" aria-pressed={mode === "create"} onClick={() => onMode("create")} disabled={!!busy}>
            Create a vault
          </button>
          <button type="button" aria-pressed={mode === "signin"} onClick={() => onMode("signin")} disabled={!!busy}>
            Sign in
          </button>
        </div>
      ) : null}

      <h1 id="gate-title" className="vault-gate-title">
        {title}
      </h1>
      <p className="muted">{lead}</p>

      {error ? <Notice kind="error">{error}</Notice> : null}
      {step && busy ? <Notice>{step}</Notice> : null}

      <div className="method-list">
        {deviceName && mode !== "create" ? (
          <button type="button" className="method" onClick={withDevice} disabled={!!busy} data-testid="method-device">
            <PhoneIcon className="method-icon" />
            <span>
              <span className="method-title">Open with this device</span>
              <span className="method-text">The key this browser keeps for &quot;{deviceName}&quot;, added from your other device.</span>
            </span>
            {busy === "device" ? <span className="spinner" aria-hidden="true" /> : <ArrowIcon />}
          </button>
        ) : null}
        <button type="button" className="method" onClick={withPasskey} disabled={!!busy} data-testid="method-passkey">
          <PasskeyIcon className="method-icon" />
          <span>
            <span className="method-title">{mode === "create" ? "Create with a passkey" : "Use a passkey"}</span>
            <span className="method-text">Face ID, Touch ID, Windows Hello, your phone or a security key.</span>
          </span>
          {busy === "passkey" ? <span className="spinner" aria-hidden="true" /> : <ArrowIcon />}
        </button>
        <button type="button" className="method" onClick={withWallet} disabled={!!busy} data-testid="method-wallet">
          <WalletIcon className="method-icon" />
          <span>
            <span className="method-title">{mode === "create" ? "Create with a wallet" : "Use a wallet"}</span>
            <span className="method-text">A signature, never a transaction. On a phone this opens your wallet app.</span>
          </span>
          {busy === "wallet" ? <span className="spinner" aria-hidden="true" /> : <ArrowIcon />}
        </button>
        {mode !== "create" ? (
          <button type="button" className="method" onClick={() => setPairing(true)} disabled={!!busy} data-testid="method-pair">
            <QrIcon className="method-icon" />
            <span>
              <span className="method-title">Add this device</span>
              <span className="method-text">Show a code here and scan it with a device where your vault is open.</span>
            </span>
            <ArrowIcon />
          </button>
        ) : null}
        {mode !== "create" ? (
          <button type="button" className="method" onClick={() => setShowPhrase((v) => !v)} disabled={!!busy} aria-expanded={showPhrase} data-testid="method-phrase">
            <PhraseIcon className="method-icon" />
            <span>
              <span className="method-title">Use your recovery phrase</span>
              <span className="method-text">The 24 words you saved when you created the vault.</span>
            </span>
            {busy === "phrase" ? <span className="spinner" aria-hidden="true" /> : <ArrowIcon />}
          </button>
        ) : null}
      </div>

      {showPhrase && mode !== "create" ? (
        <form className="subpanel" onSubmit={withPhrase}>
          <div className="field">
            <label className="field-label" htmlFor="phrase">
              Recovery phrase
            </label>
            <textarea
              id="phrase"
              className="textarea"
              rows={4}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              placeholder="24 words, separated by spaces"
            />
            <span className="field-hint">The phrase is turned into keys in this browser. It is never sent.</span>
          </div>
          <button type="submit" className="button button-primary" disabled={!!busy || phrase.trim().split(/\s+/).length < 24}>
            Unlock with phrase
          </button>
        </form>
      ) : null}

      {mode === "unlock" && onSignOut ? (
        <p className="small muted gate-signout">
          Not your vault?{" "}
          <button type="button" className="text-button" onClick={onSignOut}>
            Sign out
          </button>
        </p>
      ) : null}
      {mode === "create" ? (
        <p className="small muted gate-signout">
          Your vault is already open on another device?{" "}
          <button type="button" className="text-button" onClick={() => setPairing(true)}>
            Add this device
          </button>
        </p>
      ) : null}
      {mode !== "unlock" ? (
        <p className="small muted gate-signout">
          Have a bundle of your vault, or a move code from another node?{" "}
          <a className="text-button" href="/vault/restore" data-testid="restore-link">
            Restore or move it here
          </a>
        </p>
      ) : null}
      {mode === "create" ? (
        <p className="small faint gate-terms">
          By creating a vault you accept the <a href="/terms">terms</a>. Sigil cannot recover a vault if every way into it is lost.
        </p>
      ) : null}
    </section>
  );
}
