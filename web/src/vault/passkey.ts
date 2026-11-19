// The browser side of passkeys. The PRF output that unlocks the vault is read
// here and never sent anywhere: the response JSON for the server carries an
// empty clientExtensionResults.

import { PASSKEY_PRF_SALT, fromBase64Url, randomBytes, toBase64Url } from "@sigil/core";
import type { PasskeyDriver } from "./ops";

type Json = Record<string, unknown>;

const buf = (b64: string) => fromBase64Url(b64).slice().buffer as ArrayBuffer;
const b64 = (data: ArrayBuffer | null | undefined) => (data ? toBase64Url(new Uint8Array(data)) : undefined);
const salt = () => PASSKEY_PRF_SALT.slice().buffer as ArrayBuffer;

export class PasskeyCancelled extends Error {
  constructor() {
    super("The passkey request was cancelled or timed out.");
    this.name = "PasskeyCancelled";
  }
}

export function passkeysAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential === "function" && !!navigator.credentials;
}

function prfOf(cred: PublicKeyCredential): Uint8Array | null {
  const ext = cred.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } };
  const first = ext.prf?.results?.first;
  return first ? new Uint8Array(first) : null;
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const name = (err as Error)?.name;
    if (name === "NotAllowedError" || name === "AbortError") throw new PasskeyCancelled();
    if (name === "InvalidStateError") throw new Error("This device already has a passkey for this vault.");
    throw err;
  }
}

export const browserPasskeys: PasskeyDriver = {
  async create(options) {
    const o = options as Json & { challenge: string; user: Json & { id: string }; excludeCredentials?: (Json & { id: string })[] };
    const publicKey = {
      ...o,
      challenge: buf(o.challenge),
      user: { ...o.user, id: buf(o.user.id) },
      excludeCredentials: (o.excludeCredentials ?? []).map((c) => ({ ...c, id: buf(c.id) })),
      extensions: { prf: { eval: { first: salt() } } },
    } as unknown as PublicKeyCredentialCreationOptions;
    const cred = await guard(async () => (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null);
    if (!cred) throw new PasskeyCancelled();
    const r = cred.response as AuthenticatorAttestationResponse;
    return {
      credentialId: cred.id,
      prf: prfOf(cred),
      response: {
        id: cred.id,
        rawId: b64(cred.rawId),
        type: cred.type,
        response: {
          clientDataJSON: b64(r.clientDataJSON),
          attestationObject: b64(r.attestationObject),
          transports: typeof r.getTransports === "function" ? r.getTransports() : [],
        },
        clientExtensionResults: {},
        authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
      },
    };
  },

  async get(options) {
    const o = options as Json & { challenge: string; rpId?: string; timeout?: number; userVerification?: UserVerificationRequirement };
    const publicKey: PublicKeyCredentialRequestOptions = {
      challenge: buf(o.challenge),
      rpId: o.rpId,
      timeout: o.timeout,
      userVerification: o.userVerification ?? "required",
      allowCredentials: [],
      extensions: { prf: { eval: { first: salt() } } } as AuthenticationExtensionsClientInputs,
    };
    const cred = await guard(async () => (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null);
    if (!cred) throw new PasskeyCancelled();
    const r = cred.response as AuthenticatorAssertionResponse;
    return {
      prf: prfOf(cred),
      response: {
        id: cred.id,
        rawId: b64(cred.rawId),
        type: cred.type,
        response: {
          clientDataJSON: b64(r.clientDataJSON),
          authenticatorData: b64(r.authenticatorData),
          signature: b64(r.signature),
          userHandle: b64(r.userHandle),
        },
        clientExtensionResults: {},
        authenticatorAttachment: cred.authenticatorAttachment ?? undefined,
      },
    };
  },

  async prf(credentialId) {
    // A local request only to read the PRF output of the passkey just made; nothing from it goes to the server.
    const cred = await guard(
      async () =>
        (await navigator.credentials.get({
          publicKey: {
            challenge: randomBytes(32).slice().buffer as ArrayBuffer,
            allowCredentials: [{ type: "public-key", id: buf(credentialId) }],
            userVerification: "required",
            extensions: { prf: { eval: { first: salt() } } } as AuthenticationExtensionsClientInputs,
          },
        })) as PublicKeyCredential | null,
    );
    return cred ? prfOf(cred) : null;
  },
};
