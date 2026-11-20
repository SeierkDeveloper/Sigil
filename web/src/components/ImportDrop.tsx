"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { setPendingImport } from "@/lib/pendingImport";
import { ImportIcon } from "./icons";

/**
 * The drop zone on the Import page. The file is not read or sent here: it is
 * handed to the vault's own Import tab, which opens it once the vault is unlocked.
 */
export function ImportDrop() {
  const router = useRouter();
  const [dragging, setDragging] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const take = (file: File) => {
    if (!/\.(zip|json)$/i.test(file.name)) {
      setError("That is not an export file. Use the zip from ChatGPT or Claude, or the conversations.json inside it.");
      if (input.current) input.current.value = "";
      return;
    }
    setError(null);
    setName(file.name);
    setPendingImport(file);
    router.push("/vault#import");
  };

  return (
    <div className="import-drop">
      <label
        className="dropzone"
        data-dragging={dragging ? "true" : "false"}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const f = e.dataTransfer.files?.[0];
          if (f) take(f);
        }}
      >
        <ImportIcon className="empty-state-icon" />
        <span className="empty-state-title">{name ? `Opening your vault for ${name}` : "Drop your ChatGPT or Claude export here"}</span>
        <span className="empty-state-text">
          The zip file from the app&apos;s data export, or the conversations.json inside it. Your vault opens, and the file is read and encrypted
          there, in this browser.
        </span>
        <span className="button button-small">Choose a file</span>
        <input
          ref={input}
          type="file"
          accept=".zip,.json,application/zip,application/json"
          data-testid="import-drop-file"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) take(f);
          }}
        />
      </label>
      {error ? (
        <p className="notice notice-error" role="alert">
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
