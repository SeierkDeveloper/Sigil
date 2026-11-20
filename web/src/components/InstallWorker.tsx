"use client";

import { useEffect } from "react";

/**
 * Registers the service worker that keeps the app shell for offline use and
 * receives what the phone's share sheet sends. Only in a production build, so
 * development never serves a stale page.
 */
export function InstallWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => undefined);
  }, []);
  return null;
}
