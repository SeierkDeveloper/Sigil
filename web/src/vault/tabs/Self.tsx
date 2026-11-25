"use client";

import { useEffect, useMemo, useState } from "react";
import {
  cleanRules,
  DEFAULT_MODELS,
  DEFAULT_RULES,
  maskKey,
  PROVIDER_NAMES,
  RAETO_MODELS,
  splitList,
  type ModelProvider,
  type SelfAnswer,
  type SelfRules,
} from "@sigil/core";
import { formatDate, formatDateTime, plural } from "@/lib/format";
import * as selfOps from "../selfOps";
import * as holderOps from "../holderOps";
import type { AskLinkView } from "../ops";
import { errorText, useVault } from "../context";
import { reportCaught } from "../immuneOps";
import { ChatGptIcon, ClaudeIcon, DeviceIcon, RaetoIcon } from "@/components/icons";
import { AppMark } from "../marks";
import { Band, CopyButton, Empty, Notice, PlateHead, Quiet } from "../ui";
import { PublicSelfSection } from "./PublicSelf";
import { SessionsSection } from "./Sessions";
import { approveHere, guardedMemories } from "../protectOps";
import { retrieve, sealSetting } from "@sigil/core";
import { VoiceControls } from "@/voice/VoiceControls";

const STATE_WORD: Record<ReturnType<typeof useVault>["agent"]["state"], string> = {
  serving: "Answering",
  "no-model": "No key",
  failed: "Stopped",
  off: "At rest",
};

/** Your AI self: the model key, the rules, a test chat, the apps that may answer as it, and links. */
export function SelfTab() {
  const { data, agent } = useVault();
  return (
    <div className="self">
      <div className="panel-header">
        <h2 className="panel-title">Your AI self</h2>
        <p className="small muted">
          An AI that answers as you, from the folders you choose and within rules you write. It runs in this browser, or in the connector on your machine, and calls
          your own model with your own key. Sigil&apos;s server never sees your memories, your rules or your key.
        </p>
      </div>
      <p className="self-status" data-state={agent.state}>
        <span className="self-status-lamp" aria-hidden="true" />
        <span className="self-status-word">{STATE_WORD[agent.state]}</span>
        <span className="self-status-line">{agentLine(agent, data.model !== null)}</span>
      </p>
      <ModelSection />
      <RulesSection />
      <TestChat />
      <AppsSection />
      <LinksSection />
      <PublicSelfSection />
      <SessionsSection />
    </div>
  );
}

function agentLine(agent: ReturnType<typeof useVault>["agent"], hasModel: boolean): string {
  switch (agent.state) {
    case "serving":
      return `This vault is answering your links while it is open${agent.answered ? `: ${plural(agent.answered, "question")} so far` : ""}.`;
    case "no-model":
      return "You have links this vault answers, but no model key yet. Until you add one, the links say your AI self is offline.";
    case "failed":
      return `Answering links stopped: ${agent.reason}`;
    default:
      return hasModel ? "No link is waiting for this vault to answer." : "Start with your model key, then write the rules.";
  }
}

// ---------------------------------------------------------------- model

