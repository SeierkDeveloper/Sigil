"use client";

// The page behind an emergency card's code. The card's key is in the part of
// the address after #, which browsers never send to a server: the server hands
// out ciphertext and this page opens it. Once opened here, the ciphertext is
// kept on this device, so the card opens again without a signal; the key stays
// only in the link. A card its owner took down is forgotten here as soon as
// the page reaches the site again.

import { useEffect, useState, useSyncExternalStore } from "react";
import { cardKeyFromFragment, openCard, type EmergencyCard } from "@sigil/core";
import { EmergencyIcon, PhoneIcon } from "@/components/icons";
import { formatDate } from "@/lib/format";

type Phase =
  | { kind: "loading" }
  | { kind: "broken"; message: string }
  | { kind: "open"; card: EmergencyCard; offline: boolean };

const subscribe = () => () => undefined;
const CACHE = (id: string) => `sigil-emergency:${id}`;

function cached(id: string): string | null {
  try {
    return window.localStorage.getItem(CACHE(id));
  } catch {
    return null;
  }
}

function keep(id: string, envelope: string | null): void {
  try {
    if (envelope) window.localStorage.setItem(CACHE(id), envelope);
    else window.localStorage.removeItem(CACHE(id));
  } catch {
    // Storage may be off in this browser; the card still opens online.
  }
}

export function EmergencyApp({ cardId }: { cardId: string }) {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash, () => null);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });

  useEffect(() => {
    if (hash === null) return;
    let alive = true;
    const key = cardKeyFromFragment(hash);
    const show = (p: Phase) => alive && setPhase(p);
    if (!key || !/^[A-Za-z0-9_-]{8,64}$/.test(cardId)) {
      show({ kind: "broken", message: "This link is not complete. Scan the code again, or copy the whole link." });
      return;
    }
    const open = async (envelope: string, offline: boolean) => {
      try {
        show({ kind: "open", card: await openCard(key, cardId, envelope), offline });
      } catch {
        show({ kind: "broken", message: "This card does not open with the key in this link. The code may be an old one." });
      }
    };
    fetch(`/api/e/${cardId}`, { cache: "no-store" })
      .then(async (res) => {
        if (res.status === 404) {
          keep(cardId, null);
          show({ kind: "broken", message: "Its owner took this card down or issued a new code." });
          return;
        }
        if (!res.ok) throw new Error(String(res.status));
        const { card } = (await res.json()) as { card: string };
        keep(cardId, card);
        await open(card, false);
      })
      .catch(async () => {
        const copy = cached(cardId);
        if (copy) await open(copy, true);
        else show({ kind: "broken", message: "The card could not be loaded. Check the connection and try again." });
      });
    return () => {
      alive = false;
    };
  }, [hash, cardId]);

  return (
    <div className="page emergency-page">
      <div className="container container-narrow">
        <section className="emergency-sheet" data-state={phase.kind} data-testid="emergency-sheet" aria-live="polite">
          <header className="emergency-head">
            <span className="emergency-mark" aria-hidden="true">
              <EmergencyIcon />
            </span>
            <div>
              <p className="emergency-kicker">Emergency information</p>
              <h1 className="emergency-name">{phase.kind === "open" ? phase.card.name || "Medical card" : "Medical card"}</h1>
            </div>
          </header>
          {phase.kind === "loading" ? <p className="emergency-line">Opening the card on this device.</p> : null}
          {phase.kind === "broken" ? <p className="emergency-line" role="alert">{phase.message}</p> : null}
          {phase.kind === "open" ? <Card card={phase.card} offline={phase.offline} /> : null}
        </section>
      </div>
    </div>
  );
}

function Card({ card, offline }: { card: EmergencyCard; offline: boolean }) {
  const rows: [string, string][] = [
    ["Allergies", card.allergies],
    ["Medication", card.medication],
    ["Conditions", card.conditions],
    ["Languages", card.language],
    ["Other notes", card.notes],
  ];
  return (
    <>
      {card.bloodType ? (
        <div className="emergency-blood">
          <span className="emergency-label">Blood type</span>
          <span className="emergency-blood-value" data-testid="emergency-blood">
            {card.bloodType}
          </span>
        </div>
      ) : null}
      <dl className="emergency-facts">
        {rows
          .filter(([, v]) => v)
          .map(([label, value]) => (
            <div key={label} className="emergency-fact" data-field={label.toLowerCase()}>
              <dt className="emergency-label">{label}</dt>
              <dd className="emergency-value">{value}</dd>
            </div>
          ))}
      </dl>
      {card.contacts.length ? (
        <div className="emergency-contacts">
          <p className="emergency-label">Who to call</p>
          <ul>
            {card.contacts.map((c, i) => (
              <li key={i}>
                {c.phone ? (
                  <a className="emergency-call" href={`tel:${c.phone.replace(/[^0-9+]/g, "")}`}>
                    <PhoneIcon />
                    <span className="emergency-call-who">
                      {c.name || "Call"}
                      {c.relation ? `, ${c.relation}` : ""}
                    </span>
                    <span className="emergency-call-number">{c.phone}</span>
                  </a>
                ) : (
                  <p className="emergency-value">
                    {c.name}
                    {c.relation ? `, ${c.relation}` : ""}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p className="small faint emergency-fine">
        {offline ? "Shown from the copy kept on this device, without a connection. " : ""}
        Updated {formatDate(card.updatedAt)}. Opened in this browser with the key in the link; the site stores only an encrypted copy and records that it was opened.
      </p>
    </>
  );
}
