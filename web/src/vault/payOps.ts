// Payments by the AI self from its own wallet, on the owner's device. The self
// key signs the call (EIP-712, as the wallet checks it); the owner's own browser
// wallet sends it, so the self key never needs gas. Within the owner's limits
// (limitsOps.ts) and the wallet's caps on chain, the self pays on its own and
// signs a receipt. Past a limit, the payment waits in Work for the owner.

import { formatUnits, newDraft, parseUnits, paymentWithinLimits, sameAddress, type LimitDecision, type PaymentChannel, type WalletRules } from "@sigil/core";
import type { Api } from "./api";
import type { Unlocked, VaultData } from "./ops";
import * as idOps from "./identityOps";
import { recordReceipt, type ReceiptView } from "./receiptOps";
import { saveDraft, type DraftView } from "./workOps";

export interface PaymentAsk {
  /** A recipient of the wallet rules. */
  to: string;
  /** In whole units. */
  amount: string;
  /** A token of the wallet rules, or null for the chain's coin. */
  token: string | null;
}

export type PaymentOutcome =
  | { kind: "paid"; tx: string; receipt: ReceiptView; limit: string }
  | { kind: "queued"; reason: string; draft: DraftView };

function labelOf(rules: WalletRules, to: string): string {
  const r = rules.recipients.find((x) => sameAddress(x.address, to));
  return r?.label ? `${r.label} (${r.address})` : to;
}

/** The call, the plain words for it and the owner's limit decision, without sending anything. */
export async function decide(data: VaultData, chain: idOps.ChainConfig, wallet: string, selfKey: string, ask: PaymentAsk): Promise<{ call: idOps.SelfCall; channel: PaymentChannel; decision: LimitDecision }> {
  const rules = data.walletRules;
  if (!rules) throw new Error("Save the wallet rules first.");
  const token = ask.token ? rules.tokens.find((t) => sameAddress(t.address, ask.token)) ?? null : null;
  if (ask.token && !token) throw new Error("That token is not in the wallet rules.");
  const call = idOps.paymentCall(ask.to, ask.amount, token ? { address: token.address, decimals: token.decimals } : null);
  const listed = rules.recipients.some((r) => sameAddress(r.address, ask.to));
  const refusal = await idOps.tryOnChain(chain, wallet, selfKey, call);
  const max = !token && data.limits.payments.maxPerPayment ? parseUnits(data.limits.payments.maxPerPayment) : null;
  const decision = paymentWithinLimits(data.limits, { listed, value: token ? null : call.value, max, chainRefusal: refusal });
  const channel: PaymentChannel = {
    kind: "payment",
    chainId: chain.chainId,
    wallet,
    target: call.target,
    value: call.value.toString(),
    data: call.data,
    to: labelOf(rules, ask.to),
    amount: token ? formatUnits(parseUnits(ask.amount, token.decimals), token.decimals) : formatUnits(call.value),
    token: token ? token.label || token.address : null,
  };
  return { call, channel, decision };
}

/** Signs the call with the self key and sends it from the owner's wallet. Returns the transaction hash once it is in a block. */
export async function submit(vault: Unlocked, eth: idOps.InjectedWallet, chain: idOps.ChainConfig, wallet: string, call: idOps.SelfCall): Promise<string> {
  const nonce = await idOps.walletNonce(chain, wallet);
  const data = await idOps.signSelfCall(vault, chain, wallet, call, nonce);
  const tx = await idOps.sendFromOwner(eth, chain, wallet, data);
  await idOps.waitForTx(chain, tx, { eth });
  return tx;
}

/** Sends a payment that waited in Work, now that the owner approved it. */
export async function payApproved(vault: Unlocked, eth: idOps.InjectedWallet, chain: idOps.ChainConfig, ch: PaymentChannel): Promise<{ tx: string }> {
  if (ch.chainId !== chain.chainId) throw new Error("This payment is for another chain than this site's.");
  return { tx: await submit(vault, eth, chain, ch.wallet, { target: ch.target, value: BigInt(ch.value), data: ch.data as `0x${string}` }) };
}

/**
 * The self is asked to pay. Within the owner's limits and the wallet's caps on
 * chain, it pays on its own and signs a receipt. Otherwise the payment waits
 * in Work, with the reason, for the owner to approve or discard.
 */
export async function selfPay(api: Api, vault: Unlocked, data: VaultData, eth: () => Promise<idOps.InjectedWallet>, chain: idOps.ChainConfig, wallet: string, selfKey: string, ask: PaymentAsk): Promise<PaymentOutcome> {
  const { call, channel, decision } = await decide(data, chain, wallet, selfKey, ask);
  const what = `Paid ${channel.amount}${channel.token ? ` ${channel.token}` : ""} to ${channel.to}`;
  if (!decision.ok) {
    const draft = await saveDraft(
      api,
      vault,
      null,
      newDraft({ kind: "payment", title: `Pay ${channel.amount}${channel.token ? ` ${channel.token}` : ""} to ${channel.to}`, input: decision.reason, from: "", channel, draft: `${what}.`, sources: [], usedModel: false }),
    );
    return { kind: "queued", reason: decision.reason, draft };
  }
  const tx = await submit(vault, await eth(), chain, wallet, call);
  const receipt = await recordReceipt(api, vault, { kind: "payment", what, limit: decision.limit, ref: { chainId: chain.chainId, wallet, tx } });
  return { kind: "paid", tx, receipt, limit: decision.limit };
}
