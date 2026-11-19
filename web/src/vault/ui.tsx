"use client";

import { useState } from "react";
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
