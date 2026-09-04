"use client";

import { useRef, useState } from "react";
import type { DragEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, FileArchive, FolderUp, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export type UploadStatus =
  | "idle"
  | "uploading"
  | "success"
  | "error";

export interface UploadZoneProps {
  status: UploadStatus;
  fileName?: string;
  errorMessage?: string;
  onFileSelect: (file: File) => void;
  disabled?: boolean;
  onReset?: () => void;
}

export function UploadZone({
  status,
  fileName,
  errorMessage,
  onFileSelect,
  disabled = false,
  onReset,
}: UploadZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const openPicker = () => {
    if (disabled) return;
    inputRef.current?.click();
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(false);
    if (disabled) return;
    const file = event.dataTransfer.files?.[0];
    if (file) onFileSelect(file);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (!disabled) setDragOver(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragOver(false);
  };

  return (
    <div
      aria-live="polite"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div
        role="group"
        aria-label="Upload extension ZIP file"
        onClick={openPicker}
        className={cn(
          "card relative flex min-h-[340px] flex-col items-center justify-center border-2 border-dashed p-8 text-center transition-all sm:min-h-[380px]",
          dragOver && "border-[var(--accent)] bg-[var(--accent-soft)]",
          disabled && "cursor-not-allowed opacity-70",
          !disabled && "cursor-pointer hover:border-[var(--accent)]",
        )}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".zip,application/zip"
          className="sr-only"
          aria-hidden="true"
          disabled={disabled}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onFileSelect(file);
            event.target.value = "";
          }}
        />

        <AnimatePresence mode="wait">
          {status === "idle" ? (
            <motion.div
              key="idle"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center"
            >
              <span className="inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent)]">
                <FolderUp className="h-8 w-8" aria-hidden="true" />
              </span>
              <h3 className="mt-6 text-xl font-semibold tracking-tight sm:text-2xl">
                Drop your extension here
              </h3>
              <p className="mt-2 text-sm text-[var(--text-secondary)]">
                or choose a ZIP file
              </p>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  openPicker();
                }}
                className="mt-6 inline-flex min-h-[44px] items-center justify-center rounded-full bg-[var(--accent)] px-6 text-sm font-medium text-[var(--accent-foreground)] transition-colors hover:bg-[var(--accent-hover)]"
              >
                Browse Files
              </button>
              <p className="mt-5 text-xs text-[var(--text-secondary)]">
                Chrome · Edge · Firefox
              </p>
              <p className="mt-1 text-xs text-[var(--text-secondary)]">
                Max 25 MB · .zip only
              </p>
            </motion.div>
          ) : null}

          {status === "uploading" ? (
            <motion.div
              key="uploading"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center"
            >
              <span className="inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-[var(--accent-soft)] text-[var(--accent)]">
                <FileArchive className="h-8 w-8 animate-pulse" aria-hidden="true" />
              </span>
              <h3 className="mt-6 text-lg font-semibold">Reading package</h3>
              <p className="mt-1 max-w-xs text-sm text-[var(--text-secondary)]">
                {fileName ?? "Processing extension ZIP"}
              </p>
            </motion.div>
          ) : null}

          {status === "success" ? (
            <motion.div
              key="success"
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center"
            >
              <span className="inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-[var(--status-success-soft)] text-[var(--status-success)]">
                <Check className="h-8 w-8" aria-hidden="true" />
              </span>
              <h3 className="mt-6 text-xl font-semibold tracking-tight">
                File ready
              </h3>
              <p className="mt-2 text-sm text-[var(--text-secondary)]">
                {fileName ?? "Extension ZIP"}
              </p>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onReset?.();
                }}
                className="mt-6 inline-flex min-h-[44px] items-center justify-center rounded-full bg-[var(--surface-secondary)] px-5 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface)]"
              >
                Choose another
              </button>
            </motion.div>
          ) : null}

          {status === "error" ? (
            <motion.div
              key="error"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center"
            >
              <span className="inline-flex h-16 w-16 items-center justify-center rounded-2xl bg-[var(--status-error-soft)] text-[var(--status-error)]">
                <XCircle className="h-8 w-8" aria-hidden="true" />
              </span>
              <h3 className="mt-6 text-xl font-semibold tracking-tight">
                Couldn&apos;t read this file
              </h3>
              <p className="mt-2 max-w-md text-sm text-[var(--text-secondary)]">
                {errorMessage ??
                  "The file may be corrupted or incorrectly packaged."}
              </p>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onReset?.();
                }}
                className="mt-6 inline-flex min-h-[44px] items-center justify-center rounded-full bg-[var(--surface-secondary)] px-5 text-sm font-medium text-[var(--text-primary)] transition-colors hover:bg-[var(--surface)]"
              >
                Try another file
              </button>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}
