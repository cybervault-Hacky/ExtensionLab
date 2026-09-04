"use client";

import { useCallback, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, FolderSearch, RotateCcw } from "lucide-react";
import { UploadZone, type UploadStatus } from "./UploadZone";
import { UploadProgress } from "./UploadProgress";
import { ExtensionSummary } from "./ExtensionSummary";
import { ManifestCard } from "./ManifestCard";
import { PermissionsCard } from "./PermissionsCard";
import { FilesCard } from "./FilesCard";
import { ConfigurationCard } from "./ConfigurationCard";
import { HealthScore } from "./HealthScore";
import { RuntimeLaunchCard } from "@/components/tester/RuntimeLaunchCard";
import { ExtensionLabError } from "@/lib/extension/errors";
import { validateExtensionFile } from "@/lib/extension/validation";
import { Button } from "@/components/ui/Button";
import type { AnalysisStep, ExtensionAnalysis } from "@/types/extension";

type WorkbenchState = "idle" | "uploading" | "done" | "error";

export function Workbench() {
  const [state, setState] = useState<WorkbenchState>("idle");
  const [status, setStatus] = useState<UploadStatus>("idle");
  const [fileName, setFileName] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [analysis, setAnalysis] = useState<ExtensionAnalysis | null>(null);
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [step, setStep] = useState<AnalysisStep | null>(null);
  const [ratio, setRatio] = useState(0);
  const reportRef = useRef<HTMLDivElement>(null);

  const reset = useCallback(() => {
    setState("idle");
    setStatus("idle");
    setFileName("");
    setErrorMessage("");
    setAnalysis(null);
    setSourceFile(null);
    setStep(null);
    setRatio(0);
  }, []);

  const handleFileSelect = useCallback(async (file: File) => {
    const validation = validateExtensionFile(file);
    if (!validation.ok || validation.error) {
      setFileName(file.name);
      setErrorMessage(
        validation.error?.message ?? "This file could not be accepted.",
      );
      setState("error");
      setStatus("error");
      return;
    }

    setFileName(file.name);
    setSourceFile(file);
    setErrorMessage("");
    setState("uploading");
    setStatus("uploading");
    setStep(null);
    setRatio(0);

    try {
      // Lazy-load the analyzer so JSZip is only fetched when an extension is
      // actually being inspected.
      const { analyzeExtensionFile } = await import(
        "@/lib/extension/analyzer"
      ).then((module) => ({ analyzeExtensionFile: module.analyzeExtensionFile }));

      const result = await analyzeExtensionFile(file, (nextStep) => {
        setStep(nextStep);
        setRatio((nextStep.progress / 100) * 0.96);
      });
      setAnalysis(result);
      setRatio(1);
      setStatus("success");
      setState("done");
    } catch (error) {
      const label =
        error instanceof ExtensionLabError
          ? error.message
          : "We couldn't analyze this ZIP. The file may be corrupted or incorrectly packaged.";
      setErrorMessage(
        `${label} Please try another file.`,
      );
      setState("error");
      setStatus("error");
    }
  }, []);


  return (
    <div className="space-y-6">
      <AnimatePresence mode="wait">
        {state === "idle" ? (
          <motion.div
            key="upload"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.22 }}
          >
            <div className="card card-pad mb-6 flex flex-col items-center gap-3 text-center sm:flex-row sm:text-left">
              <span className="inline-flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent)]">
                <FolderSearch className="h-6 w-6" aria-hidden="true" />
              </span>
              <div>
                <p className="text-base font-semibold">No extension analyzed yet</p>
                <p className="text-sm text-[var(--text-secondary)]">
                  Upload an extension ZIP to begin.
                </p>
              </div>
            </div>
            <UploadZone
              status="idle"
              onFileSelect={handleFileSelect}
            />
          </motion.div>
        ) : null}

        {state === "uploading" ? (
          <motion.div
            key="uploading"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.2 }}
          >
            <UploadProgress currentStepId={step?.id ?? "reading"} ratio={ratio} />
          </motion.div>
        ) : null}

        {state === "error" ? (
          <motion.div
            key="error"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <UploadZone
              status="error"
              fileName={fileName}
              errorMessage={errorMessage}
              onFileSelect={handleFileSelect}
              onReset={reset}
            />
          </motion.div>
        ) : null}

        {state === "done" && analysis ? (
          <motion.div
            key="report"
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
          >
            <div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="text-2xl font-semibold tracking-tight">
                  Analysis complete
                </h2>
                <p className="mt-1 text-sm text-[var(--text-secondary)]">
                  Your extension package has been inspected.
                </p>
              </div>
              <div className="flex flex-wrap gap-3">
                <Button
                  variant="accent"
                  onClick={() =>
                    reportRef.current?.scrollIntoView({ behavior: "smooth" })
                  }
                >
                  View Report
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Button>
                <Button variant="secondary" onClick={reset}>
                  Analyze Another
                </Button>
              </div>
            </div>

            <div ref={reportRef} className="mt-8 space-y-6">
              <ExtensionSummary analysis={analysis} />
              <RuntimeLaunchCard analysis={analysis} sourceFile={sourceFile} />
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
                <ManifestCard analysis={analysis} />
                <HealthScore analysis={analysis} />
                <PermissionsCard analysis={analysis} />
                <FilesCard analysis={analysis} />
              </div>
              <ConfigurationCard analysis={analysis} />
              <div className="flex justify-center">
                <Button variant="secondary" onClick={reset}>
                  <RotateCcw className="h-4 w-4" aria-hidden="true" />
                  Analyze Another Extension
                </Button>
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
