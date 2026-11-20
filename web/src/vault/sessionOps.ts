// Sessions with the public AI self. The owner's side: the offer, and each
// booking with its intake opened by the public self's key and its transcript
// opened by the vault's key, on this device. The visitor's side: booking a
// time with an intake sealed in their browser, and the session's own relay,
// whose keys come from the secret in the session link.

import {
  askSessionFromPair,
  cleanIntake,
  cleanOffer,
  linkPair,
  newSessionSecret,
  openAskMessage,
  openIntake,
  openTurnNote,
  randomId,
  sealAskMessage,
  sealIntake,
  sessionAsker,
  sessionToken,
  sessionUrl,
  sha256Hex,
  encodeBoxPublicKey,
  type AskSession,
  type BoxKeyPair,
  type IntakeAnswers,
  type PublicReply,
  type SessionOffer,
  type SessionTurnNote,
  type Slot,
} from "@sigil/core";
import type { Api, Fetcher } from "./api";
import type { PublicSelfView } from "./publicOps";

// ---------------------------------------------------------------- the owner's side

export interface ServerBooking {
  id: string;
  topic: string;
  slotStart: string;
  slotEnd: string;
  turns: number;
  used: number;
  state: "booked" | "ended" | "blocked";
  createdAt: string;
  endedAt: string | null;
  intake: string;
  consent: string;
  transcript: { turn: number; note: string; at: string }[];
}

export interface ServerSessions {
  offer: SessionOffer | null;
  bookings: ServerBooking[];
}

export interface BookingView extends Omit<ServerBooking, "intake" | "transcript"> {
  /** The visitor's intake, opened with the public self's key. Null if it would not open. */
  intake: IntakeAnswers | null;
  transcript: (SessionTurnNote & { at: string })[];
}

export interface SessionsView {
  offer: SessionOffer | null;
  bookings: BookingView[];
}

export const NO_SESSIONS: SessionsView = { offer: null, bookings: [] };

export function openSessions(self: PublicSelfView | null, box: BoxKeyPair | null, server: ServerSessions | undefined): { sessions: SessionsView; unreadable: number } {
  if (!server) return { sessions: NO_SESSIONS, unreadable: 0 };
  let unreadable = 0;
  const pair = self?.secret ? linkPair({ secret: self.secret.secret, label: "", rules: null, introKey: "" }) : null;
  const bookings = server.bookings.map(({ intake, transcript, ...b }) => {
    let opened: IntakeAnswers | null = null;
    try {
      if (pair && self) opened = openIntake(pair, self.id, b.id, intake);
    } catch {
      unreadable++;
    }
    const turns: BookingView["transcript"] = [];
    for (const t of transcript) {
      try {
        if (box) turns.push({ ...openTurnNote(box, b.id, t.turn, t.note), at: t.at });
      } catch {
        unreadable++;
      }
    }
    return { ...b, intake: opened, transcript: turns };
  });
  return { sessions: { offer: server.offer ? cleanOffer(server.offer) : null, bookings }, unreadable };
}

export async function saveOffer(api: Api, offer: SessionOffer): Promise<SessionOffer> {
  return (await api.put<{ offer: SessionOffer }>("public/self/sessions", { offer: cleanOffer(offer) })).offer;
}

export async function endSession(api: Api, id: string, block: boolean): Promise<void> {
  await api.post(`sessions/${id}/${block ? "block" : "end"}`);
}

// ---------------------------------------------------------------- the visitor's side

export interface PublicOffer {
  selfId: string;
  handle: string;
  name: string;
  publicKey: string;
  voice: boolean;
  offer: SessionOffer | null;
  slots: Slot[];
}