function ModelSection() {
  const { api, vault, data, update } = useVault();
  const [editing, setEditing] = useState(!data.model);
  const [provider, setProvider] = useState<ModelProvider>(data.model?.provider ?? "anthropic");
  const [model, setModel] = useState(data.model?.model ?? DEFAULT_MODELS.anthropic);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const settings = { provider, model: model.trim() || DEFAULT_MODELS[provider], apiKey: key.trim() };
      if (!settings.apiKey) throw new Error("Paste your key.");
      await selfOps.saveModel(api, vault, settings);
      const next = { ...data, model: settings };
      update((d) => ({ ...d, model: settings }));
      const n = await selfOps.refreshAppSelf(api, vault, next);
      setKey("");
      setEditing(false);
      setNote(n ? `Saved. ${plural(n, "app")} that answer as your AI self now use it.` : "Saved.");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await selfOps.saveModel(api, vault, null);
      update((d) => ({ ...d, model: null }));
      setEditing(true);
      setNote("Removed. Apps that answer as your AI self keep the old key until you turn them off.");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="subpanel plate" aria-labelledby="self-model">
      <PlateHead number="01" id="self-model" title="Model" lead="The model that writes the answers, called with your own key.">
        <span className="plate-state" data-on={data.model ? "true" : "false"}>
          {data.model ? "Key saved" : "No key yet"}
        </span>
      </PlateHead>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {note ? <Notice kind="success">{note}</Notice> : null}
      {data.model && !editing ? (
        <>
          <div className="self-model">
            <span className="mark" aria-hidden="true">
              {data.model.provider === "openai" ? <ChatGptIcon /> : data.model.provider === "raeto" ? <RaetoIcon /> : <ClaudeIcon />}
            </span>
            <p className="self-model-line">
              {PROVIDER_NAMES[data.model.provider]}, <span className="mono">{data.model.model}</span>, key <span className="mono">{maskKey(data.model.apiKey)}</span>
            </p>
            <div className="self-model-actions">
              <button type="button" className="button button-small" onClick={() => setEditing(true)}>
                Change
              </button>
              <button type="button" className="button button-small button-ghost" onClick={() => void remove()} disabled={busy}>
                Remove
              </button>
            </div>
          </div>
          <p className="device-line">
            <DeviceIcon />
            <span>Encrypted in this browser with your vault key. Answers are requested straight from the provider and billed to this key.</span>
          </p>
        </>
      ) : (
        <form onSubmit={save} aria-label="Model key">
          <div className="grid grid-2">
            <div className="field">
              <label className="field-label" htmlFor="self-provider">
                Provider
              </label>
              <select
                id="self-provider"
                className="select"
                value={provider}
                onChange={(e) => {
                  const p = e.target.value as ModelProvider;
                  setProvider(p);
                  setModel(DEFAULT_MODELS[p]);
                }}
              >
                <option value="anthropic">Anthropic</option>
                <option value="openai">OpenAI</option>
                <option value="raeto">Raeto (400+ models, one key)</option>
              </select>
            </div>
            <div className="field">
              <label className="field-label" htmlFor="self-model-id">
                Model
              </label>
              <input
                id="self-model-id"
                className="input mono"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                list={provider === "raeto" ? "self-raeto-models" : undefined}
              />
              {provider === "raeto" ? (
                <datalist id="self-raeto-models">
                  {RAETO_MODELS.map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              ) : null}
            </div>
          </div>
          {provider === "raeto" ? (
            <p className="device-line" data-testid="raeto-note">
              <RaetoIcon />
              <span>
                Raeto gives one key for 400+ models. <span className="mono">raeto/auto</span> picks the cheapest model that can write each answer, and every
                answer shows which model wrote it and what it cost. Get a key and top it up with USDG or a card at{" "}
                <a href="https://raeto.cc" target="_blank" rel="noopener noreferrer">
                  raeto.cc
                </a>
                .
              </span>
            </p>
          ) : null}
          <div className="field">
            <label className="field-label" htmlFor="self-key">
              API key
            </label>
            <input id="self-key" className="input mono" type="password" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" spellCheck={false} />
            <span className="field-hint">
              Encrypted in this browser with your vault key before it is saved. Answers are requested from this browser (or the connector, for apps you allow)
              straight from the provider, and are billed to this key.
            </span>
          </div>
          <div className="form-actions">
            <button type="submit" className="button button-primary" disabled={busy || !key.trim()}>
              {busy ? "Saving" : "Save key"}
            </button>
            {data.model ? (
              <button type="button" className="button button-ghost" onClick={() => setEditing(false)} disabled={busy}>
                Cancel
              </button>
            ) : null}
          </div>
        </form>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- rules

interface RulesDraft {
  name: string;
  folderIds: Set<string>;
  allowTopics: string;
  denyTopics: string;
  neverSay: string;
  tone: string;
  unknown: SelfRules["unknown"];
  unknownText: string;
  maxSources: number;
}

const toDraft = (r: SelfRules): RulesDraft => ({
  name: r.name,
  folderIds: new Set(r.folderIds),
  allowTopics: r.allowTopics.join(", "),
  denyTopics: r.denyTopics.join(", "),
  neverSay: r.neverSay.join("\n"),
  tone: r.tone,
  unknown: r.unknown,
  unknownText: r.unknownText,
  maxSources: r.maxSources,
});

const fromDraft = (d: RulesDraft): SelfRules =>
  cleanRules({
    name: d.name,
    folderIds: [...d.folderIds],
    allowTopics: splitList(d.allowTopics),
    denyTopics: splitList(d.denyTopics),
    neverSay: splitList(d.neverSay),
    tone: d.tone,
    unknown: d.unknown,
    unknownText: d.unknownText,
    maxSources: d.maxSources,
  });

function FolderChoice({ id, selected, onChange, legend }: { id: string; selected: Set<string>; onChange(next: Set<string>): void; legend: string }) {
  const { data } = useVault();
  return (
    <fieldset className="checkbox-list">
      <legend className="visually-hidden">{legend}</legend>
      {data.folders.map((f) => (
        <label key={f.id} className="checkbox" htmlFor={`${id}-${f.id}`}>
          <input
            id={`${id}-${f.id}`}
            type="checkbox"
            checked={selected.has(f.id)}
            onChange={(e) => {
              const next = new Set(selected);
              if (e.target.checked) next.add(f.id);
              else next.delete(f.id);
              onChange(next);
            }}
          />
          <span>{f.name}</span>
        </label>
      ))}
    </fieldset>
  );
}

function RulesSection() {
  const { api, vault, data, update } = useVault();
  const [draft, setDraft] = useState<RulesDraft>(() => toDraft(data.self ?? DEFAULT_RULES));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const set = <K extends keyof RulesDraft>(k: K, v: RulesDraft[K]) => {
    setSaved(null);
    setDraft((d) => ({ ...d, [k]: v }));
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const rules = await selfOps.saveRules(api, vault, fromDraft(draft));
      update((d) => ({ ...d, self: rules }));
      const n = await selfOps.refreshAppSelf(api, vault, { ...data, self: rules });
      setSaved(n ? `Rules saved. ${plural(n, "app")} that answer as your AI self now follow them.` : "Rules saved.");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="subpanel plate self-rules" onSubmit={save} aria-label="Rules">
      <PlateHead number="02" title="Rules" lead="They apply to the test chat below and to apps that answer as you. Each link keeps its own copy, set when you make it.">
        <span className="plate-state" data-on={data.self ? "true" : "false"}>
          {data.self ? "Saved" : "Not saved yet"}
        </span>
      </PlateHead>
      {error ? <Notice kind="error">{error}</Notice> : null}
      {saved ? <Notice kind="success">{saved}</Notice> : null}
      <Band label="Who it is" hint="The name it answers under and how it sounds.">
        <div className="field">
          <label className="field-label" htmlFor="rule-name">
            Name it uses
          </label>
          <input id="rule-name" className="input" value={draft.name} maxLength={80} onChange={(e) => set("name", e.target.value)} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="rule-tone">
            Tone
          </label>
          <input id="rule-tone" className="input" value={draft.tone} maxLength={600} onChange={(e) => set("tone", e.target.value)} />
        </div>
      </Band>
      <Band label="What it may read" hint="Nothing outside these folders is ever given to the model.">
        <div className="field">
          <span className="field-label">Folders it may use</span>
          <FolderChoice id="rule-folder" legend="Folders it may use" selected={draft.folderIds} onChange={(v) => set("folderIds", v)} />
          <span className="field-hint">With the Self card folder, it also knows your Self card.</span>
        </div>
        <div className="field field-short">
          <label className="field-label" htmlFor="rule-sources">
            Memories it may read per answer
          </label>
          <input id="rule-sources" className="input" type="number" min={1} max={12} value={draft.maxSources} onChange={(e) => set("maxSources", Number(e.target.value) || 1)} />
        </div>
      </Band>
      <Band label="What it may say" hint="Checked on your device, before your model is asked and before anyone sees an answer.">
        <div className="grid grid-2">
          <div className="field">
            <label className="field-label" htmlFor="rule-allow">
              Topics it may talk about
            </label>
            <textarea id="rule-allow" className="textarea" rows={3} value={draft.allowTopics} onChange={(e) => set("allowTopics", e.target.value)} />
            <span className="field-hint">Separated by commas. Leave empty for any topic not listed next to it.</span>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="rule-deny">
              Topics it never talks about
            </label>
            <textarea id="rule-deny" className="textarea" rows={3} value={draft.denyTopics} onChange={(e) => set("denyTopics", e.target.value)} />
            <span className="field-hint">A question about one of these is refused before your model is asked.</span>
          </div>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="rule-never">
            Things it must never say
          </label>
          <textarea id="rule-never" className="textarea" rows={3} value={draft.neverSay} onChange={(e) => set("neverSay", e.target.value)} />
          <span className="field-hint">One per line. An answer that contains one is replaced by a refusal on the device, before anyone sees it.</span>
        </div>
      </Band>
      <Band label="When it does not know" hint="What it answers when its folders hold nothing on the question.">
        <div className="grid grid-2">
          <div className="field">
            <label className="field-label" htmlFor="rule-unknown">
              When it does not know
            </label>
            <select id="rule-unknown" className="select" value={draft.unknown} onChange={(e) => set("unknown", e.target.value as SelfRules["unknown"])}>
              <option value="say">It says so</option>
              <option value="redirect">It says where to ask instead</option>
            </select>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="rule-unknown-text">
              What it says then
            </label>
            <input
              id="rule-unknown-text"
              className="input"
              value={draft.unknownText}
              maxLength={400}
              onChange={(e) => set("unknownText", e.target.value)}
              placeholder={draft.unknown === "redirect" ? "I don't know. Ask me directly by email." : undefined}
            />
          </div>
        </div>
      </Band>
      <div className="form-actions plate-actions">
        <button type="submit" className="button button-primary" disabled={busy}>
          {busy ? "Saving" : "Save rules"}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- test chat

interface Turn {
  question: string;
  answer: SelfAnswer;
}

const REFUSED: Record<string, string> = {
  denied_topic: "Refused: a topic it never talks about",
  off_topic: "Refused: outside the topics it may talk about",
  never_say: "Withheld: the answer contained something it must never say",
  unknown: "Nothing in its folders answers this",
};

function TestChat() {
  const { api, vault, data, semantic, openMemory, update } = useVault();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The owner's own key, or a holder's included answers.
  const ready = (!!data.model || holderOps.includedAvailable(data)) && !!data.self && data.self.folderIds.length > 0;

  const [gate, setGate] = useState<{ question: string; folders: { id: string; name: string; ids: string[] }[] } | null>(null);

  const run = async (text: string, open: Set<string>) => {
    const model = holderOps.answerCaller(data, api);
    if (!model || !data.self) return;
    setBusy(true);
    setError(null);
    try {
      const answer = await selfOps.askInVault(
        data,
        data.self,
        model,
        text,
        turns.map((t) => ({ question: t.question, answer: t.answer.text })),
        { embedQuery: semantic.embedQuery, vectors: semantic.vectors },
        open,
      );
      if (answer.caught) reportCaught(api, "self", answer.caught.held + answer.caught.neutralised);
      setTurns((t) => [...t, { question: text.trim(), answer }]);
      setQuestion("");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const ask = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!data.self || !question.trim()) return;
    // A protected folder in the rules: ask here first, for this one answer.
    const guarded = data.folders.filter((f) => f.protect && data.self!.folderIds.includes(f.id));
    if (guarded.length) {
      const pool = guardedMemories(data, new Set(guarded.map((f) => f.id)));
      const hits = retrieve({ ...data.self, folderIds: guarded.map((f) => f.id) }, pool, question);
      const folders = guarded
        .map((f) => ({ id: f.id, name: f.name, ids: hits.filter((h) => pool.find((m) => m.id === h.id)?.folderId === f.id).map((h) => h.id) }))
        .filter((f) => f.ids.length);
      if (folders.length) {
        setGate({ question, folders });
        return;
      }
    }
    await run(question, new Set());
  };

  const decide = async (allow: boolean) => {
    if (!gate) return;
    const g = gate;
    setGate(null);
    if (!allow) return run(g.question, new Set());
    try {
      for (const f of g.folders) {
        const req = await approveHere(api, f.id, f.ids);
        await api.post(`access/${req.id}/use`, { memoryIds: f.ids });
      }
    } catch (err) {
      setError(errorText(err));
      return;
    }
    await run(g.question, new Set(g.folders.map((f) => f.id)));
  };

  return (
    <section className="subpanel plate self-chat" aria-labelledby="self-chat">
      <PlateHead
        number="03"
        id="self-chat"
        title="Test chat"
        lead="Ask what others would ask. It answers exactly as it would for them, and shows you the memories it used. Nothing here is logged or sent to Sigil."
      />
      {!ready ? (
        <Notice>{!data.model ? "Add your model key above to try it." : "Save rules with at least one folder to try it."}</Notice>
      ) : (
        <>
          {turns.length || busy ? (
            <ol className="chat" aria-label="Conversation">
              {turns.map((t, i) => (
                <li key={i} className="chat-turn" data-testid="chat-turn">
                  <p className="chat-question">{t.question}</p>
                  <div className="chat-answer" data-refused={t.answer.refused ? "true" : "false"}>
                    <p className="chat-by">
                      <span className="chat-by-name">{data.self?.name || "Your AI self"}</span>
                    </p>
                    <p>{t.answer.text}</p>
                    {t.answer.refused ? <p className="chat-refused">{REFUSED[t.answer.refused] ?? "Declined"}</p> : null}
                    {t.answer.citations.length ? (
                      <p className="chat-sources">
                        <span className="chat-sources-label">Used</span>
                        {t.answer.citations.map((c, j) => (
                          <span key={c.id} className="chat-source">
                            <span className="chat-source-n">[{j + 1}]</span>{" "}
                            <button type="button" className="text-button" onClick={() => openMemory(c.id)}>
                              {c.title}
                            </button>{" "}
                            <span className="faint">({c.folder})</span>
                          </span>
                        ))}
                      </p>
                    ) : null}
                  </div>
                </li>
              ))}
              {busy ? (
                <li className="chat-turn" data-status="waiting">
                  <p className="chat-question">{question.trim()}</p>
                  <div className="chat-answer">
                    <p className="chat-by">
                      <span className="chat-by-name">{data.self?.name || "Your AI self"}</span>
                    </p>
                    <p className="faint chat-waiting">
                      <span className="spinner" aria-hidden="true" /> Thinking
                    </p>
                  </div>
                </li>
              ) : null}
            </ol>
          ) : (
            <Quiet>Nothing asked yet. Try a question someone else would ask.</Quiet>
          )}
          {error ? <Notice kind="error">{error}</Notice> : null}
          {gate ? (
            <div className="subpanel protect-gate" data-testid="protect-gate">
              <p className="small">
                This answer could use{" "}
                {gate.folders.map((f, i) => (
                  <span key={f.id}>
                    {i ? " and " : ""}
                    {plural(f.ids.length, "memory", "memories")} from {f.name}
                  </span>
                ))}
                , a protected folder. Allow it for this one answer? The read goes into your read log.
              </p>
              <div className="row">
                <button type="button" className="button button-small button-primary" onClick={() => void decide(true)}>
                  Allow for this answer
                </button>
                <button type="button" className="button button-small button-ghost" onClick={() => void decide(false)}>
                  Answer without it
                </button>
              </div>
            </div>
          ) : null}
          <VoiceControls
            label="Test chat voice"
            startOn={data.voiceOn}
            onText={(text) => setQuestion(text)}
            answer={turns.length ? { id: String(turns.length), text: turns[turns.length - 1].answer.text } : null}
            onSwitch={(on) => {
              if (on === data.voiceOn) return;
              update((d) => ({ ...d, voiceOn: on }));
              void sealSetting(vault.key, "voice", { on })
                .then((value) => api.put("settings/voice", { value }))
                .catch(() => undefined);
            }}
          />
          <form className="chat-form" onSubmit={ask} aria-label="Ask your AI self">
            <label className="visually-hidden" htmlFor="chat-question">
              Question
            </label>
            <textarea
              id="chat-question"
              className="textarea"
              rows={2}
              value={question}
              maxLength={2000}
              placeholder="What would you like to ask?"
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <div className="form-actions">
              <span className="chat-keys" aria-hidden="true">
                Enter to ask, Shift and Enter for a new line
              </span>
              <button type="submit" className="button button-primary" disabled={busy || !question.trim()}>
                {busy ? "Thinking" : "Ask"}
              </button>
              {turns.length ? (
                <button type="button" className="button button-ghost" onClick={() => setTurns([])} disabled={busy}>
                  Start over
                </button>
              ) : null}
            </div>
          </form>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- apps

function AppsSection() {
  const { api, vault, data, update, goTo } = useVault();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const apps = data.apps.filter((a) => !a.revokedAt && a.kind !== "extension" && a.kind !== "web");

  const toggle = async (id: string, on: boolean) => {
    const app = data.apps.find((a) => a.id === id)!;
    setBusy(id);
    setError(null);
    try {
      await selfOps.setAppSelf(api, vault, data, app, on);
      update((d) => ({ ...d, apps: d.apps.map((a) => (a.id === id ? { ...a, canAskSelf: on } : a)) }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="subpanel plate" aria-labelledby="self-apps">
      <PlateHead
        number="04"
        id="self-apps"
        title="Apps that answer as you"
        lead={
          <>
            An app you allow can use the <span className="mono">ask_self</span> tool in its connector, and answer the links you give it while the connector runs with{" "}
            <span className="mono">--self</span>. Your rules and model key are encrypted for that app&apos;s key only. It reads memories through its own folders, so a
            folder must be both in the rules and given to the app.
          </>
        }
      />
      {error ? <Notice kind="error">{error}</Notice> : null}
      {apps.length === 0 ? (
        <Quiet>
          No connector app yet.{" "}
          <button type="button" className="text-button" onClick={() => goTo("apps")}>
            Connect one under Apps
          </button>
          .
        </Quiet>
      ) : (
        <ul className="list self-apps">
          {apps.map((a) => (
            <li key={a.id} className="list-row" data-on={a.canAskSelf ? "true" : "false"}>
              <AppMark kind={a.kind} />
              <div className="list-row-main">
                <p className="list-row-title">{a.name}</p>
                <p className="list-row-meta">{a.canAskSelf ? "May answer as your AI self." : "Does not answer as your AI self."}</p>
              </div>
              <label className="checkbox suggest-toggle" htmlFor={`self-app-${a.id}`}>
                <input
                  id={`self-app-${a.id}`}
                  type="checkbox"
                  checked={a.canAskSelf}
                  disabled={busy === a.id || (!a.canAskSelf && (!data.model || !data.self))}
                  onChange={(e) => void toggle(a.id, e.target.checked)}
                />
                <span>May answer as your AI self</span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- links

function linkState(l: AskLinkView): { label: string; active: boolean } {
  if (l.revokedAt) return { label: "Turned off", active: false };
  if (new Date(l.expiresAt).getTime() <= Date.now()) return { label: "Expired", active: false };
  if (l.uses >= l.maxUses) return { label: "Used up", active: false };
  return { label: "Active", active: true };
}

function LinksSection() {
  const { api, vault, data, update, agent } = useVault();
  const [creating, setCreating] = useState(false);
  const [made, setMade] = useState<{ id: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const appName = useMemo(() => new Map(data.apps.map((a) => [a.id, a.name])), [data.apps]);

  // Stats change as people ask; refresh them while this tab is open.
  useEffect(() => {
    if (!data.askLinks.length) return;
    let alive = true;
    const t = window.setInterval(() => {
      void selfOps
        .refreshLinks(api, data)
        .then((links) => alive && update((d) => ({ ...d, askLinks: links })))
        .catch(() => undefined);
    }, 10_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [api, data, update]);

  const act = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="subpanel plate self-links" aria-labelledby="self-links">
      <PlateHead
        number="05"
        id="self-links"
        title="Ask links"
        lead={
          <>
            Anyone with a link can ask your AI self questions within that link&apos;s rules, until it expires or runs out. Questions and answers travel end to end
            encrypted between their browser and the place that answers: this vault while it is open, or the connector of an app you choose. When neither is running,
            the link says your AI self is offline. Every question and answer is written, sealed, to your read log.
          </>
        }
      >
        {!creating ? (
          <button type="button" className="button button-small" onClick={() => setCreating(true)} disabled={!data.self}>
            New link
          </button>
        ) : null}
      </PlateHead>
      {!data.self ? <Notice>Save your rules first. A new link starts from them.</Notice> : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
      {creating && data.self ? (
        <NewLinkForm
          onCancel={() => setCreating(false)}
          onCreate={async (input) => {
            const { link, url } = await selfOps.createLink(api, vault, data, input, origin);
            update((d) => ({ ...d, askLinks: [link, ...d.askLinks] }));
            setMade({ id: link.id, url });
            setCreating(false);
          }}
        />
      ) : null}
      {made ? (
        <div className="app-key-panel link-made" data-testid="link-made">
          <p className="panel-title">Your link is ready</p>
          <p className="app-key mono" data-testid="ask-url">
            {made.url.includes("#") ? (
              <>
                <span className="link-made-address">{made.url.slice(0, made.url.indexOf("#"))}</span>
                <span className="link-made-key">{made.url.slice(made.url.indexOf("#"))}</span>
              </>
            ) : (
              made.url
            )}
          </p>
          <p className="small muted">The part after # holds the key that protects the conversation. Browsers never send it to the server, so share the whole link.</p>
          <div className="row">
            <CopyButton text={made.url} label="Copy link" />
            <button type="button" className="button button-small button-ghost" onClick={() => setMade(null)}>
              Done
            </button>
          </div>
        </div>
      ) : null}
      {data.askLinks.length === 0 ? (
        !creating && data.self ? <Empty title="No links yet">Make one to let someone ask your AI self.</Empty> : null
      ) : (
        <ul className="link-list">
          {data.askLinks.map((l) => {
            const st = linkState(l);
            const url = selfOps.linkUrl(origin, l);
            const answeredBy = l.appId ? `${appName.get(l.appId) ?? "A removed app"}, through its connector` : "This vault, while it is open";
            const here = !l.appId && st.active && agent.state === "serving";
            return (
              <li key={l.id} className="link-row" data-state={st.active ? "active" : "inactive"} data-online={st.active && (l.online || here) ? "true" : "false"} data-testid="link-row">
                <div className="link-row-head">
                  <span className="link-row-lamp" aria-hidden="true" />
                  <p className="link-row-title">{l.label}</p>
                  <span className="badge">{st.label}</span>
                  {st.active ? <span className={l.online || here ? "chip chip-strong" : "chip"}>{l.online || here ? "Online" : "Offline"}</span> : null}
                </div>
                <div className="link-meter" aria-hidden="true">
                  <span style={{ width: `${Math.min(100, Math.round((l.uses / Math.max(1, l.maxUses)) * 100))}%` }} />
                </div>
                <dl className="link-facts">
                  <div>
                    <dt>Asked</dt>
                    <dd>
                      {l.uses} of {l.maxUses} times
                    </dd>
                  </div>
                  <div>
                    <dt>Answered</dt>
                    <dd>{plural(l.answered, "answer")}</dd>
                  </div>
                  <div>
                    <dt>Pace</dt>
                    <dd>Up to {l.perHour} an hour</dd>
                  </div>
                  <div>
                    <dt>{st.label === "Expired" ? "Expired" : "Expires"}</dt>
                    <dd>{formatDate(l.expiresAt)}</dd>
                  </div>
                  <div>
                    <dt>Last asked</dt>
                    <dd>{l.lastAskedAt ? formatDateTime(l.lastAskedAt) : "Not yet"}</dd>
                  </div>
                  <div>
                    <dt>Answered by</dt>
                    <dd>{answeredBy}</dd>
                  </div>
                  {l.secret ? (
                    <div>
                      <dt>Folders</dt>
                      <dd>{selfFolders(data, l.secret.rules)}</dd>
                    </div>
                  ) : null}
                  {l.secret && cleanRules(l.secret.rules).denyTopics.length ? (
                    <div>
                      <dt>Never</dt>
                      <dd>{cleanRules(l.secret.rules).denyTopics.join(", ")}</dd>
                    </div>
                  ) : null}
                </dl>
                <div className="link-row-actions">
                  {st.active && url ? <CopyButton text={url} label="Copy link" /> : null}
                  {confirm === l.id ? (
                    <>
                      <button
                        type="button"
                        className="button button-small button-danger"
                        disabled={busy === l.id}
                        onClick={() =>
                          void act(l.id, async () => {
                            if (st.active) {
                              await selfOps.revokeLink(api, l.id);
                              update((d) => ({ ...d, askLinks: d.askLinks.map((x) => (x.id === l.id ? { ...x, revokedAt: new Date().toISOString(), online: false } : x)) }));
                            } else {
                              await selfOps.deleteLink(api, l.id);
                              update((d) => ({ ...d, askLinks: d.askLinks.filter((x) => x.id !== l.id) }));
                            }
                            setConfirm(null);
                          })
                        }
                      >
                        {st.active ? "Turn off now" : "Delete for good"}
                      </button>
                      <button type="button" className="button button-small button-ghost" onClick={() => setConfirm(null)}>
                        Keep it
                      </button>
                    </>
                  ) : (
                    <button type="button" className="button button-small button-ghost" onClick={() => setConfirm(l.id)}>
                      {st.active ? "Turn off" : "Delete"}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function selfFolders(data: ReturnType<typeof useVault>["data"], rules: unknown): string {
  const ids = cleanRules(rules).folderIds;
  const names = data.folders.filter((f) => ids.includes(f.id)).map((f) => f.name);
  return names.length ? names.join(", ") : "none";
}

function NewLinkForm({ onCancel, onCreate }: { onCancel(): void; onCreate(input: selfOps.NewLinkInput): Promise<void> }) {
  const { data } = useVault();
  const base = data.self ?? DEFAULT_RULES;
  const [label, setLabel] = useState("");
  const [name, setName] = useState(base.name);
  const [greeting, setGreeting] = useState("");
  const [folders, setFolders] = useState<Set<string>>(new Set(base.folderIds));
  const [allow, setAllow] = useState(base.allowTopics.join(", "));
  const [deny, setDeny] = useState(base.denyTopics.join(", "));
  const [days, setDays] = useState(7);
  const [maxUses, setMaxUses] = useState(20);
  const [perHour, setPerHour] = useState(10);
  const answerers = data.apps.filter((a) => !a.revokedAt && a.canAskSelf);
  const [by, setBy] = useState<string>("vault");
  const [voice, setVoice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (!folders.size) throw new Error("Choose at least one folder this link may use.");
      await onCreate({
        label,
        name,
        greeting,
        rules: cleanRules({ ...base, name, folderIds: [...folders], allowTopics: splitList(allow), denyTopics: splitList(deny) }),
        expiresInDays: days,
        maxUses,
        perHour,
        appId: by === "vault" ? null : by,
        voice,
      });
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  return (
    <form className="subpanel new-link" onSubmit={submit} aria-label="New link">
      <p className="new-link-title">A new link</p>
      {error ? <Notice kind="error">{error}</Notice> : null}
      <Band label="What they see" hint="The page they open shows the name and the greeting.">
        <div className="grid grid-2">
          <div className="field">
            <label className="field-label" htmlFor="link-label">
              Label
            </label>
            <input id="link-label" className="input" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} placeholder="For the book club" />
            <span className="field-hint">Only you see it, in this list and in your read log.</span>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="link-name">
              Name they see
            </label>
            <input id="link-name" className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </div>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="link-greeting">
            Greeting
          </label>
          <input id="link-greeting" className="input" value={greeting} maxLength={400} onChange={(e) => setGreeting(e.target.value)} placeholder="Ask me about my reading." />
          <span className="field-hint">Shown on the page, encrypted with a key that only the link holds.</span>
        </div>
      </Band>
      <Band label="What it may use" hint="This link keeps its own copy of these rules.">
        <div className="field">
          <span className="field-label">Folders this link may use</span>
          <FolderChoice id="link-folder" legend="Folders this link may use" selected={folders} onChange={setFolders} />
        </div>
        <div className="grid grid-2">
          <div className="field">
            <label className="field-label" htmlFor="link-allow">
              Topics it may talk about
            </label>
            <input id="link-allow" className="input" value={allow} onChange={(e) => setAllow(e.target.value)} />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="link-deny">
              Topics it never talks about
            </label>
            <input id="link-deny" className="input" value={deny} onChange={(e) => setDeny(e.target.value)} />
          </div>
        </div>
      </Band>
      <Band label="Limits" hint="When the time or the total is reached, the link stops by itself.">
        <div className="grid grid-3 link-limits">
          <div className="field">
            <label className="field-label" htmlFor="link-days">
              Expires after
            </label>
            <select id="link-days" className="select" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              <option value={1}>1 day</option>
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
            </select>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="link-uses">
              Questions in all
            </label>
            <input id="link-uses" className="input" type="number" min={1} max={1000} value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value) || 1)} />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="link-hour">
              Questions an hour
            </label>
            <input id="link-hour" className="input" type="number" min={1} max={120} value={perHour} onChange={(e) => setPerHour(Number(e.target.value) || 1)} />
          </div>
        </div>
      </Band>
      <Band label="Who answers" hint="The link is online while that place is running.">
        <div className="field">
          <label className="field-label" htmlFor="link-by">
            Answered by
          </label>
          <select id="link-by" className="select" value={by} onChange={(e) => setBy(e.target.value)}>
            <option value="vault">This vault, while it is open</option>
            {answerers.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}, through its connector
              </option>
            ))}
          </select>
          <span className="field-hint">
            {by === "vault" ? "Keep this vault open in a tab for the link to be online." : "Run the connector with --self on your machine for the link to be online."}
          </span>
        </div>
        <label className="checkbox" htmlFor="link-voice">
          <input id="link-voice" type="checkbox" checked={voice} onChange={(e) => setVoice(e.target.checked)} />
          <span>
            Offer voice with this link
            <span className="field-hint">Whoever opens it can speak and hear answers; the speech model runs in their browser, only if they turn it on.</span>
          </span>
        </label>
      </Band>
      <div className="form-actions plate-actions">
        <button type="submit" className="button button-primary" disabled={busy}>
          {busy ? "Making the link" : "Make link"}
        </button>
        <button type="button" className="button button-ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
