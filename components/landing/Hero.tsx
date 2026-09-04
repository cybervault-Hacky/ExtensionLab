"use client";

import { motion, useReducedMotion } from "framer-motion";
import { Button } from "@/components/ui/Button";
import { HeroVisual } from "./HeroVisual";

export function Hero() {
  const reduceMotion = useReducedMotion();

  const fadeUp = (delay = 0) => ({
    initial: reduceMotion ? { opacity: 0 } : { opacity: 0, y: 16 },
    animate: reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0 },
    transition: { delay, duration: 0.5, ease: "easeOut" as const },
  });

  return (
    <section className="section-width grid grid-cols-1 items-center gap-12 pt-14 pb-20 lg:grid-cols-2 lg:gap-16 lg:pt-24 lg:pb-28">
      <div className="max-w-xl">
        <motion.p {...fadeUp(0)} className="eyebrow">
          Browser extension testing
        </motion.p>

        <motion.h1
          {...fadeUp(0.05)}
          className="mt-4 text-5xl font-bold leading-[1.02] tracking-[-0.035em] sm:text-6xl lg:text-7xl"
        >
          Test your browser
          <span className="block">extensions.</span>
        </motion.h1>

        <motion.p
          {...fadeUp(0.1)}
          className="mt-6 max-w-md text-lg leading-relaxed text-[var(--text-secondary)]"
        >
          Inspect, validate and understand your extension before you ship it.
        </motion.p>

        <motion.div
          {...fadeUp(0.15)}
          className="mt-9 flex flex-col gap-3 sm:flex-row"
        >
          <Button href="#upload" variant="accent" size="lg">
            Upload Extension
          </Button>
          <Button href="#features" variant="secondary" size="lg">
            Explore Features
          </Button>
        </motion.div>

        <motion.p
          {...fadeUp(0.2)}
          className="mt-6 text-sm text-[var(--text-secondary)]"
        >
          ZIP upload · Local analysis · No installation required
        </motion.p>
      </div>

      <motion.div
        initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 24 }}
        animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
        transition={{ duration: 0.6, delay: 0.14, ease: "easeOut" }}
        className="lg:justify-self-end"
      >
        <HeroVisual />
      </motion.div>
    </section>
  );
}
