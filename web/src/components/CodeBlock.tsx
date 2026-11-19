"use client";

import { useState } from "react";
import { CheckIcon, CopyIcon } from "./icons";

export function CodeBlock({ code, label, language }: { code: string; label?: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };
  return (
    <figure className="code-block" data-language={language}>
      {label ? <figcaption className="code-block-label">{label}</figcaption> : null}
      <pre className="code-block-pre">
        <code>{code}</code>
      </pre>
      <button type="button" className="code-block-copy" onClick={copy} aria-label={copied ? "Copied" : "Copy to clipboard"}>
        {copied ? <CheckIcon /> : <CopyIcon />}
        <span>{copied ? "Copied" : "Copy"}</span>
      </button>
    </figure>
  );
}
