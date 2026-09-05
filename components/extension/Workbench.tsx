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
import { AutomatedTestLaunchCard } from "@/components/tester/AutomatedTestLaunchCard";
import { ExtensionLabError } from "@/lib/extension/errors";
import { validateExtensionFile } from "@/lib/extension/validation";
import { Button } from "@/components/ui/Button";
import { PaywallNotice, paywallFromError, type PaywallInfo } from "@/components/billing/PaywallNotice";
import type { ApiErrorPayload } from "@/components/billing/types";
import type { AnalysisStep, ExtensionAnalysis } from "@/types/extension";

type WorkbenchState = "idle" | "uploading" | "done" | "error";

export function Workbench() {
  const [state, setState] = useState<WorkbenchState>("idle");
  const [status, setStatus] = useState<UploadStatus>("idle");
  const [fileName, setFileName] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState<string>("");
  const [analysis, setAnalysis] = useState<ExtensionAnalysis | null>(null);
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [savedExtensionId, setSavedExtensionId] = useState<string | null>(null);
  const [savedSnapshotId, setSavedSnapshotId] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savePaywall, setSavePaywall] = useState<PaywallInfo | null>(null);
  const [step, setStep] = useState<AnalysisStep | null>(null);
  const [ratio, setRatio] = useState(0);
  const reportRef = useRef<HTMLDivElement>(null);

  const reset = useCallback(() => {
    setState("idle");
    setSaveError(null);
    setSavePaywall(null);
    setStatus("idle");
    setFileName("");
    setErrorMessage("");
    setAnalysis(null);
    setSourceFile(null);
    setSavedExtensionId(null);
    setSavedSnapshotId(null);
    setSaveError(null);
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

      try {
        const saveResponse = await fetch("/api/extensions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ analysis: result }),
        });
        if (saveResponse.ok) {
          const saved = (await saveResponse.json()) as {
            extension: { id: string };
            snapshot: { id: string };
          };
          setSavedExtensionId(saved.extension.id);
          setSavedSnapshotId(saved.snapshot.id);
        } else {
          const body = (await saveResponse.json().catch(() => null)) as ApiErrorPayload | null;
          const limit = paywallFromError(body);
          if (limit) setSavePaywall(limit);
          else setSaveError(body?.error?.message ?? "The analysis could not be saved to your workspace.");
        }
      } catch {
        setSaveError("The analysis could not be saved to your workspace.");
      }
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
              {savePaywall ? <PaywallNotice info={savePaywall} /> : null}
              {saveError ? (
                <div role="status" className="rounded-xl border border-[var(--status-warning)] bg-[var(--status-warning-soft)] p-3 text-sm">
                  {saveError} The report below is still available in this tab.
                </div>
              ) : null}
              <ExtensionSummary analysis={analysis} />
              <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
                <RuntimeLaunchCard analysis={analysis} sourceFile={sourceFile} />
                <AutomatedTestLaunchCard analysis={analysis} sourceFile={sourceFile} extensionId={savedExtensionId ?? undefined} />
              </div>
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
