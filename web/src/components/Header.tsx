"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { navGroups, site } from "@/lib/site";
import { Logo } from "./Logo";
import { ArrowIcon, ChevronIcon, CloseIcon, GitHubIcon, MenuIcon, XIcon } from "./icons";

export function Header() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false); // the phone menu
  const [group, setGroup] = useState<string | null>(null); // the open desktop menu
  const closeTimer = useRef(0);
  const navRef = useRef<HTMLElement>(null);

  const isActive = (href: string) => pathname === href || (href !== "/docs" && pathname.startsWith(`${href}/`));
  const closeAll = () => {
    window.clearTimeout(closeTimer.current);
    setOpen(false);
    setGroup(null);
  };

  useEffect(() => {
    if (!group) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setGroup(null);
    };
    const onDown = (e: PointerEvent) => {
      if (!navRef.current?.contains(e.target as Node)) setGroup(null);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [group]);

  // A pointer may cross the gap between the label and its panel without the menu closing.
  const hoverOpen = (label: string) => {
    window.clearTimeout(closeTimer.current);
    setGroup(label);
  };
  const hoverClose = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setGroup(null), 160);
  };

  return (
    <header className="site-header" data-open={open ? "true" : "false"}>
      <div className="site-header-inner">
        <Link href="/" className="site-brand" aria-label={`${site.name} home`} onClick={closeAll}>
          <Logo />
        </Link>

        <nav className="site-nav" aria-label="Main" ref={navRef}>
          {navGroups.map((g) => {
            const expanded = group === g.label;
            const current = g.items.some((it) => isActive(it.href));
            const panelId = `nav-${g.label.toLowerCase()}`;
            return (
              <div
                key={g.label}
                className="site-nav-group"
                data-open={expanded ? "true" : "false"}
                onPointerEnter={(e) => e.pointerType === "mouse" && hoverOpen(g.label)}
                onPointerLeave={(e) => e.pointerType === "mouse" && hoverClose()}
              >
                <button
                  type="button"
                  className="site-nav-link"
                  aria-expanded={expanded}
                  aria-controls={panelId}
                  data-current={current ? "true" : undefined}
                  onClick={() => setGroup(expanded ? null : g.label)}
                >
                  {g.label}
                  <ChevronIcon className="site-nav-chevron" />
                </button>
                <div id={panelId} className="nav-panel" hidden={!expanded}>
                  <div className="nav-panel-head">
                    <p className="nav-panel-label">{g.label}</p>
                    <p className="nav-panel-lead">{g.lead}</p>
                  </div>
                  <ul className="nav-panel-list">
                    {g.items.map((it) => (
                      <li key={it.href}>
                        <Link href={it.href} className="nav-panel-link" aria-current={isActive(it.href) ? "page" : undefined} onClick={closeAll}>
                          <span className="nav-panel-title">
                            {it.label} <ArrowIcon />
                          </span>
                          <span className="nav-panel-text">{it.text}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            );
          })}
        </nav>

        <div className="site-actions">
          <a className="icon-link" href={site.githubUrl} target="_blank" rel="noopener noreferrer" aria-label="Sigil on GitHub">
            <GitHubIcon />
          </a>
          <a className="icon-link" href={site.xUrl} target="_blank" rel="noopener noreferrer" aria-label="Sigil on X">
            <XIcon />
          </a>
          <Link href="/vault" className="button button-primary button-small site-cta" aria-current={isActive("/vault") ? "page" : undefined} onClick={closeAll}>
            Open vault
          </Link>
          <button type="button" className="icon-link site-menu-button" aria-expanded={open} aria-controls="site-menu" aria-label={open ? "Close menu" : "Open menu"} onClick={() => setOpen((v) => !v)}>
            {open ? <CloseIcon /> : <MenuIcon />}
          </button>
        </div>
      </div>

      <nav id="site-menu" className="site-menu" aria-label="Menu" hidden={!open}>
        {navGroups.map((g) => (
          <div key={g.label} className="site-menu-group">
            <p className="site-menu-label">{g.label}</p>
            <ul className="site-menu-list">
              {g.items.map((it) => (
                <li key={it.href}>
                  <Link href={it.href} className="site-menu-link" aria-current={isActive(it.href) ? "page" : undefined} onClick={closeAll}>
                    {it.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <Link href="/vault" className="button button-primary site-menu-cta" onClick={closeAll}>
          Open vault
        </Link>
      </nav>
    </header>
  );
}
