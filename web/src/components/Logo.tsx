// The Sigil mark. While site.logoSrc is null it renders the text wordmark.
// With a logo file the header shows the mark alone; `withName` adds the name beside it.

import { site } from "@/lib/site";

export function Logo({ className = "", withName = false }: { className?: string; withName?: boolean }) {
  if (site.logoSrc) {
    return (
      <span className={`logo ${className}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="logo-image" src={site.logoSrc} alt={withName ? "" : site.name} width={36} height={36} />
        {withName ? <span className="logo-word">{site.name}</span> : null}
      </span>
    );
  }
  return (
    <span className={`logo ${className}`}>
      <span className="logo-word">{site.name}</span>
    </span>
  );
}
