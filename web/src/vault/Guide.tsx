"use client";

import { useEffect, useRef, useState } from "react";
import { dedupeDrafts, parseExport, type AppKind, type GuideStep } from "@sigil/core";
import { CodeBlock } from "@/components/CodeBlock";
import { claudeCodeCommand, configLocations, mcpConfig, shellCommand } from "@/lib/connector";
import { plural } from "@/lib/format";
import { site } from "@/lib/site";
import * as ops from "./ops";
import { chatApps, currentStep, saveGuide, stepStates, type StepState } from "./guideOps";
import { errorText, useVault } from "./context";
import { CopyButton, Notice } from "./ui";

const STEPS: { id: GuideStep; title: string }[] = [
  { id: "phrase", title: "Save your recovery phrase" },
  { id: "import", title: "Bring in your ChatGPT or Claude history" },
  { id: "connect", title: "Connect one AI app" },
  { id: "answer", title: "Get the first answer from your memory" },
];

const CLIENTS: { kind: AppKind; label: string; note: string }[] = [
  { kind: "claude-desktop", label: "Claude Desktop", note: "The easiest to start with: one file to paste into." },
  { kind: "claude-code", label: "Claude Code", note: "One command in a terminal." },
  { kind: "cursor", label: "Cursor", note: "One file to paste into." },
  { kind: "chatgpt", label: "ChatGPT", note: "Needs the connector reachable over HTTPS: more setup." },
];

/**
 * The first five minutes: a short guide above the vault's sections, from the
 * recovery phrase to the first answer an AI app draws from this vault. Each
 * step can be skipped; where the owner is comes from the vault itself and an
 * encrypted note, so the guide resumes on any device until it is finished or
 * closed.
 */
export function Guide() {
  const { api, vault, data, update, goTo } = useVault();
  const states = stepStates(data);
  const current = currentStep(states);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<{ appKey: string; kind: AppKind } | null>(null);
  const done = STEPS.filter((s) => states[s.id] !== "todo").length;
  const shown: GuideStep | null = made ? "connect" : current;

  const change = async (fn: (g: NonNullable<typeof data.guide>) => NonNullable<typeof data.guide>) => {
    if (!data.guide) return;
    try {
      const next = await saveGuide(api, vault, fn(data.guide));
      update((d) => ({ ...d, guide: next }));
    } catch (err) {
      setError(errorText(err));
    }
  };
  const skip = (step: GuideStep) => void change((g) => ({ ...g, skipped: [...new Set([...g.skipped, step])] }));
  const close = () => void change((g) => ({ ...g, dismissed: true }));

  return (
    <section className="guide subpanel plate" aria-labelledby="guide-title" data-testid="guide">
      <header className="guide-head">
        <div>
          <h2 id="guide-title" className="guide-title">
            {current ? "Getting started" : "You are set up"}
          </h2>
          <p className="small muted">
            {current
              ? `Step ${Math.min(done + 1, STEPS.length)} of ${STEPS.length}. About five minutes. Your progress is kept, so you can stop and come back.`
              : "Your vault is ready, and an AI app can draw on it. Everything else is under More."}
          </p>
        </div>
        <button type="button" className="button button-small button-ghost" onClick={close}>
          {current ? "Skip the guide" : "Close"}
        </button>
      </header>
      <div className="guide-progress" role="progressbar" aria-valuemin={0} aria-valuemax={STEPS.length} aria-valuenow={done} aria-label="Steps done">
        <span style={{ width: `${(done / STEPS.length) * 100}%` }} />
      </div>
      {error ? <Notice kind="error">{error}</Notice> : null}
      <ol className="guide-steps-list">
        {STEPS.map((s, i) => (
          <li key={s.id} className="guide-step" data-state={states[s.id]} data-current={shown === s.id ? "true" : "false"} data-testid={`guide-step-${s.id}`}>
            <p className="guide-step-title">
              <span className="guide-step-mark" aria-hidden="true">
                {states[s.id] === "done" ? "Done" : states[s.id] === "skipped" ? "Skipped" : String(i + 1)}
              </span>
              {s.title}
              <span className="visually-hidden"> ({label(states[s.id])})</span>
            </p>
            {shown === s.id ? (
              <div className="guide-step-body">
                {s.id === "phrase" ? <PhraseStep onSkip={() => skip("phrase")} onSettings={() => goTo("settings")} /> : null}
                {s.id === "import" ? <ImportStep onSkip={() => skip("import")} /> : null}
                {s.id === "connect" ? <ConnectStep made={made} onMade={setMade} onNext={() => setMade(null)} onSkip={() => skip("connect")} /> : null}
                {s.id === "answer" ? <AnswerStep onSkip={() => skip("answer")} onAnswered={(appId, at) => void change((g) => ({ ...g, appId, answeredAt: at }))} /> : null}
              </div>
            ) : null}
          </li>
        ))}
      </ol>
    </section>
  );
}

