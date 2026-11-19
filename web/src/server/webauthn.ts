// Passkey sign-in. The server checks WebAuthn signatures like any passkey
// site; the vault key itself comes from the PRF extension on the device and is
// never seen here.

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { fromBase64Url, toBase64Url } from "@sigil/core";
import type { Db } from "./db";
import { siteOrigin } from "./http";
import { getPasskey, HttpError, saveChallenge, takeChallenge, updatePasskeyCounter, type PasskeyInput } from "./store";

function rp(req: Request) {
  const origin = siteOrigin(req);
  return { origin, rpID: new URL(origin).hostname };
}

export async function registrationOptions(db: Db, req: Request, userId: string, existing: string[] = []) {
  const { rpID } = rp(req);
  const options = await generateRegistrationOptions({
    rpName: "Sigil",
    rpID,
    userID: fromBase64Url(userId) as Uint8Array<ArrayBuffer>,
    userName: "Sigil vault",
    userDisplayName: "Sigil vault",
    attestationType: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
    excludeCredentials: existing.map((id) => ({ id })),
    supportedAlgorithmIDs: [-7, -257],
  });
  const challengeId = saveChallenge(db, options.challenge, "register", userId);
  return { options, challengeId };
}

export async function verifyRegistration(db: Db, req: Request, challengeId: string, response: unknown): Promise<{ userId: string; passkey: PasskeyInput }> {
  const { challenge, userId } = takeChallenge(db, challengeId, "register");
  if (!userId) throw new HttpError(400, "The sign-in request expired. Please try again.");
  const { origin, rpID } = rp(req);
  let result;
  try {
    result = await verifyRegistrationResponse({
      response: response as RegistrationResponseJSON,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });
  } catch (err) {
    throw new HttpError(400, `The passkey could not be verified: ${(err as Error).message}`, "passkey");
  }
  if (!result.verified) throw new HttpError(400, "The passkey could not be verified.", "passkey");
  const cred = result.registrationInfo.credential;
  return {
    userId,
    passkey: {
      credentialId: cred.id,
      publicKey: toBase64Url(cred.publicKey),
      counter: cred.counter,
      transports: (cred.transports ?? []) as string[],
    },
  };
}

export async function authenticationOptions(db: Db, req: Request) {
  const { rpID } = rp(req);
  const options = await generateAuthenticationOptions({ rpID, userVerification: "required", allowCredentials: [] });
  const challengeId = saveChallenge(db, options.challenge, "login", null);
  return { options, challengeId };
}

export async function verifyAuthentication(db: Db, req: Request, challengeId: string, response: unknown): Promise<{ userId: string; credentialId: string }> {
  const { challenge } = takeChallenge(db, challengeId, "login");
  const r = response as AuthenticationResponseJSON;
  const stored = typeof r?.id === "string" ? getPasskey(db, r.id) : null;
  if (!stored) throw new HttpError(404, "This passkey does not open a Sigil vault here.", "unknown_passkey");
  const { origin, rpID } = rp(req);
  let result;
  try {
    result = await verifyAuthenticationResponse({
      response: r,
      expectedChallenge: challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: stored.credentialId,
        publicKey: fromBase64Url(stored.publicKey) as Uint8Array<ArrayBuffer>,
        counter: stored.counter,
        transports: stored.transports as never,
      },
      requireUserVerification: true,
    });
  } catch (err) {
    throw new HttpError(400, `The passkey could not be verified: ${(err as Error).message}`, "passkey");
  }
  if (!result.verified) throw new HttpError(400, "The passkey could not be verified.", "passkey");
  updatePasskeyCounter(db, stored.credentialId, result.authenticationInfo.newCounter);
  return { userId: stored.userId, credentialId: stored.credentialId };
}
