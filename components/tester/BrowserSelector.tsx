"use client";

import { useEffect, useMemo, useState } from "react";
import { Globe2, Monitor, Lock } from "lucide-react";

export interface PublicBrowser {
  browserId: "chromium" | "edge" | "firefox";
  displayName: string;
  engine: "chromium" | "gecko";
  engineLabel: string;
  version: string;
  supported: boolean;
  available: boolean;
  unavailableReason?: string;
  capabilities: Array<{ id: string; support: string; note?: string }>;
}

/**
 * Premium browser selector: engine, version label, availability and capability
 * summary per browser. Text/icons only — no emojis. Unsupported or
 * unavailable browsers are visibly marked and cannot be selected.
 */
export function BrowserSelector({
  selected,
  onChange,
  maxSelectable = 3,
  disabled = false,
}: {
  selected: string[];
  onChange: (browsers: string[]) => void;
  maxSelectable?: number;
  disabled?: boolean;
}) {
  const [browsers, setBrowsers] = useState<PublicBrowser[] | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/browsers")
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { browsers?: PublicBrowser[] } | null) => {
        if (active && body?.browsers) setBrowsers(body.browsers);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const selectableBrowsers = useMemo(
    () => (browsers ?? []).filter((browser) => browser.supported && browser.available),
    [browsers],
  );

  const toggle = (browserId: string) => {
    if (disabled) return;
    if (selected.includes(browserId)) {
      onChange(selected.filter((id) => id !== browserId));
      return;
    }
    if (selected.length >= maxSelectable) return;
    onChange([...selected, browserId]);
  };

  if (!browsers) {
    return (
      <div className="rounded-xl border border-[var(--border)] p-4 text-sm text-[var(--text-secondary)]">
        Loading browser runtimes…
      </div>
    );
  }

  return (
    <div role="group" aria-label="Browser selection" className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {browsers.map((browser) => {
        const isSelected = selected.includes(browser.browserId);
        const canSelect = browser.supported && browser.available && (isSelected || selected.length < maxSelectable);
        const capabilitySummary = summarizeCapabilities(browser);
        return (
          <button
            key={browser.browserId}
            type="button"
            onClick={() => toggle(browser.browserId)}
            disabled={disabled || !canSelect}
            aria-pressed={isSelected}
            className={`rounded-2xl border p-4 text-left transition ${
              isSelected
                ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                : "border-[var(--border)] hover:border-[var(--accent)]"
            } ${disabled || !canSelect ? "cursor-not-allowed opacity-60" : ""}`}
          >
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-2">
                {browser.engine === "gecko" ? (
                  <Monitor className="h-4 w-4 text-[var(--text-secondary)]" aria-hidden="true" />
                ) : (
                  <Globe2 className="h-4 w-4 text-[var(--text-secondary)]" aria-hidden="true" />
                )}
                <span className="font-semibold">{browser.displayName}</span>
              </span>
              {isSelected ? (
                <span className="rounded-full bg-[var(--accent)] px-2 py-0.5 text-[11px] font-semibold text-white">
                  Selected
                </span>
              ) : !browser.available ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)]">
                  <Lock className="h-3 w-3" aria-hidden="true" />
                  {browser.unavailableReason === "disabled" ? "Disabled" : "Runtime not built"}
                </span>
              ) : null}
            </div>
            <p className="mt-2 text-xs text-[var(--text-secondary)]">
              {browser.engineLabel} · Version {browser.version}
            </p>
            <p className="mt-1 text-xs text-[var(--text-secondary)]">{capabilitySummary}</p>
          </button>
        );
      })}
    </div>
  );
}

function summarizeCapabilities(browser: PublicBrowser): string {
  const notable = browser.capabilities.filter((capability) => capability.support !== "supported");
  if (notable.length === 0) return "All capabilities supported.";
  const summary = notable
    .slice(0, 2)
    .map((capability) => `${labelFor(capability.id)}: ${capability.support.replace("-", " ")}`)
    .join(" · ");
  return notable.length > 2 ? `${summary} · +${notable.length - 2} more` : summary;
}

function labelFor(id: string): string {
  const labels: Record<string, string> = {
    extensionManifestV2: "MV2",
    extensionManifestV3: "MV3",
    serviceWorker: "Service worker",
    backgroundPage: "Background page",
    popup: "Popup",
    contentScripts: "Content scripts",
    screenshots: "Screenshots",
    consoleEvents: "Console events",
    networkEvents: "Network events",
    networkStatusCodes: "Network statuses",
    extensionReload: "Extension reload",
    runtimeMessaging: "Runtime messaging",
  };
  return labels[id] ?? id;
}
