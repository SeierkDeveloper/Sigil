// The roadmap's stages: what is not built yet, and for a stage in progress what
// of it is already live. Everything built is in the changelog.

export type Horizon = "built" | "now" | "next" | "later" | "vision";

export interface Stage {
  title: string;
  summary: string;
  horizon: Horizon;
  /** What of this stage is already live; shown first, with a filled mark. */
  built?: string[];
  items: string[];
  /** For a stage whose every part is live: the day it was completed. */
  done?: string;
}

export const HORIZON_LABEL: Record<Horizon, string> = { built: "Built", now: "In progress", next: "Next", later: "Later", vision: "Vision" };

export const stages: Stage[] = [
  {
    title: "Ask your whole life",
    horizon: "now",
    built: ["Ask: one question answered from every folder at once, every sentence linked to the memories it came from (live 24 Nov)"],
    summary: "Your whole life within reach of one question: the people, projects and places in it, a brief before every meeting, and all of it on your own machine.",
    items: [
      "Living timelines of the people, projects and places in your life, built and kept current by the vault",
      "A brief before every meeting and decision: what was promised, what changed, what was left open",
      "A fully local mode: a model on your own machine, so nothing leaves it, not even to a model provider",
      "Unlock in under two seconds with a vault of 100,000 memories: headers first, bodies decrypted as you read",
    ],
  },
  {
    title: "A model of you",
    horizon: "built",
    done: "25 Nov",
    summary: "A model of you, learned on your device from only the folders you allow, that writes, ranks and decides the way you do.",
    built: [
      "Lessons in plain words from the folders you choose: how you write, what matters most to you and your limits, each linked to the memories it came from (live 25 Nov)",
      "A small model trained on your device from your own choices, its weights encrypted in your vault and moved with it",
      "Remove any lesson, or roll the whole model back to a date",
      "A score for how well it knows you, measured on choices it did not train on",
      "One model of you for every app: Claude, ChatGPT and Cursor read the same lessons through the connector",
    ],
    items: [],
  },
  {
    title: "A self that acts",
    horizon: "built",
    done: "27 Nov",
    summary: "Your AI self moves from drafts to actions, inside limits you set and can see at all times.",
    built: [
      "Limits for acting on payments to listed recipients within the wallet's caps, replies to contacts you list and meetings in your free hours, with everything past a limit waiting in Work",
      "A receipt for everything it does on its own, signed by its key and sealed with the hour, checked on the verify page",
      "Its wallet run from the vault, where you register, create, fund, set the rules on chain, freeze and withdraw from your own wallet, with the registry of selves live on chain",
      "Runs your inbox and calendar end to end, with thresholds for whom it answers, what about, how many a day, how long a meeting may be and what it never touches",
      "Negotiates times, prices and terms within ranges you set, and stops to ask at the edge of them with the whole thread and what it would say next",
      "AI apps with their own mail or calendar access ask it first through the connector: allowed, waiting for you, or refused, with a signed receipt for what they did",
    ],
    items: [],
  },
  {
    title: "Proofs that show nothing",
    horizon: "later",
    summary: "Zero-knowledge proofs, so you can prove a fact about your life to anyone without showing the life behind it.",
    items: [
      "Age, membership, history length and any field of a memory, proved without revealing the value",
      "Proof of a real, continuous human from years of sealed history, with no biometrics and no document scan",
      "Apps ask a question and receive a proof as the answer, never the data",
      "Privacy scores shared between owners as proofs, so you learn how an app behaves without anyone sharing a log",
    ],
  },
  {
    title: "The network of selves",
    horizon: "later",
    summary: "AI selves find each other for work, teams and deals, and nobody has to expose a vault to be found.",
    items: [
      "Private matching: two selves learn what they have in common, and nothing else, before either owner is asked",
      "A reputation built only from sealed agreements kept and broken, portable to any node",
      "Rooms where many selves meet at once, end to end encrypted, with every owner holding the transcript",
      "Introductions your self makes for you, ranked by fit, sent only with your yes",
    ],
  },
  {
    title: "Recovery and inheritance",
    horizon: "later",
    summary: "You never lose your vault, and the people you choose never lose you.",
    items: [
      "Recovery through people you trust: any three of five bring your vault back, none of them can open it alone",
      "Your legacy self speaks in your voice and style to the people you chose, from what you left for them",
      "Time capsules: memories and messages that open on a date, an age or an event you define",
      "A last instruction set: what is deleted, what is kept, what is passed on, carried out by the network",
    ],
  },
  {
    title: "Memory for organisations",
    horizon: "later",
    summary: "The same keys and seals for companies and their fleets of agents.",
    items: [
      "A company memory with roles, where every read by a person or an agent is sealed",
      "Agent fleets that share one memory, with handoffs, budgets and a full audit trail",
      "Requests to see or delete a person's data answered from the vault in one step, with a sealed receipt",
    ],
  },
  {
    title: "Everywhere you are",
    horizon: "vision",
    summary: "Sigil in every device you carry and every place you live, without a central server in the middle.",
    items: [
      "Native apps for phones, computers and watches, syncing directly between your own devices",
      "Glasses and wearables that capture hands-free into the inbox, sealed on the device",
      "Car and home: your self knows where you are going and what the house needs, within the rules you set",
    ],
  },
  {
    title: "A network nobody can switch off",
    horizon: "vision",
    summary: "Your sealed data kept by many independent nodes, so Sigil outlives any company, including ours.",
    items: [
      "Nodes keep encrypted, erasure-coded copies of each other's vaults, so losing any node loses nothing",
      "Proofs that every copy is still held, checked by the network every hour",
      "The protocol governed by the people who run nodes and the people who use them",
    ],
  },
  {
    title: "The memory economy",
    horizon: "vision",
    summary: "What you know and what your self can do become things you can offer, on your terms.",
    items: [
      "Licensed knowledge packs and paid sessions with expert selves, priced by their owners",
      "Your data offered at your price, for a purpose you approve, revoked when you say",
      "Sigil's own memory model, trained only on what people chose to share",
      "The network token, paid for network fees and burned on use",
    ],
  },
];
