"use client";

// Holder: link the wallet that holds the token and see the tier it gives. The
// wallet signs one message to prove it is yours; nothing is sent on chain and
// nothing is paid. The tier follows the balance and is read again every day.

import { useState } from "react";
import Link from "next/link";
import { CodeBlock } from "@/components/CodeBlock";
import { DeviceIcon } from "@/components/icons";
import { formatDateTime } from "@/lib/format";
import * as holderOps from "../holderOps";
import { errorText, useVault } from "../context";
import { Notice, PlateHead } from "../ui";

const whole = (n: number) => Math.floor(n).toLocaleString("en-US");
const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;

export function HolderTab() {
  const { api, data, update, goTo } = useVault();
  const holder = data.holder;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [passCode, setPassCode] = useState<string | null>(null);
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  const act = async (fn: () => Promise<NonNullable<typeof holder>>, done: (h: NonNullable<typeof holder>) => string | null) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const next = await fn();
      update((d) => ({ ...d, holder: next }));
      setNote(done(next));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const tier = holder?.tier ?? null;
  const next = holderOps.TIERS.find((t) => !tier || t.min > (holderOps.TIERS.find((x) => x.tier === tier)?.min ?? 0));
  const left = holderOps.answersLeft(holder);

  return (
    <div className="holder">
      <div className="panel-header">
        <h2 className="panel-title">Holder</h2>
        <p className="small muted">
          Link the wallet you hold the token in, and holding it unlocks more in Sigil. Your wallet signs one message to prove it is yours: nothing is sent on chain and
          nothing is paid. Your tier follows your balance and is read again every day.
        </p>
      </div>

      {error ? <Notice kind="error">{error}</Notice> : null}
      {note ? <Notice kind="success">{note}</Notice> : null}

      <section className="subpanel plate" aria-labelledby="holder-you">
        <PlateHead number="01" id="holder-you" title={tier ? holderOps.TIER_NAME[tier] : "Your tier"} lead={holder?.linked ? `Wallet ${short(holder.address ?? "")}` : "No wallet linked yet."}>
          <span className="plate-state" data-on={tier ? "true" : "false"} data-testid="holder-tier">
            {tier ? holderOps.TIER_NAME[tier] : holder?.linked ? "Below 1,000,000" : "Not linked"}
          </span>
        </PlateHead>
        {holder?.linked ? (
          <>
            <dl className="holder-facts">
              <div>
                <dt>Held</dt>
                <dd className="mono" data-testid="holder-balance">
                  {whole(holder.balance)}
                </dd>
              </div>
              <div>
                <dt>Included answers today</dt>
                <dd className="mono" data-testid="holder-answers">
                  {tier ? `${left} of ${holder.answersPerDay} left` : "None"}
                </dd>
              </div>
              <div>
                <dt>Read</dt>
                <dd>{holder.checkedAt ? formatDateTime(holder.checkedAt) : "Not yet"}</dd>
              </div>
            </dl>
            {next && tier !== "warden" ? (
              <p className="small muted">
                {holderOps.TIER_NAME[next.tier]} starts at {whole(next.min)}. {holder.balance < next.min ? `${whole(next.min - holder.balance)} more to go.` : ""}
              </p>
            ) : null}
            {tier && data.model ? (
              <p className="small muted">
                You have a model key of your own, so Ask and your AI self use it, straight from this device. Remove it under AI self to use your included answers instead.
              </p>
            ) : null}
            {tier && !data.model && !holder.includedOn ? <p className="small muted">This node does not offer included answers right now. A model key of your own works as always.</p> : null}
            <div className="form-actions">
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => void act(() => holderOps.refreshHolder(api), (h) => (h.tier ? `Read again: ${holderOps.TIER_NAME[h.tier]}.` : "Read again."))}
              >
                Read my balance again
              </button>
              <button type="button" className="button button-ghost" disabled={busy} onClick={() => void act(() => holderOps.unlinkWallet(api), () => "Wallet unlinked.")}>
                Unlink wallet
              </button>
            </div>
          </>
        ) : (
          <div className="form-actions">
            <button
              type="button"
              className="button button-primary"
              disabled={busy}
              data-testid="holder-link"
              onClick={() => void act(() => holderOps.linkWallet(api), (h) => (h.tier ? `Linked. You are a ${holderOps.TIER_NAME[h.tier]}.` : "Linked. This wallet holds less than 1,000,000 for now."))}
            >
              {busy ? "Waiting for your wallet" : "Link my wallet"}
            </button>
          </div>
        )}
        <p className="device-line">
          <DeviceIcon />
          <span>
            Included answers pass through Sigil&apos;s server to the model and are not kept. With a model key of your own, every answer goes from this device straight to
            the provider.
          </span>
        </p>
      </section>

      <section className="subpanel plate" aria-labelledby="holder-tiers">
        <PlateHead number="02" id="holder-tiers" title="What each tier gives" lead="Everything Sigil does today stays free for everyone. Holding adds to it." />
        <div className="holder-tiers">
          {holderOps.TIERS.map((t) => (
            <div key={t.tier} className="holder-tier" data-on={tier === t.tier ? "true" : undefined} data-testid={`tier-${t.tier}`}>
              <h3 className="holder-tier-name">
                {holderOps.TIER_NAME[t.tier]} <span className="mono small faint">{whole(t.min)}+</span>
              </h3>
              <ul className="holder-perks">
                {t.perks.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p className="small faint">
          Every tier also lets your agents write more an hour and your apps ask more a minute, and your read log can be saved with every seal proof under{" "}
          <button type="button" className="text-button" onClick={() => goTo("log")}>
            Read log
          </button>
          .
        </p>
      </section>

      {holder?.linked ? (
        <section className="subpanel plate" aria-labelledby="holder-pass">
          <PlateHead number="03" id="holder-pass" title="Sigil Pass" lead="Let other apps, sites and agents check your tier with one call, so they can give holders perks of their own.">
            <span className="plate-state" data-on={holder.pass ? "true" : "false"} data-testid="pass-state">
              {holder.pass ? "On" : "Off"}
            </span>
          </PlateHead>
          {passCode ? (
            <>
              <CodeBlock code={passCode} label="Your pass code" />
              <p className="small muted">Copy it now: it is shown once. Give it to an app that asks for your Sigil Pass. A new code stops this one from working.</p>
            </>
          ) : null}
          {holder.pass ? (
            <>
              <dl className="holder-facts">
                <div>
                  <dt>Checked by apps</dt>
                  <dd className="mono" data-testid="pass-checks">
                    {whole(holder.pass.checks)}
                  </dd>
                </div>
                <div>
                  <dt>Last check</dt>
                  <dd>{holder.pass.lastCheckAt ? formatDateTime(holder.pass.lastCheckAt) : "Not yet"}</dd>
                </div>
                <div>
                  <dt>Made</dt>
                  <dd>{formatDateTime(holder.pass.createdAt)}</dd>
                </div>
              </dl>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={holder.pass.byWallet}
                  disabled={busy}
                  onChange={(e) => {
                    const on = e.target.checked;
                    void act(() => holderOps.passByWallet(api, on), () => (on ? "Apps can now check your tier by your wallet address too." : "Apps can no longer check your tier by your wallet address."));
                  }}
                />
                <span>
                  Apps can also check by my wallet address
                  <span className="field-hint">For apps where you already connect this wallet. Without it, only your pass code works.</span>
                </span>
              </label>
              <div className="form-actions">
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() =>
                    void act(
                      async () => {
                        const r = await holderOps.makePass(api);
                        setPassCode(r.code);
                        return r.status;
                      },
                      () => "New pass code made. The old one no longer works.",
                    )
                  }
                >
                  New pass code
                </button>
                <button
                  type="button"
                  className="button button-ghost"
                  disabled={busy}
                  onClick={() =>
                    void act(
                      async () => {
                        setPassCode(null);
                        return holderOps.endPass(api);
                      },
                      () => "Pass ended. No app can check your tier now.",
                    )
                  }
                >
                  End my pass
                </button>
              </div>
            </>
          ) : (
            <div className="form-actions">
              <button
                type="button"
                className="button button-primary"
                disabled={busy}
                data-testid="pass-make"
                onClick={() =>
                  void act(
                    async () => {
                      const r = await holderOps.makePass(api);
                      setPassCode(r.code);
                      return r.status;
                    },
                    () => "Your pass is made.",
                  )
                }
              >
                Make my pass
              </button>
            </div>
          )}
          <p className="small faint">
            An app checks with <span className="mono">{`${origin}/api/pass/`}</span>
            {"<your code>"} and learns only your tier: never your wallet, your balance or anything in your vault. How apps use it is in the <Link href="/docs#pass">docs</Link>.
          </p>
        </section>
      ) : null}

      {tier === "warden" ? (
        <section className="subpanel plate" aria-labelledby="holder-anchors">
          <PlateHead number="04" id="holder-anchors" title="Your reads on chain" lead="Each day, the reads of your vault the day before become one root, anchored on chain." />
          {holder?.anchors.length ? (
            <ul className="holder-anchors">
              {holder.anchors.map((a) => (
                <li key={a.day}>
                  <span>{a.day}</span>
                  <span className="mono small">{`${a.root.slice(0, 10)}...${a.root.slice(-6)}`}</span>
                  <span className="small muted">{a.leaves} reads</span>
                  <span className="mono small">{a.tx ? `${a.tx.slice(0, 10)}...` : "Waiting"}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="small muted">The first day&apos;s reads are anchored tomorrow.</p>
          )}
        </section>
      ) : null}
    </div>
  );
}
