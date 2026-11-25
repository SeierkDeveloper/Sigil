import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";
import { CodeBlock } from "@/components/CodeBlock";
import { site } from "@/lib/site";
import { readToken, tokenConfig, tokenLive } from "@/server/token";

// Always shown. Before the launch it explains the burn and says where the address will appear, without the ticker
// (nobody can launch a copy under the right name ahead of it). Once live (see server/token.ts) it adds the contract
// and the burns read from the chain, cached for a minute on the server.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const c = tokenConfig();
  const live = tokenLive(c);
  const name = live ? c.symbol : "Sigil's token";
  return {
    title: live ? c.symbol : "Token",
    description: `${name}: part of every trade's fee buys it back and burns it, at most every 30 minutes, so the supply only goes down.`,
  };
}

const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;
const num = (n: number, d = 0) => n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
const when = (t: number) => new Date(t).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";

const tiers = [
  { name: "Bearer", min: "1,000,000+", perks: ["10 included AI answers a day in Ask and your AI self, no API key needed", "The holder mark on your public AI self page and ask links"] },
  { name: "Keeper", min: "5,000,000+", perks: ["30 included AI answers a day", "The holder mark"] },
  {
    name: "Warden",
    min: "10,000,000+",
    perks: ["75 included AI answers a day", "A short handle of 3 or 4 letters for your public AI self", "Each day's reads of your vault anchored on chain", "The Warden mark"],
  },
];