function label(s: StepState): string {
  return s === "done" ? "done" : s === "skipped" ? "skipped" : "to do";
}

function PhraseStep({ onSkip, onSettings }: { onSkip(): void; onSettings(): void }) {
  return (
    <>
      <p className="small">
        Your 24-word recovery phrase is the only way back in if you lose this device and its passkey. If you did not write it down, make a new one now: the old one stops
        working.
      </p>
      <div className="row">
        <button type="button" className="button button-small button-primary" onClick={onSettings}>
          Make a new phrase in Settings
        </button>
        <button type="button" className="button button-small button-ghost" onClick={onSkip}>
          I have it
        </button>
      </div>
    </>
  );
}

function ImportStep({ onSkip }: { onSkip(): void }) {
  const { api, vault, data, update } = useVault();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const read = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setBusy(`Reading ${file.name}`);
    try {
      const r = parseExport(file.name, new Uint8Array(await file.arrayBuffer()));
      const name = r.source === "chatgpt" ? "ChatGPT" : "Claude";
      const { fresh } = dedupeDrafts(r.drafts, data.memories);
      if (fresh.length === 0) throw new Error("There was nothing new in this file. Try the export file itself (the .zip), or skip this step.");
      const { folder, created } = await ops.findOrCreateFolder(api, vault, data.folders, name);
      if (created) update((d) => ({ ...d, folders: [...d.folders, folder] }));
      const saved = await ops.importDrafts(api, folder, fresh, (n, total) => setBusy(`Encrypting and saving ${n} of ${total}`));
      update((d) => ({ ...d, memories: [...saved, ...d.memories] }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
      if (input.current) input.current.value = "";
    }
  };

  return (
    <>
      <p className="small">Your past conversations become memories your AI apps can draw on. The file is opened and encrypted here, in this browser.</p>
      <ol className="small guide-howto">
        <li>
          <strong>ChatGPT:</strong> Settings, Data controls, Export data. A link to a .zip file arrives by email.
        </li>
        <li>
          <strong>Claude:</strong> Settings, Privacy, Export data. A link to a .zip file arrives by email.
        </li>
        <li>Choose that .zip file below. You do not need to unpack it.</li>
      </ol>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {busy ? (
        <p className="small" role="status">
          {busy}
        </p>
      ) : null}
      <div className="row">
        <label className="button button-small button-primary">
          Choose the export file
          <input ref={input} type="file" accept=".zip,.json,application/zip,application/json" className="visually-hidden" onChange={(e) => void read(e.target.files?.[0])} disabled={!!busy} data-testid="guide-import-file" />
        </label>
        <button type="button" className="button button-small button-ghost" onClick={onSkip} disabled={!!busy}>
          Skip for now
        </button>
      </div>
      <p className="small muted">Waiting for the email? Skip this step and come back: the guide keeps your place. Notes, mail and more are under More, Import.</p>
    </>
  );
}

function ConnectStep({ made, onMade, onNext, onSkip }: { made: { appKey: string; kind: AppKind } | null; onMade(m: { appKey: string; kind: AppKind }): void; onNext(): void; onSkip(): void }) {
  const { api, vault, data, reload } = useVault();
  const [kind, setKind] = useState<AppKind>("claude-desktop");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const origin = typeof window !== "undefined" ? window.location.origin : site.url;
  const client = CLIENTS.find((c) => c.kind === (made?.kind ?? kind))!;

  const make = async () => {
    setBusy(true);
    setError(null);
    try {
      // Every folder that is not protected; the owner narrows it under Apps at any time.
      const folders = data.folders.filter((f) => !f.protect);
      const r = await ops.connectApp(api, vault, { name: client.label, kind }, folders, { canPropose: true, boxPublic: data.boxPublic });
      onMade({ appKey: r.appKey, kind });
      await reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (made) {
    return (
      <>
        <p className="small">
          This key lets {client.label} read the folders you have now and suggest memories to your inbox. It is shown once: copy it now.
        </p>
        <div className="app-key" data-testid="guide-app-key">
          {made.appKey}
        </div>
        <div className="row">
          <CopyButton text={made.appKey} label="Copy the key" className="button button-small" />
        </div>
        {!site.connectorPublished ? <p className="small muted">The connector is not on npm yet: build it once from the repository and put its path in place of /path/to/Sigil (see the docs).</p> : null}
        {made.kind === "claude-desktop" || made.kind === "cursor" ? (
          <>
            <ol className="small guide-howto">
              <li>{configLocations[made.kind].where[0]}</li>
              {configLocations[made.kind].where.slice(1).map((w) => (
                <li key={w}>{w}</li>
              ))}
              <li>Paste this in (or add the &quot;sigil&quot; part to the servers already there), save, and quit and reopen {client.label}.</li>
            </ol>
            <CodeBlock code={mcpConfig(made.appKey, origin)} label={made.kind === "cursor" ? "mcp.json" : "claude_desktop_config.json"} language="json" />
          </>
        ) : made.kind === "claude-code" ? (
          <>
            <p className="small">Run this once in a terminal. It adds Sigil to Claude Code for every project.</p>
            <CodeBlock code={claudeCodeCommand(made.appKey, origin)} label="Terminal" />
          </>
        ) : (
          <>
            <p className="small">
              ChatGPT talks to connectors over the internet, so the connector runs in HTTP mode on your computer behind an HTTPS tunnel, and you add its address in ChatGPT as a
              custom connector. The steps are in the docs, under ChatGPT. If you have Claude Desktop, it is the quicker first try.
            </p>
            <CodeBlock code={shellCommand(made.appKey, origin, true)} label="Terminal" />
          </>
        )}
        <div className="row">
          <button type="button" className="button button-small button-primary" onClick={onNext}>
            I added it: next step
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <p className="small">Pick the app you use most. Sigil makes a key for it, and shows exactly where to paste it.</p>
      <div className="guide-clients" role="radiogroup" aria-label="AI app">
        {CLIENTS.map((c) => (
          <label key={c.kind} className="guide-client" data-selected={c.kind === kind ? "true" : "false"}>
            <input type="radio" name="guide-client" value={c.kind} checked={c.kind === kind} onChange={() => setKind(c.kind)} disabled={busy} />
            <span className="guide-client-name">{c.label}</span>
            <span className="small muted">{c.note}</span>
          </label>
        ))}
      </div>
      {error ? <Notice kind="error">{error}</Notice> : null}
      <div className="row">
        <button type="button" className="button button-small button-primary" onClick={() => void make()} disabled={busy}>
          {busy ? "Making the key" : `Make a key for ${client.label}`}
        </button>
        <button type="button" className="button button-small button-ghost" onClick={onSkip} disabled={busy}>
          Skip for now
        </button>
      </div>
    </>
  );
}

const READS = new Set(["read", "index", "folders", "protected"]);

function AnswerStep({ onSkip, onAnswered }: { onSkip(): void; onAnswered(appId: string, at: string): void }) {
  const { api, data } = useVault();
  const apps = chatApps(data);
  const [checked, setChecked] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const example = data.memories.find((m) => m.source.kind === "chatgpt" || m.source.kind === "claude") ?? data.memories[0];
  const appName = apps[0]?.name ?? "your AI app";
  const ids = apps.map((a) => a.id).join(",");
  const answeredRef = useRef(onAnswered);
  useEffect(() => {
    answeredRef.current = onAnswered;
  });

  // Looks in the read log for the app's first read, now and every few seconds, while this step is open.
  useEffect(() => {
    const wanted = new Set(ids.split(",").filter(Boolean));
    let alive = true;
    const look = async () => {
      try {
        const log = await ops.loadLog(api, 100);
        const hit = log.entries.find((e) => wanted.has(e.appId) && READS.has(e.kind));
        if (hit && alive) answeredRef.current(hit.appId, hit.at);
        if (alive) setError(null);
      } catch (err) {
        if (alive) setError(errorText(err));
      }
      if (alive) setChecked((n) => n + 1);
    };
    void look();
    const timer = window.setInterval(() => void look(), 4000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [api, ids]);

  return (
    <>
      <p className="small">
        In {appName}, ask something only your memories know. For example:
      </p>
      <CodeBlock code={example ? `Search my Sigil memories for "${example.title.slice(0, 60)}" and tell me what I said.` : "What do my Sigil memories say about me?"} label="Ask your AI app" />
      <p className="small muted" role="status">
        {apps.length === 0
          ? "Connect an app first, in the step above."
          : `Waiting for ${appName} to read from your vault. This step finishes by itself when it does${checked > 1 ? " (still looking)" : ""}.`}
      </p>
      <p className="small muted">
        Nothing yet? Quit and reopen the app after pasting the key, and check that the key was copied in full. Every read shows up under More, Read log.
      </p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      <div className="row">
        <button type="button" className="button button-small button-ghost" onClick={onSkip}>
          Skip for now
        </button>
      </div>
      <p className="visually-hidden">{plural(apps.length, "app")} connected.</p>
    </>
  );
}
