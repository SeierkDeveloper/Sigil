"use client";

import { Fragment, useState } from "react";
import { CheckIcon, CopyIcon } from "@/components/icons";

export function Spinner({ label }: { label: string }) {
  return (
    <div className="loading" role="status">
      <span className="spinner" aria-hidden="true" /> {label}
    </div>
  );
}

export function Notice({ kind = "info", children }: { kind?: "info" | "error" | "success"; children: React.ReactNode }) {
  return (
    <div className={`notice ${kind === "info" ? "" : `notice-${kind}`}`} role={kind === "error" ? "alert" : "status"}>
      <div>{children}</div>
    </div>
  );
}

export function Empty({ icon, title, children, action }: { icon?: React.ReactNode; title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="empty-state">
      {icon ? <span className="empty-state-icon">{icon}</span> : null}
      <p className="empty-state-title">{title}</p>
      {children ? <p className="empty-state-text">{children}</p> : null}
      {action}
    </div>
  );
}

/** A vault fingerprint in its groups of four, set to be read aloud and compared. */
export function Fingerprint({ value, className = "" }: { value: string; className?: string }) {
  return (
    <span className={`fingerprint mono ${className}`.trim()}>
      {value.split(" ").map((group, i) => (
        <Fragment key={i}>
          {i ? " " : null}
          <span className="fingerprint-group">{group}</span>
        </Fragment>
      ))}
    </span>
  );
}

export function CopyButton({ text, label = "Copy", className = "button button-small", onCopied }: { text: string; label?: string; className?: string; onCopied?: () => void }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          onCopied?.();
          setTimeout(() => setDone(false), 1600);
        } catch {
          setDone(false);
        }
      }}
    >
      {done ? <CheckIcon /> : <CopyIcon />} {done ? "Copied" : label}
    </button>
  );
}

export function download(filename: string, content: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The head of one numbered plate in a tab: its number, its title, one line under it and, on the right, its state. */
export function PlateHead({ number, id, title, lead, children }: { number: string; id?: string; title: string; lead?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <header className="plate-head">
      <span className="plate-number" aria-hidden="true">
        {number}
      </span>
      <div className="plate-heading">
        <h3 id={id} className="plate-title">
          {title}
        </h3>
        {lead ? <p className="plate-lead">{lead}</p> : null}
      </div>
      {children ? <div className="plate-aside">{children}</div> : null}
    </header>
  );
}

/** One band of a long form: what the fields are about on the left, the fields on the right. */
export function Band({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="band">
      <div className="band-side">
        <p className="band-label">{label}</p>
        {hint ? <p className="band-hint">{hint}</p> : null}
      </div>
      <div className="band-main">{children}</div>
    </div>
  );
}

/** Nothing here yet, said in one line inside a plate. */
export function Quiet({ children }: { children: React.ReactNode }) {
  return <p className="quiet">{children}</p>;
}
