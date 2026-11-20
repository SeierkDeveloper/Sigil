"use client";

import { useState } from "react";
import { encode } from "uqr";
import { BLOOD_TYPES, cleanCard, EMPTY_CARD, type EmergencyCard, type EmergencyContact } from "@sigil/core";
import { EmergencyIcon, ImportIcon } from "@/components/icons";
import { formatDateTime } from "@/lib/format";
import * as em from "../emergencyOps";
import { Qr } from "../Qr";
import { errorText, useVault } from "../context";
import { Band, CopyButton, Empty, Notice, PlateHead, Quiet } from "../ui";

const DEVICE_WORD: Record<string, string> = { phone: "A phone", tablet: "A tablet", computer: "A computer", unknown: "A device" };

/** Emergency access: a medical card for the lock screen, readable by whoever scans it and by nobody else, the server included. */
export function EmergencyTab() {
  const { data } = useVault();
  const [card, setCard] = useState<EmergencyCard>(data.emergency.card?.card ?? { ...EMPTY_CARD });
  return (
    <div className="emergency">
      <div className="panel-header">
        <h2 className="panel-title">Emergency</h2>
        <p className="small muted">
          A card with what a helper needs to know, made from the health memories you pick and changed by you before it goes out. It opens from a code on your lock screen.
          The card is encrypted on this device with a key that is only in the code&apos;s link, so Sigil stores it and cannot read it. You see each time it is opened, and you
          can take it down or issue a new code at any time.
        </p>
      </div>
      <SourcesSection onFill={setCard} current={card} />
      <CardSection card={card} setCard={setCard} />
      <CodeSection />
      <OpensSection />
    </div>
  );
}

