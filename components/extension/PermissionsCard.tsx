"use client";

import { TriangleAlert } from "lucide-react";
import type { ExtensionAnalysis } from "@/types/extension";

export function PermissionsCard({
  analysis,
}: {
  analysis: ExtensionAnalysis;
}) {
  const permissions = analysis.permissions;
  const hasPermissions =
    permissions.permissions.length > 0 ||
    permissions.hostPermissions.length > 0 ||
    permissions.optionalPermissions.length > 0;

  return (
    <section className="card card-pad">
      <div className="mb-5">
        <p className="eyebrow">Permissions</p>
        <h2 className="mt-1 text-xl font-semibold tracking-tight">
          Requested access
        </h2>
      </div>

      {permissions.broadPermissions ? (
        <div className="mb-5 flex gap-3 rounded-xl bg-[var(--status-warning-soft)] p-3 text-sm">
          <TriangleAlert
            className="mt-0.5 h-4 w-4 shrink-0 text-[var(--status-warning)]"
            aria-hidden="true"
          />
          <p className="text-[var(--text-primary)]">
            {permissions.note ?? "Broad host access was requested. Review recommended."}
          </p>
        </div>
      ) : null}

      {!hasPermissions ? (
        <p className="text-sm text-[var(--text-secondary)]">
          This extension does not declare any permissions or host permissions.
        </p>
      ) : (
        <div className="space-y-5">
          <PermissionGroup
            title="Permissions"
            empty="None declared"
            items={permissions.permissions}
            tone="browser"
          />
          <PermissionGroup
            title="Host permissions"
            empty="None declared"
            items={permissions.hostPermissions}
            tone="host"
          />
          <PermissionGroup
            title="Optional permissions"
            empty="None declared"
            items={permissions.optionalPermissions}
            tone="optional"
          />
        </div>
      )}
    </section>
  );
}

function PermissionGroup({
  title,
  items,
  empty,
  tone,
}: {
  title: string;
  items: string[];
  empty: string;
  tone: "browser" | "host" | "optional";
}) {
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold">{title}</h3>
      {items.length === 0 ? (
        <p className="text-xs text-[var(--text-secondary)]">{empty}</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {items.map((item) => (
            <li
              key={`${tone}-${item}`}
              className="rounded-lg border border-[var(--border)] bg-[var(--surface-secondary)] px-2.5 py-1.5 font-mono text-xs text-[var(--text-primary)]"
            >
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
