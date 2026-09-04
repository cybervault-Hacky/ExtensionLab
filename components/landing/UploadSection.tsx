"use client";

import { Workbench } from "@/components/extension/Workbench";

export function UploadSection() {
  return (
    <section id="upload" className="section-width py-16 lg:py-24">
      <div className="mx-auto mb-10 max-w-2xl text-center">
        <p className="eyebrow">Analyze</p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
          Upload your extension
        </h2>
        <p className="mt-4 text-[var(--text-secondary)]">
          Drop a ZIP package. ExtensionLab reads it locally and builds a report
          without running any extension code.
        </p>
      </div>

      <div className="mx-auto max-w-3xl">
        <Workbench />
      </div>
    </section>
  );
}