async function call<T>(fetcher: Fetcher, method: string, url: string, body?: unknown, bearer?: string): Promise<T> {
  let res: Response;
  try {
    res = await fetcher(url, {
      method,
      credentials: "omit",
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error("Sigil could not be reached. Check your connection and try again.");
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string; code?: string };
  if (!res.ok) throw Object.assign(new Error(data.error ?? `The request failed (${res.status}).`), { code: data.code, status: res.status });
  return data;
}

const defaultFetch: Fetcher = (i, init) => fetch(i, init);

export async function loadOffer(handle: string, fetcher: Fetcher = defaultFetch, base = ""): Promise<PublicOffer> {
  return call<PublicOffer>(fetcher, "GET", `${base}/api/public/at/${encodeURIComponent(handle)}/sessions`);
}

export interface BookingDraft {
  slotStart: string;
  topic: string;
  name: string;
  answers: Record<string, string>;
}

/** Books a time: the intake is sealed here to the public self's key, and the session link carries the only key to the session. */
export async function bookSession(origin: string, offer: PublicOffer, draft: BookingDraft, fetcher: Fetcher = defaultFetch, base = ""): Promise<{ id: string; url: string; secret: string; slotStart: string; slotEnd: string }> {
  if (!offer.offer) throw new Error("This person is not taking sessions right now.");
  const intake = cleanIntake(offer.offer, { name: draft.name, topic: draft.topic, answers: draft.answers });
  const id = randomId();
  const secret = newSessionSecret();
  const asker = await sessionAsker(secret);
  const r = await call<{ id: string; slotStart: string; slotEnd: string }>(fetcher, "POST", `${base}/api/public/at/${encodeURIComponent(offer.handle)}/sessions`, {
    id,
    slotStart: draft.slotStart,
    topic: intake.topic,
    intake: sealIntake(offer.publicKey, offer.selfId, id, intake),
    tokenHash: sha256Hex(await sessionToken(secret)),
    askerKey: encodeBoxPublicKey(asker.publicKey),
  });
  return { ...r, url: sessionUrl(origin, id, secret), secret };
}

export interface SessionStatus {
  id: string;
  selfId: string;
  handle: string;
  name: string;
  publicKey: string;
  askerKey: string;
  topic: string;
  slotStart: string;
  slotEnd: string;
  turns: number;
  used: number;
  state: "booked" | "ended" | "blocked";
  houseRules: string;
  voice: boolean;
  online: boolean;
  problem: string | null;
}

/** A session opened from its link: the bearer and the relay key both come from the secret after #. */
export class SessionClient {
  private constructor(
    readonly bookingId: string,
    private readonly bearer: string,
    private readonly relay: AskSession,
    private readonly fetcher: Fetcher,
    private readonly base: string,
  ) {}

  static async open(bookingId: string, secret: string, fetcher: Fetcher = defaultFetch, base = ""): Promise<{ client: SessionClient; status: SessionStatus }> {
    const bearer = await sessionToken(secret);
    const status = await call<SessionStatus>(fetcher, "GET", `${base}/api/sessions/${bookingId}`, undefined, bearer);
    const asker = await sessionAsker(secret);
    if (encodeBoxPublicKey(asker.publicKey) !== status.askerKey) throw new Error("This session link does not match its session.");
    const relay = askSessionFromPair(status.selfId, status.publicKey, bookingId, asker);
    return { client: new SessionClient(bookingId, bearer, relay, fetcher, base), status };
  }

  status(): Promise<SessionStatus> {
    return call<SessionStatus>(this.fetcher, "GET", `${this.base}/api/sessions/${this.bookingId}`, undefined, this.bearer);
  }

  private selfId(status: SessionStatus) {
    return { linkId: status.selfId, sessionId: this.bookingId };
  }

  /** Seals a question in this browser and sends it. Earlier turns go along so the answer can follow the conversation. */
  async ask(status: SessionStatus, text: string, history: { question: string; answer: string }[]): Promise<string> {
    const id = randomId();
    const sealed = sealAskMessage(this.relay.key, { ...this.selfId(status), messageId: id }, "q", { v: 1, text, history: history.slice(-4) });
    await call(this.fetcher, "POST", `${this.base}/api/sessions/${this.bookingId}/questions`, { id, sealed }, this.bearer);
    return id;
  }

  async poll(status: SessionStatus, questionId: string): Promise<{ status: "waiting" | "gone" } | { status: "answered"; reply: PublicReply }> {
    const r = await call<{ status: "waiting" | "answered" | "gone"; answer?: string }>(this.fetcher, "GET", `${this.base}/api/sessions/${this.bookingId}/questions/${questionId}`, undefined, this.bearer);
    if (r.status !== "answered" || !r.answer) return { status: r.status === "answered" ? "gone" : r.status };
    return { status: "answered", reply: openAskMessage<PublicReply>(this.relay.key, { ...this.selfId(status), messageId: questionId }, "a", r.answer) };
  }
}