export default async function TokenPage() {
  const c = tokenConfig();
  const live = tokenLive(c);
  const name = live ? c.symbol : "the token";
  const s = live ? await readToken(c).catch(() => null) : null;
  const link = (path: string, label: string) =>
    c.explorer ? (
      <a href={`${c.explorer}/${path}`} target="_blank" rel="noopener noreferrer">
        {label}
      </a>
    ) : (
      label
    );

  const steps = [
    { title: "Every trade pays a fee", text: `Each buy or sell of ${name} pays a small fee, taken by its contracts as part of the trade.` },
    { title: "The burn pot buys it back", text: `Part of that fee goes to the burn pot, a contract that at most every 30 minutes spends what it holds on ${name}.` },
    { title: "The token's own burn destroys it", text: "Everything it buys is burned with the token's own burn, not parked at a dead address, so the total supply really goes down." },
  ];

  return (
    <div className="page">
      <div className="container">
        <PageHeader
          eyebrow={live ? c.symbol : "Token"}
          title="Bought back and burned, every 30 min"
          lead={`Sigil's token. Part of every trade's fee buys it back and burns it, so the supply only goes down. Nobody runs the burn by hand, and every burn is a transaction anyone can check.`}
        />

        <section className="page-section" aria-labelledby="ca-title">
          <h2 id="ca-title" className="section-title">
            The contract
          </h2>
          {live ? (
            <>
              <CodeBlock code={c.token!} label={`${c.symbol} contract address`} />
              {c.tradeUrl ? (
                <p>
                  <a className="button button-primary" href={c.tradeUrl} target="_blank" rel="noopener noreferrer">
                    Open {c.symbol} on Pons
                  </a>
                </p>
              ) : null}
              <p className="small">
                {link(`address/${c.token}`, "The token on the explorer")} · {link(`address/${c.pot}`, "The burn pot on the explorer")}
              </p>
            </>
          ) : (
            <p className="notice" role="status">
              <span>
                Not live yet. The contract address appears here the moment the token is live, and is posted on{" "}
                <a href={site.xUrl} target="_blank" rel="noopener noreferrer">
                  Sigil&apos;s X
                </a>{" "}
                at the same time. Any address you see before that is not Sigil&apos;s.
              </span>
            </p>
          )}
        </section>

        <section className="page-section" aria-labelledby="how-title">
          <h2 id="how-title" className="section-title">
            How the burn works
          </h2>
          <ol className="steps steps-3">
            {steps.map((x) => (
              <li key={x.title} className="step">
                <h3 className="step-title">{x.title}</h3>
                <p className="step-text">{x.text}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="page-section" aria-labelledby="tiers-title" id="tiers">
          <h2 id="tiers-title" className="section-title">
            What holding gives you
          </h2>
          <p className="small muted">
            Link the wallet you hold it in under Holder in your vault. Your wallet signs one message to prove it is yours; nothing is sent on chain and nothing is paid.
            Your tier follows your balance and is read again every day.
          </p>
          <div className="grid grid-3">
            {tiers.map((t) => (
              <article key={t.name} className="card">
                <span className="card-number">{t.min}</span>
                <h3 className="card-title">{t.name}</h3>
                <ul className="holder-perks">
                  {t.perks.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
          <p className="small faint">
            Included answers pass through Sigil&apos;s server to the model and are not kept; with a model key of your own, answers still go from your device straight to the
            provider. Every tier also lets agents write more an hour and apps ask more a minute, and saves the read log with every seal proof.{" "}
            <Link href="/vault#holder">Link your wallet</Link>.
          </p>
        </section>

        {live ? (
          <>
            <section className="page-section" aria-labelledby="burn-title">
              <h2 id="burn-title" className="section-title">
                Burned so far
              </h2>
              {s ? (
                <dl className="stats">
                  <div className="stat">
                    <dt className="stat-label">Burned</dt>
                    <dd className="stat-value">
                      <span className="stat-number">{num(s.burnedTokens)}</span>
                    </dd>
                    <dd className="stat-text">{c.symbol} gone for good: every burn by the pot plus the dev wallet&apos;s own bag.</dd>
                  </div>
                  <div className="stat">
                    <dt className="stat-label">Supply left</dt>
                    <dd className="stat-value">
                      <span className="stat-number">{num(s.supplyLeft)}</span>
                    </dd>
                    <dd className="stat-text">Total supply minus everything burned, right now.</dd>
                  </div>
                  <div className="stat">
                    <dt className="stat-label">Burns</dt>
                    <dd className="stat-value">
                      <span className="stat-number">{num(s.burnCount)}</span>
                    </dd>
                    <dd className="stat-text">{s.lastBurnAt ? `The last one ${when(s.lastBurnAt)}.` : "The first one comes 30 min after the first fees."}</dd>
                  </div>
                  <div className="stat">
                    <dt className="stat-label">In the pot now</dt>
                    <dd className="stat-value">
                      <span className="stat-number">{num(s.potEth, 4)}</span>
                    </dd>
                    <dd className="stat-text">
                      ETH waiting for the next burn{s.nextBurnAt ? `, from ${when(s.nextBurnAt)}` : ""}. Spent on burns so far: {num(s.ethSpent, 4)} ETH.
                    </dd>
                  </div>
                </dl>
              ) : (
                <p className="notice" role="status">
                  <span>The numbers could not be read from the chain right now. They come back by themselves; the contracts keep burning either way.</span>
                </p>
              )}
            </section>

            <section className="page-section" aria-labelledby="burns-title">
              <h2 id="burns-title" className="section-title">
                Every burn
              </h2>
              {s && s.burns.length ? (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>No.</th>
                        <th>When</th>
                        <th>Spent</th>
                        <th>Burned</th>
                        <th>Transaction</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.burns.map((b) => (
                        <tr key={b.tx + b.n}>
                          <td>{b.dev ? "Dev" : b.n}</td>
                          <td>{when(b.at)}</td>
                          <td>{b.dev ? "Dev wallet bag" : `${num(b.eth, 4)} ETH`}</td>
                          <td>
                            {num(b.tokens)} {c.symbol}
                          </td>
                          <td>{link(`tx/${b.tx}`, short(b.tx))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="small">No burn yet. The first one comes 30 min after the first trading fees reach the pot.</p>
              )}
            </section>
          </>
        ) : null}

        <section className="page-section" aria-labelledby="more-title">
          <h2 id="more-title" className="section-title">
            What it is, and what it is not
          </h2>
          <div className="grid grid-3">
            <article className="card">
              <span className="card-number">In the open</span>
              <h3 className="card-title">Every burn on the chain</h3>
              <p className="card-text">
                Each burn is its own transaction. Once the token is live, this page reads them straight from the contracts, with a link to every one.
              </p>
            </article>
            <article className="card">
              <span className="card-number">Not needed</span>
              <h3 className="card-title">Sigil works without it</h3>
              <p className="card-text">Everything Sigil does today stays free for everyone. Holding adds to it: included AI answers, the holder mark and, for Wardens, more.</p>
            </article>
            <article className="card">
              <span className="card-number">Later</span>
              <h3 className="card-title">It pays for the network</h3>
              <p className="card-text">
                When the network arrives, its fees are paid in the token and burned on use. <Link href="/roadmap">See the roadmap</Link>.
              </p>
            </article>
          </div>
        </section>

        <section className="page-section">
          <p className="faint small">
          At your own risk. The token can lose all of its value. Holding it gives no claim on Sigil, its income or anything else, and no share of
          anything. Not investment advice. Check every transaction in your own wallet before you sign it.
          </p>
        </section>
      </div>
    </div>
  );
}
