"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { nav, site } from "@/lib/site";
import { Logo } from "./Logo";
import { CloseIcon, GitHubIcon, MenuIcon, XIcon } from "./icons";

export function Header() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);

  return (
    <header className="site-header" data-open={open ? "true" : "false"}>
      <div className="site-header-inner">
        <Link href="/" className="site-brand" aria-label={`${site.name} home`} onClick={() => setOpen(false)}>
          <Logo />
        </Link>

        <nav className="site-nav" aria-label="Main">
          {nav.map((item) => (
            <Link key={item.href} href={item.href} className="site-nav-link" aria-current={isActive(item.href) ? "page" : undefined} onClick={() => setOpen(false)}>
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="site-actions">
          <a className="icon-link" href={site.githubUrl} target="_blank" rel="noopener noreferrer" aria-label="Sigil on GitHub">
            <GitHubIcon />
          </a>
          <a className="icon-link" href={site.xUrl} target="_blank" rel="noopener noreferrer" aria-label="Sigil on X">
            <XIcon />
          </a>
          <Link href="/vault" className="button button-primary button-small site-cta" aria-current={isActive("/vault") ? "page" : undefined}>
            Open vault
          </Link>
          <button type="button" className="icon-link site-menu-button" aria-expanded={open} aria-controls="site-menu" aria-label={open ? "Close menu" : "Open menu"} onClick={() => setOpen((v) => !v)}>
            {open ? <CloseIcon /> : <MenuIcon />}
          </button>
        </div>
      </div>

      <nav id="site-menu" className="site-menu" aria-label="Menu" hidden={!open}>
        {nav.map((item) => (
          <Link key={item.href} href={item.href} className="site-menu-link" aria-current={isActive(item.href) ? "page" : undefined} onClick={() => setOpen(false)}>
            {item.label}
          </Link>
        ))}
        <Link href="/vault" className="button button-primary site-menu-cta" onClick={() => setOpen(false)}>
          Open vault
        </Link>
      </nav>
    </header>
  );
}
