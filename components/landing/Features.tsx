"use client";

import {
  FileSearch,
  FolderTree,
  Gauge,
  ListChecks,
  Lock,
  ScanSearch,
} from "lucide-react";

const features = [
  {
    icon: FileSearch,
    title: "Manifest Analysis",
    text: "Inspect manifest configuration and detect the extension version at a glance.",
  },
  {
    icon: Lock,
    title: "Permission Overview",
    text: "See requested permissions and host permissions, categorized and easy to scan.",
  },
  {
    icon: FolderTree,
    title: "File Structure",
    text: "Understand what is included in the extension package with a browsable tree.",
  },
  {
    icon: ScanSearch,
    title: "Configuration Checks",
    text: "Catch obvious missing referenced files and common manifest problems.",
  },
  {
    icon: Gauge,
    title: "Health Score",
    text: "Get an easy-to-understand overview based on Phase 1 checks.",
  },
  {
    icon: ListChecks,
    title: "Local Processing",
    text: "Phase 1 analysis happens in the browser. Uploaded code is never executed.",
  },
];

export function Features() {
  return (
    <section id="features" className="bg-[var(--surface)] py-16 lg:py-24">
      <div className="section-width">
        <div className="mx-auto max-w-2xl text-center">
          <p className="eyebrow">Features</p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            Everything you need to understand a package.
          </h2>
          <p className="mt-4 text-[var(--text-secondary)]">
            A focused inspection tool for the details that matter before release.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-5 pt-10 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => {
            const Icon = feature.icon;
            return (
              <article key={feature.title} className="card card-pad">
                <span className="inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent)]">
                  <Icon className="h-6 w-6" aria-hidden="true" />
                </span>
                <h3 className="mt-5 text-lg font-semibold tracking-tight">
                  {feature.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">
                  {feature.text}
                </p>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
