"use client";

import { Badge } from "@/components/ui/Badge";
import type { ExtensionAnalysis } from "@/types/extension";

export function ManifestCard({
  analysis,
}: {
  analysis: ExtensionAnalysis;
}) {
  const manifest = analysis.manifest;
  const versionBadge = manifest.manifestVersionLabel.replace("Manifest ", "");

  return (
    <section className="card card-pad">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <p className="eyebrow">Manifest</p>
          <h2 className="mt-1 text-xl font-semibold tracking-tight">
            Configuration
          </h2>
        </div>
        <Badge tone="accent">v{versionBadge}</Badge>
      </div>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
        <Field label="Name" value={manifest.name ?? "—"} />
        <Field label="Version" value={manifest.version ?? "—"} />
        <div className="sm:col-span-2">
          <Field label="Description" value={manifest.description ?? "—"} />
        </div>
      </dl>

      <div className="mt-7 border-t border-[var(--border)] pt-5">
        <h3 className="mb-3 text-sm font-semibold">Detected features</h3>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {manifest.detectedConfig.map((config) => (
            <div
              key={config.label}
              className="flex items-center justify-between gap-3 rounded-xl bg-[var(--surface-secondary)] px-3 py-2.5"
            >
              <span className="text-sm font-medium">{config.label}</span>
              <span
                className="truncate text-right text-xs text-[var(--text-secondary)]"
                title={config.detail}
              >
                {config.present ? config.detail : "Not defined"}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">
        {label}
      </dt>
      <dd className="mt-1 break-words text-sm text-[var(--text-primary)]">
        {value}
      </dd>
    </div>
  );
}
