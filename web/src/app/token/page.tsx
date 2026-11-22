import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/PageHeader";
import { CodeBlock } from "@/components/CodeBlock";
import { readToken, tokenConfig, tokenLive } from "@/server/token";

// Read on every request (the numbers are cached for a minute on the server), and only while the token is live.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const c = tokenConfig();
  if (!tokenLive(c)) return { title: "Not found" };
  return { title: c.symbol, description: `${c.symbol}, the network token: bought back and burned by its contract at most every 30 minutes.` };
}

const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;
const num = (n: number, d = 0) => n.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
const when = (t: number) => new Date(t).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";

export default async function TokenPage() {
  const c = tokenConfig();
  if (!tokenLive(c)) notFound();
  const s = await readToken(c).catch(() => null);
  const link = (path: string, label: string) =>
    c.explorer ? (
      <a href={`${c.explorer}/${path}`} target="_blank" rel="noopener noreferrer">
        {label}
      </a>
    ) : (
      label
    );

  return (
    <div className="page">
      <div className="container">
        <PageHeader
          eyebrow={c.symbol}
          title="Bought back and burned, every half hour"
          lead={`Every trade of ${c.symbol} pays a small fee. Part of it goes to the burn pot, a contract that at most every 30 minutes spends what it holds on ${c.symbol} and burns all of it with the token's own burn, so the supply only goes down. Nobody runs it by hand.`}
        />

        <section className="page-section" aria-labelledby="ca-title">
          <h2 id="ca-title" className="section-title">
            The contract
          </h2>
          <CodeBlock code={c.token!} label={`${c.symbol} contract address`} />
          <p className="small">
            {link(`address/${c.token}`, "The token on the explorer")} · {link(`address/${c.pot}`, "The burn pot on the explorer")}
            {c.tradeUrl ? (
              <>
                {" "}
                ·{" "}
                <a href={c.tradeUrl} target="_blank" rel="noopener noreferrer">
                  Where it trades
                </a>
              </>
            ) : null}
          </p>
        </section>

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
                <dd className="stat-text">{c.symbol} gone for good, read from the pot.</dd>
              </div>
              <div className="stat">
                <dt className="stat-label">Supply left</dt>
                <dd className="stat-value">
                  <span className="stat-number">{num(s.supplyLeft)}</span>
                </dd>
                <dd className="stat-text">The token&apos;s own total supply, right now.</dd>
              </div>
              <div className="stat">
                <dt className="stat-label">Burns</dt>
                <dd className="stat-value">
                  <span className="stat-number">{num(s.burnCount)}</span>
                </dd>
                <dd className="stat-text">{s.lastBurnAt ? `The last one ${when(s.lastBurnAt)}.` : "The first one comes half an hour after the first fees."}</dd>
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
                      <td>{b.n}</td>
                      <td>{when(b.at)}</td>
                      <td>{num(b.eth, 4)} ETH</td>
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
            <p className="small">No burn yet. The first one comes half an hour after the first trading fees reach the pot.</p>
          )}
        </section>

        <p className="faint small">
          {c.symbol} can lose all of its value. Holding it gives no claim on Sigil, its income or anything else, and no share of anything. Trade it at your own risk.
        </p>
      </div>
    </div>
  );
}
