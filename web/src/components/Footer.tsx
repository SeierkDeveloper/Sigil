import Link from "next/link";
import { footerNav, site } from "@/lib/site";
import { Logo } from "./Logo";
import { GitHubIcon, XIcon } from "./icons";

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <div className="site-footer-brand">
          <Logo />
          <p className="site-footer-tagline">{site.tagline}</p>
        </div>
        <nav className="site-footer-nav" aria-label="Footer">
          {footerNav.map((item) => (
            <Link key={item.href} href={item.href}>
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="site-footer-social">
          <a className="icon-link" href={site.githubUrl} target="_blank" rel="noopener noreferrer" aria-label="Sigil on GitHub">
            <GitHubIcon />
          </a>
          <a className="icon-link" href={site.xUrl} target="_blank" rel="noopener noreferrer" aria-label="Sigil on X">
            <XIcon />
          </a>
        </div>
      </div>
      <div className="site-footer-legal">
        <p>Open source. Use at your own risk; see the <Link href="/terms">terms</Link>.</p>
      </div>
    </footer>
  );
}
