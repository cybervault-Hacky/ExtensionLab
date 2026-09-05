import { Navbar } from "@/components/layout/Navbar";
import { Footer } from "@/components/layout/Footer";
import { Hero } from "@/components/landing/Hero";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { Features } from "@/components/landing/Features";
import { UploadSection } from "@/components/landing/UploadSection";
import { CTA } from "@/components/landing/CTA";

const documentationPoints = [
  {
    title: "Package format",
    body: "Phase 1 accepts browser extension ZIP packages up to 25 MB and reads their contents entirely in the browser.",
  },
  {
    title: "Manifest handling",
    body: "The analyzer locates manifest.json even when the extension is nested inside a top-level folder.",
  },
  {
    title: "No execution",
    body: "Uploaded JavaScript, HTML and other files are treated as untrusted data. They are never executed or injected.",
  },
  {
    title: "Local-only",
    body: "ZIP contents are not uploaded to an external API during Phase 1.",
  },
];

export default function HomePage() {
  return (
    <div className="min-h-screen">
      <Navbar />
      <main>
        <Hero />
        <HowItWorks />
        <Features />
        <UploadSection />
        <DocumentationSection />
        <CTA />
      </main>
      <Footer />
    </div>
  );
}

function DocumentationSection() {
  return (
    <section id="documentation" className="bg-[var(--surface)] py-16 lg:py-24">
      <div className="section-width">
        <div className="mx-auto max-w-2xl text-center">
          <p className="eyebrow">Documentation</p>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            A calm, local inspection workflow
          </h2>
          <p className="mt-4 text-[var(--text-secondary)]">
            Phase 1 focuses on the foundational inspection flow you need before
            you ship.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-5 pt-10 sm:grid-cols-2">
          {documentationPoints.map((point) => (
            <article key={point.title} className="card card-pad">
              <h3 className="text-lg font-semibold tracking-tight">
                {point.title}
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">
                {point.body}
              </p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
