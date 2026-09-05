"use client";

import { Button } from "@/components/ui/Button";

export function CTA() {
  return (
    <section className="section-width py-16 lg:py-24">
      <div className="card card-pad mx-auto max-w-4xl text-center">
        <p className="eyebrow">Ready</p>
        <h2 className="mx-auto mt-3 max-w-xl text-3xl font-semibold tracking-tight sm:text-4xl">
          Inspect before you ship.
        </h2>
        <p className="mx-auto mt-4 max-w-md text-[var(--text-secondary)]">
          Understand your extension package with a clear, local report.
        </p>
        <div className="mt-8 flex justify-center">
          <Button href="#upload" variant="accent" size="lg">
            Upload Extension
          </Button>
        </div>
      </div>
    </section>
  );
}
