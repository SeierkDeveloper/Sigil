"use client";

import { useSyncExternalStore } from "react";
import { VaultApp } from "./VaultApp";
import { parseConsentRequest } from "./Consent";

const subscribe = () => () => undefined;

/** Reads the request from the address once on the client; the server renders the waiting state. */
export function AuthorizePage() {
  const search = useSyncExternalStore(subscribe, () => window.location.search, () => null);
  if (search === null) return null;
  return <VaultApp consent={parseConsentRequest(search)} />;
}
