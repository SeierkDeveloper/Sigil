import Link from "next/link";
import { legalNav, navGroups, site } from "@/lib/site";
import { Logo } from "./Logo";
import { GitHubIcon, XIcon } from "./icons";

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <div className="site-footer-brand">
          <Logo withName />
          <p className="site-footer-tagline">{site.tagline}</p>
          <div className="site-footer-social">
            <a className="icon-link" href={site.githubUrl} target="_blank" rel="noopener noreferrer" aria-label="Sigil on GitHub">
              <GitHubIcon />
            </a>
            <a className="icon-link" href={site.xUrl} target="_blank" rel="noopener noreferrer" aria-label="Sigil on X">
              <XIcon />
            </a>
          </div>
        </div>
        <nav className="site-footer-nav" aria-label="Footer">
          {navGroups.map((g) => (
            <div key={g.label} className="site-footer-group">
              <p className="site-footer-label">{g.label}</p>
              <ul>
                {g.items.map((item) => (
                  <li key={item.href}>
                    <Link href={item.href}>{item.label}</Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </div>
      <div className="site-footer-legal">
        <p>
          <span>Open source. Use at your own risk; see the <Link href="/terms">terms</Link>.</span>
          <span className="site-footer-legal-links">
            {legalNav.map((l) => (
              <Link key={l.href} href={l.href}>
                {l.label}
              </Link>
            ))}
          </span>
        </p>
      </div>
    </footer>
  );
}
