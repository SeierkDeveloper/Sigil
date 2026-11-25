// The holder mark on a public AI self page and an ask link: the owner's tier,
// and nothing else (never the wallet or the balance).

const NAME = { bearer: "Bearer", keeper: "Keeper", warden: "Warden" } as const;

export type HolderTier = keyof typeof NAME;

export function HolderMark({ tier }: { tier?: HolderTier | null }) {
  if (!tier || !(tier in NAME)) return null;
  return (
    <p className="holder-mark" data-tier={tier} data-testid="holder-mark">
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
        <path d="M8 1.5 14 8 8 14.5 2 8Z" fill="none" stroke="currentColor" strokeWidth="1.2" />
        {tier !== "bearer" ? <path d="M8 4.5 11.5 8 8 11.5 4.5 8Z" fill={tier === "warden" ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1" /> : null}
      </svg>
      <span>{NAME[tier]}</span>
      <span className="holder-mark-note">holds the Sigil token</span>
    </p>
  );
}