function SourcesSection({ onFill, current }: { onFill(c: EmergencyCard): void; current: EmergencyCard }) {
  const { data } = useVault();
  const offered = em.healthMemories(data).slice(0, 60);
  const [picked, setPicked] = useState<Set<string>>(new Set(offered.filter((x) => x.health).map((x) => x.memory.id)));
  return (
    <section className="subpanel plate emergency-sources" aria-labelledby="em-sources-title">
      <PlateHead number="01" id="em-sources-title" title="From your memories" lead="Lines like Blood type: A+, Allergies: ..., Medication: ..., Conditions: ..., Language: ... and Emergency contact: name, relation, phone are read on this device." />
      {offered.length === 0 ? (
        <Quiet>No memories yet. You can fill the card by hand below.</Quiet>
      ) : (
        <fieldset className="checkbox-list">
          <legend className="visually-hidden">Memories to read</legend>
          {offered.map(({ memory, health }) => (
            <label key={memory.id} className="checkbox" htmlFor={`em-${memory.id}`}>
              <input
                id={`em-${memory.id}`}
                type="checkbox"
                checked={picked.has(memory.id)}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.target.checked) next.add(memory.id);
                  else next.delete(memory.id);
                  setPicked(next);
                }}
              />
              <span>
                {memory.title}
                {health ? <span className="faint"> (health)</span> : null}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <div className="form-actions">
        <button type="button" className="button" disabled={picked.size === 0} onClick={() => onFill(em.draftFrom(offered.filter((x) => picked.has(x.memory.id)).map((x) => x.memory), current))}>
          Fill the card from these
        </button>
      </div>
    </section>
  );
}

function CardSection({ card, setCard }: { card: EmergencyCard; setCard(c: EmergencyCard): void }) {
  const { api, vault, data, update } = useVault();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const published = data.emergency.card;
  const set = (patch: Partial<EmergencyCard>) => setCard({ ...card, ...patch });
  const setContact = (i: number, patch: Partial<EmergencyContact>) => set({ contacts: card.contacts.map((c, j) => (j === i ? { ...c, ...patch } : c)) });

  const run = async (name: string, reissue: boolean) => {
    setBusy(name);
    setError(null);
    setSaved(null);
    try {
      const view = await em.publishCard(api, vault, data.emergency, cleanCard(card), reissue);
      update((d) => ({ ...d, emergency: view }));
      setSaved(reissue ? "A new code was issued. The old one opens nothing now." : published ? "The card was changed. The code stays the same." : "Published. Set the code below as your lock screen.");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <form className="subpanel plate emergency-card-form" aria-label="Emergency card" onSubmit={(e) => (e.preventDefault(), void run("publish", false))}>
      <PlateHead number="02" id="em-card-title" title="The card" lead="Only what is on this card can be seen by whoever scans the code.">
        <span className="plate-state" data-on={published ? "true" : "false"}>
          {published ? "Published" : "Not published"}
        </span>
      </PlateHead>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {saved ? <Notice kind="success">{saved}</Notice> : null}
      <Band label="You">
        <div className="grid grid-2">
          <div className="field">
            <label className="field-label" htmlFor="em-name">
              Name
            </label>
            <input id="em-name" className="input" value={card.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="em-blood">
              Blood type
            </label>
            <select id="em-blood" className="select" value={card.bloodType} onChange={(e) => set({ bloodType: e.target.value })}>
              <option value="">Not given</option>
              {BLOOD_TYPES.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="em-language">
            Languages
          </label>
          <input id="em-language" className="input" value={card.language} maxLength={120} onChange={(e) => set({ language: e.target.value })} />
        </div>
      </Band>
      <Band label="Health">
        <div className="field">
          <label className="field-label" htmlFor="em-allergies">
            Allergies
          </label>
          <textarea id="em-allergies" className="textarea" rows={2} value={card.allergies} onChange={(e) => set({ allergies: e.target.value })} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="em-medication">
            Medication
          </label>
          <textarea id="em-medication" className="textarea" rows={2} value={card.medication} onChange={(e) => set({ medication: e.target.value })} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="em-conditions">
            Conditions
          </label>
          <textarea id="em-conditions" className="textarea" rows={2} value={card.conditions} onChange={(e) => set({ conditions: e.target.value })} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="em-notes">
            Other notes
          </label>
          <textarea id="em-notes" className="textarea" rows={2} value={card.notes} onChange={(e) => set({ notes: e.target.value })} />
        </div>
      </Band>
      <Band label="Who to call" hint="Up to four people.">
        {card.contacts.map((c, i) => (
          <div key={i} className="rules-row rules-row-wide">
            <span className="rules-cell" data-label="Name">
              <input aria-label={`Contact ${i + 1} name`} className="input" value={c.name} placeholder="Name" onChange={(e) => setContact(i, { name: e.target.value })} />
            </span>
            <span className="rules-cell" data-label="Relation">
              <input aria-label={`Contact ${i + 1} relation`} className="input" value={c.relation} placeholder="Relation" onChange={(e) => setContact(i, { relation: e.target.value })} />
            </span>
            <span className="rules-cell" data-label="Phone">
              <input aria-label={`Contact ${i + 1} phone`} className="input" type="tel" value={c.phone} placeholder="Phone" onChange={(e) => setContact(i, { phone: e.target.value })} />
            </span>
            <button type="button" className="button button-small button-ghost" onClick={() => set({ contacts: card.contacts.filter((_, j) => j !== i) })}>
              Remove
            </button>
          </div>
        ))}
        {card.contacts.length < 4 ? (
          <button type="button" className="button button-small" onClick={() => set({ contacts: [...card.contacts, { name: "", relation: "", phone: "" }] })}>
            Add a person
          </button>
        ) : null}
      </Band>
      <div className="form-actions">
        <button type="submit" className="button button-primary" disabled={!!busy}>
          {busy === "publish" ? "Encrypting" : published ? "Save changes" : "Publish the card"}
        </button>
        {published ? (
          <>
            <button type="button" className="button" disabled={!!busy} onClick={() => void run("reissue", true)}>
              {busy === "reissue" ? "Issuing" : "Issue a new code"}
            </button>
            <button
              type="button"
              className="button button-danger"
              disabled={!!busy}
              onClick={async () => {
                setBusy("revoke");
                setError(null);
                try {
                  const view = await em.revokeCard(api, data.emergency);
                  update((d) => ({ ...d, emergency: view }));
                  setSaved("Taken down. The code opens nothing now.");
                } catch (err) {
                  setError(errorText(err));
                } finally {
                  setBusy(null);
                }
              }}
            >
              Take it down
            </button>
          </>
        ) : null}
      </div>
    </form>
  );
}

/** A phone wallpaper with the code, drawn on this device. The card's key is in the code; nothing is uploaded. */
function wallpaper(link: string, card: EmergencyCard, printFacts: boolean): string {
  const W = 1170;
  const H = 2532;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  g.fillStyle = "#050506";
  g.fillRect(0, 0, W, H);
  const qr = encode(link, { ecc: "M", border: 0 });
  const plate = 640;
  const cell = Math.floor((plate - 80) / qr.size);
  const side = cell * qr.size + 80;
  const x0 = Math.round((W - side) / 2);
  const y0 = 1180;
  g.fillStyle = "#ffffff";
  g.fillRect(x0, y0, side, side);
  g.fillStyle = "#050506";
  qr.data.forEach((row, y) => row.forEach((on, x) => on && g.fillRect(x0 + 40 + x * cell, y0 + 40 + y * cell, cell, cell)));
  g.fillStyle = "#ffffff";
  g.textAlign = "center";
  g.font = "600 64px sans-serif";
  g.fillText("Emergency information", W / 2, y0 - 150);
  g.font = "400 44px sans-serif";
  g.fillStyle = "#c8c8c8";
  g.fillText("Scan with the camera to open", W / 2, y0 - 80);
  if (printFacts) {
    g.fillStyle = "#ffffff";
    g.font = "500 48px sans-serif";
    const lines = [card.bloodType ? `Blood type ${card.bloodType}` : "", card.allergies ? `Allergies: ${card.allergies.split("\n").join(", ")}` : ""].filter(Boolean);
    lines.forEach((l, i) => g.fillText(l.slice(0, 44), W / 2, y0 + side + 110 + i * 70));
  }
  return c.toDataURL("image/png");
}

function CodeSection() {
  const { data } = useVault();
  const [print, setPrint] = useState(false);
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const link = em.emergencyLink(origin, data.emergency);
  return (
    <section className="subpanel plate emergency-code" aria-labelledby="em-code-title">
      <PlateHead number="03" id="em-code-title" title="For your lock screen" lead="The code opens the card in any browser. Anyone who can see your lock screen can open it, which is the point." />
      {!link || !data.emergency.card ? (
        <Empty icon={<EmergencyIcon />} title="Nothing published">
          Publish the card above to get its code.
        </Empty>
      ) : (
        <div className="emergency-code-layout">
          <div className="pair-qr">
            <Qr text={link} label="Code that opens your emergency card" />
          </div>
          <div>
            <div className="certificate-link">
              <code className="mono small" data-testid="emergency-link">
                {link}
              </code>
              <CopyButton text={link} />
            </div>
            <label className="checkbox suggest-toggle" htmlFor="em-print">
              <input id="em-print" type="checkbox" checked={print} onChange={(e) => setPrint(e.target.checked)} />
              <span>
                Also print the blood type and allergies on the image
                <span className="field-hint">Then they show on the lock screen without scanning, to anyone.</span>
              </span>
            </label>
            <div className="row">
              <button
                type="button"
                className="button"
                onClick={() => {
                  const a = document.createElement("a");
                  a.href = wallpaper(link, data.emergency.card!.card, print);
                  a.download = "emergency-lock-screen.png";
                  document.body.appendChild(a);
                  a.click();
                  a.remove();
                }}
              >
                <ImportIcon /> Save the lock screen image
              </button>
              <a className="button button-ghost" href={link} target="_blank" rel="noreferrer">
                Open the card
              </a>
            </div>
            <p className="small faint">Opening it yourself shows up below like any other opening.</p>
          </div>
        </div>
      )}
    </section>
  );
}

function OpensSection() {
  const { api, data, update } = useVault();
  const [busy, setBusy] = useState(false);
  const opens = data.emergency.opens;
  return (
    <section className="subpanel plate emergency-opens" aria-labelledby="em-opens-title">
      <PlateHead number="04" id="em-opens-title" title="Openings" lead="When the card was opened, on what kind of device and in what language. Nothing that tells who it was is kept.">
        <button
          type="button"
          className="button button-small"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const next = await em.refreshOpens(api);
              update((d) => ({ ...d, emergency: { ...d.emergency, opens: next } }));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Checking" : "Check again"}
        </button>
      </PlateHead>
      {opens.length === 0 ? (
        <Quiet>Not opened yet.</Quiet>
      ) : (
        <ul className="list">
          {opens.map((o, i) => (
            <li key={`${o.at}-${i}`} className="list-row" data-testid="emergency-open">
              <div className="list-row-main">
                <p className="list-row-title">
                  {DEVICE_WORD[o.device] ?? "A device"}
                  {o.lang ? `, language ${o.lang}` : ""}
                </p>
                <p className="list-row-meta">
                  {formatDateTime(o.at)}
                  {data.emergency.card && o.cardId !== data.emergency.card.id ? ". An earlier code." : ""}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
