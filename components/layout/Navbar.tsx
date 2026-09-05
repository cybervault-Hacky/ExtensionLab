"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { Menu, Settings, X } from "lucide-react";
import { Logo } from "./Logo";
import { Button } from "@/components/ui/Button";
import { SettingsPanel } from "@/components/settings/SettingsPanel";
import { cn } from "@/lib/utils";

const navLinks = [
  { label: "Product", href: "#product" },
  { label: "Features", href: "#features" },
  { label: "Documentation", href: "#documentation" },
];

export function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    const listener = () => setScrolled(window.scrollY > 16);
    listener();
    window.addEventListener("scroll", listener, { passive: true });
    return () => window.removeEventListener("scroll", listener);
  }, []);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape" && menuOpen) setMenuOpen(false);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [menuOpen]);

  return (
    <>
      <header
        className={cn(
          "sticky top-0 z-40 w-full transition-all duration-200",
          scrolled || menuOpen
            ? "border-b border-[var(--border)] bg-[var(--bg)]/85 backdrop-blur-xl"
            : "border-b border-transparent bg-[var(--bg)]/40 backdrop-blur-md",
        )}
      >
        <div className="section-width flex h-16 items-center justify-between gap-4">
          <Link
            href="/"
            className="inline-flex items-center rounded-full focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--accent)]"
            aria-label="ExtensionLab home"
          >
            <Logo />
          </Link>

          <nav aria-label="Primary" className="hidden items-center gap-1 md:flex">
            {navLinks.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="rounded-full px-4 py-2 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-secondary)] hover:text-[var(--text-primary)]"
              >
                {link.label}
              </a>
            ))}
          </nav>

          <div className="hidden items-center gap-2 md:flex">
            <Button
              variant="ghost"
              size="sm"
              aria-label="Appearance preferences"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings className="h-4 w-4" aria-hidden="true" />
              <span className="sr-only">Appearance preferences</span>
            </Button>
            <Button
              href="#upload"
              variant="accent"
              size="sm"
              className="min-h-[42px]"
            >
              Start Testing
            </Button>
          </div>

          <div className="flex items-center gap-1 md:hidden">
            <Button
              variant="ghost"
              size="sm"
              aria-label="Appearance preferences"
              onClick={() => setSettingsOpen(true)}
            >
              <Settings className="h-5 w-5" aria-hidden="true" />
              <span className="sr-only">Appearance preferences</span>
            </Button>
            <button
              type="button"
              aria-label={menuOpen ? "Close menu" : "Open menu"}
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((current) => !current)}
              className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-[var(--text-primary)] hover:bg-[var(--surface-secondary)]"
            >
              {menuOpen ? (
                <X className="h-5 w-5" aria-hidden="true" />
              ) : (
                <Menu className="h-5 w-5" aria-hidden="true" />
              )}
            </button>
          </div>
        </div>

        <AnimatePresence>
          {menuOpen ? (
            <motion.nav
              aria-label="Mobile"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="overflow-hidden border-t border-[var(--border)] bg-[var(--bg)]/95 backdrop-blur-xl md:hidden"
            >
              <div className="section-width flex flex-col gap-1 py-4">
                {navLinks.map((link) => (
                  <a
                    key={link.href}
                    href={link.href}
                    onClick={() => setMenuOpen(false)}
                    className="rounded-xl px-3 py-3 text-base font-medium text-[var(--text-primary)] hover:bg-[var(--surface-secondary)]"
                  >
                    {link.label}
                  </a>
                ))}
                <div className="pt-2">
                  <Button
                    href="#upload"
                    variant="accent"
                    className="w-full"
                    onClick={() => setMenuOpen(false)}
                  >
                    Start Testing
                  </Button>
                </div>
              </div>
            </motion.nav>
          ) : null}
        </AnimatePresence>
      </header>

      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </>
  );
}
