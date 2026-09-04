"use client";

const steps = [
  { number: "01", title: "Upload", text: "Add your extension ZIP." },
  { number: "02", title: "Inspect", text: "ExtensionLab reads the package." },
  { number: "03", title: "Analyze", text: "Manifest, permissions and structure are checked." },
  { number: "04", title: "Understand", text: "Review issues and configuration details." },
];

export function HowItWorks() {
  return (
    <section id="product" className="section-width py-16 lg:py-24">
      <div className="mx-auto max-w-2xl text-center">
        <p className="eyebrow">How it works</p>
        <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
          Four steps. Zero guesswork.
        </h2>
        <p className="mt-4 text-[var(--text-secondary)]">
          Upload a package and get a clear picture of what it requests and
          references.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-5 pt-10 sm:grid-cols-2 lg:grid-cols-4">
        {steps.map((step) => (
          <article key={step.number} className="card card-pad">
            <span className="text-4xl font-semibold tracking-tight text-[var(--accent)]">
              {step.number}
            </span>
            <h3 className="mt-4 text-lg font-semibold tracking-tight">
              {step.title}
            </h3>
            <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">
              {step.text}
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}
