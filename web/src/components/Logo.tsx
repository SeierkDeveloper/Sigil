// The Sigil mark. While site.logoSrc is null it renders the text wordmark;
// set logoSrc in lib/site.ts to switch to the logo file.

import { site } from "@/lib/site";

export function Logo({ className = "" }: { className?: string }) {
  if (site.logoSrc) {
    return (
      <span className={`logo ${className}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="logo-image" src={site.logoSrc} alt="" width={28} height={28} />
        <span className="logo-word">{site.name}</span>
      </span>
    );
  }
  return (
    <span className={`logo ${className}`}>
      <span className="logo-word">{site.name}</span>
    </span>
  );
}
