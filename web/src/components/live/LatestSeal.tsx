"use client";

import Link from "next/link";
import { formatSealPeriod, plural } from "@/lib/format";
import { ArrowIcon } from "../icons";
import { untilNextSeal, useLive, useNow, type SealsResponse } from "./useLive";

/** The newest seal on this server, live, with the time left until the running hour closes. */
export function LatestSeal() {
  const live = useLive<SealsResponse>("/api/seals?limit=1", 60_000);
  const now = useNow();

  if (live.status === "loading") {
    return (
      <div className="seal-card" aria-busy="true">
        <div className="loading" role="status">
          <span className="spinner" aria-hidden="true" /> Loading the latest seal
        </div>
      </div>
    );
  }
  if (live.status === "error") {
    return (
      <div className="seal-card">
        <p className="notice" role="status">
          <span>The latest seal could not be loaded right now.</span>
        </p>
      </div>
    );
  }

  const { seals, periodSeconds, mode } = live.data;
  const seal = seals[0];
  return (
    <div className="seal-card" data-empty={seal ? "false" : "true"}>
      <div className="seal-card-head">
        <span className="seal-card-label">{seal ? "Latest seal" : "No seals yet"}</span>
        <span className="badge">{seal?.anchorTx ? "On chain" : mode === "anchored" ? "Waiting for chain" : "Local"}</span>
      </div>
      {seal ? (
        <>
          <p className="seal-card-period">{formatSealPeriod(seal.hour, periodSeconds)}</p>
          <p className="seal-card-root" title="The Merkle root of every read in this hour">
            {seal.root}
          </p>
          <dl className="seal-card-facts">
            <div>
              <dt>Reads in it</dt>
              <dd>{plural(seal.leaves, "read")}</dd>
            </div>
            <div>
              <dt>Seal number</dt>
              <dd>{seal.hour}</dd>
            </div>
            <div>
              <dt>This hour closes in</dt>
              <dd className="seal-card-clock">{now ? untilNextSeal(now, periodSeconds) : "00:00"}</dd>
            </div>
          </dl>
        </>
      ) : (
        <>
          <p className="seal-card-empty">
            A seal is made at the end of every hour in which a connected app read a vault. The first one will appear here by itself.
          </p>
          <dl className="seal-card-facts">
            <div>
              <dt>This hour closes in</dt>
              <dd className="seal-card-clock">{now ? untilNextSeal(now, periodSeconds) : "00:00"}</dd>
            </div>
          </dl>
        </>
      )}
      <p className="seal-card-link">
        <Link href="/seals" className="arrow-link">
          {seal ? "Check this seal yourself" : "How seals are checked"} <ArrowIcon />
        </Link>
      </p>
    </div>
  );
}
