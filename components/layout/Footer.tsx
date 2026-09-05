"use client";

import { Logo } from "./Logo";

const productLinks = [
  { label: "Product", href: "/#product" },
  { label: "Features", href: "/#features" },
  { label: "Pricing", href: "/pricing" },
  { label: "Documentation", href: "/#documentation" },
];

const legalLinks = [
  { label: "Privacy" },
  { label: "Terms" },
];

export function Footer() {
  return (
    <footer
      id="footer"
      className="border-t border-[var(--border)] bg-[var(--surface)]"
    >
      <div className="section-width py-10">
        <div className="flex flex-col gap-8 md:flex-row md:items-start md:justify-between">
          <div className="max-w-sm">
            <Logo />
            <p className="mt-3 text-sm text-[var(--text-secondary)]">
              Test smarter. Ship confidently.
            </p>
            <p className="mt-2 text-xs text-[var(--text-secondary)]">
              Phase 1 analyzes extension packages locally in your browser.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-10">
            <div>
              <p className="mb-3 text-sm font-semibold">Product</p>
              <ul className="space-y-2">
                {productLinks.map((link) => (
                  <li key={link.label}>
                    <a
                      href={link.href}
                      className="text-sm text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="mb-3 text-sm font-semibold">Legal</p>
              <ul className="space-y-2">
                {legalLinks.map((link) => (
                  <li key={link.label}>
                    <span className="cursor-default text-sm text-[var(--text-secondary)]">
                      {link.label}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        <div className="mt-10 flex flex-col gap-2 border-t border-[var(--border)] pt-6 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-[var(--text-secondary)]">
            © 2026 ExtensionLab
          </p>
          <p className="text-xs text-[var(--text-secondary)]">
            Uploaded extensions are never executed in Phase 1.
          </p>
        </div>
      </div>
    </footer>
  );
}
