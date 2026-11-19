// Wallets through EIP-1193, with no wallet SDK. On a phone without an injected
// wallet, the button opens this same page inside the wallet app's browser.

import { toHex, utf8, walletKeyMessage } from "@sigil/core";

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

declare global {
  interface Window {
    ethereum?: Eip1193;
  }
}

let announced: Eip1193 | null = null;

/** EIP-6963: wallets announce themselves; keep the first one in case window.ethereum is missing. */
export function listenForWallets(): () => void {
  if (typeof window === "undefined") return () => {};
  const onAnnounce = (e: Event) => {
    const detail = (e as CustomEvent<{ provider?: Eip1193 }>).detail;
    if (!announced && detail?.provider) announced = detail.provider;
  };
  window.addEventListener("eip6963:announceProvider", onAnnounce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  return () => window.removeEventListener("eip6963:announceProvider", onAnnounce);
}

export function getProvider(): Eip1193 | null {
  if (typeof window === "undefined") return null;
  return window.ethereum ?? announced;
}

/** A phone needs both a coarse pointer and a phone user agent; a touchscreen laptop is not a phone. Read at tap time only. */
export function isPhone(): boolean {
  if (typeof window === "undefined") return false;
  const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  return coarse && /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

export function walletAppLink(): string {
  const { host, pathname, search, hash } = window.location;
  return `https://metamask.app.link/dapp/${host}${pathname}${search}${hash}`;
}

export class WalletRedirect extends Error {
  constructor() {
    super("Opening this page in your wallet app.");
    this.name = "WalletRedirect";
  }
}

export class NoWallet extends Error {
  constructor() {
    super("No wallet was found in this browser. Install a browser wallet, or use a passkey instead.");
    this.name = "NoWallet";
  }
}

function friendly(err: unknown): Error {
  const e = err as { code?: number; message?: string };
  if (e?.code === 4001) return new Error("You declined the request in your wallet.");
  if (e?.code === -32002) return new Error("Your wallet already has a request open. Check the wallet window.");
  return err instanceof Error ? err : new Error(e?.message ?? "The wallet request failed.");
}

/**
 * Returns the connected address. Without a wallet: on a phone, navigates to the
 * wallet app's browser; on a computer, opens the wallet download page. Both throw
 * so the caller can show what happened.
 */
export async function connectWallet(): Promise<{ provider: Eip1193; address: string }> {
  const provider = getProvider();
  if (!provider) {
    if (isPhone()) {
      window.location.href = walletAppLink();
      throw new WalletRedirect();
    }
    window.open("https://metamask.io/download/", "_blank", "noopener,noreferrer");
    throw new NoWallet();
  }
  try {
    const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
    if (!accounts?.[0]) throw new Error("The wallet did not share an address.");
    return { provider, address: accounts[0] };
  } catch (err) {
    throw friendly(err);
  }
}

/** Signs the fixed vault-key message. The signature is turned into keys in the browser and never sent. */
export async function signVaultMessage(provider: Eip1193, address: string): Promise<string> {
  const message = walletKeyMessage(address);
  try {
    const sig = (await provider.request({ method: "personal_sign", params: ["0x" + toHex(utf8(message)), address] })) as string;
    if (typeof sig !== "string" || !sig.startsWith("0x")) throw new Error("The wallet returned an unexpected signature.");
    return sig;
  } catch (err) {
    throw friendly(err);
  }
}
