"use client";

// The home page hero piece. Three directions are kept side by side for review:
// add ?hero=a, ?hero=b or ?hero=c to the home page address to see each one.

import { useSyncExternalStore } from "react";
import { HeroFilm } from "./HeroFilm";
import { HeroViews } from "./HeroViews";
import { HeroSlab } from "./HeroSlab";

export type HeroChoice = "a" | "b" | "c";
export const DEFAULT_HERO: HeroChoice = "b";

const noop = () => () => {};

function fromAddress(): HeroChoice {
  const v = new URLSearchParams(window.location.search).get("hero");
  return v === "a" || v === "b" || v === "c" ? v : DEFAULT_HERO;
}

export function HeroVisual() {
  const choice = useSyncExternalStore(noop, fromAddress, () => DEFAULT_HERO);
  return (
    <div className="hero-visual" data-hero={choice}>
      {choice === "a" ? <HeroFilm /> : choice === "b" ? <HeroViews /> : <HeroSlab />}
    </div>
  );
}
