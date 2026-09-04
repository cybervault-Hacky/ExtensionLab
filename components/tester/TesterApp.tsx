"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  RotateCw,
  Square,
  Trash2,
  WifiOff,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { BrowserViewport } from "./BrowserViewport";
import { ConsolePanel } from "./ConsolePanel";
import { NetworkPanel } from "./NetworkPanel";
import { ExtensionPanel } from "./ExtensionPanel";
import { EventsPanel } from "./EventsPanel";
import type {
  NetworkEntry,
  RuntimeEvent,
  SandboxInfo,
  SandboxStatus,
} from "@/types/runtime";

export type TesterTab = "console" | "network" | "extension" | "events";

const ACTIVE_STATUSES: SandboxStatus[] = [
  "preparing",
  "creating",
  "starting",
  "loading_extension",
  "ready",
  "running",
];

export function TesterApp({ initialSandboxId }: { initialSandboxId?: string }) {
  const [sandboxId, setSandboxId] = useState<string | undefined>(initialSandboxId);
  const [token, setToken] = useState<string | null>(null);
  const [info, setInfo] = useState<SandboxInfo | null>(null);
  const [events, setEvents] = useState<RuntimeEvent[]>([]);
  const [network, setNetwork] = useState<NetworkEntry[]>([]);
  const [tab, setTab] = useState<TesterTab>("console");
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const seenEventIds = useRef(new Set<string>());

  useEffect(() => {
    const storedToken = window.sessionStorage.getItem("extensionlab:sandbox-token");
    const url = new URL(window.location.href);
    const urlId = url.searchParams.get("id");
    const id = urlId ?? initialSandboxId;
    setSandboxId(id);
    setToken(storedToken);
    if (!id || !storedToken) {
      setFatalError(
        "Sandbox session not found. Launch a sandbox from the analysis report first.",
      );
    }
  }, [initialSandboxId]);

  const addEvents = useCallback((incoming: RuntimeEvent[]) => {
    setEvents((current) => {
      const next = [...current];
      for (const event of incoming) {
        if (seenEventIds.current.has(event.id)) continue;
        seenEventIds.current.add(event.id);
        next.push(event);
      }
      return next.slice(-500);
    });
    for (const event of incoming) {
      if (event.type === "network" && event.metadata) {
        setNetwork((current) => {
          if (current.some((entry) => entry.id === event.id)) return current;
          return [
            ...current,
            {
              id: event.id,
              timestamp: event.timestamp,
              method: String(event.metadata?.method ?? "GET"),
              url: String(event.metadata?.url ?? ""),
              status:
                typeof event.metadata?.status === "number"
                  ? event.metadata.status
                  : null,
              resourceType: String(event.metadata?.resourceType ?? "network"),
              duration:
                typeof event.metadata?.duration === "number"
                  ? event.metadata.duration
                  : 0,
            },
          ].slice(-200);
        });
      }
    }
  }, []);

  useEffect(() => {
    if (!sandboxId || !token) return;
    let cancelled = false;
    const headers = { "x-sandbox-token": token };

    const pollStatus = async () => {
      try {
        const response = await fetch(`/api/sandbox/${sandboxId}/status`, { headers });
        if (!response.ok) return;
        const data = (await response.json()) as SandboxInfo;
        if (!cancelled) setInfo(data);
        if (["failed", "timeout", "destroyed"].includes(data.status)) {
          setFatalError(data.reason ?? "The sandbox ended.");
        }
      } catch {
        // Retry on next poll.
      }
    };

    const pollEvents = async () => {
      try {
        const response = await fetch(`/api/sandbox/${sandboxId}/events`, { headers });
        if (!response.ok) return;
        const data = (await response.json()) as { events: RuntimeEvent[] };
        if (!cancelled) addEvents(data.events);
      } catch {
        // Retry on next poll.
      }
    };

    void pollStatus();
    void pollEvents();
    const statusTimer = setInterval(pollStatus, 1000);
    const eventsTimer = setInterval(pollEvents, 1200);
    return () => {
      cancelled = true;
      clearInterval(statusTimer);
      clearInterval(eventsTimer);
    };
  }, [sandboxId, token, addEvents]);

  useEffect(() => {
    if (!sandboxId || !token) return;
    let cancelled = false;
    let buffer = "";
    const controller = new AbortController();

    const run = async () => {
      const response = await fetch(`/api/sandbox/${sandboxId}/events/stream`, {
        headers: { "x-sandbox-token": token },
        signal: controller.signal,
      });
      if (!response.ok) return;
      const reader = response.body?.getReader();
      if (!reader) return;
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const dataLine = block
            .split("\n")
            .find((line) => line.startsWith("data:"));
          if (!dataLine) continue;
          try {
            const parsed = JSON.parse(dataLine.slice(5).trim()) as RuntimeEvent;
            if (!cancelled) addEvents([parsed]);
          } catch {
            // Ignore malformed frames.
          }
        }
      }
    };

    void run().catch(() => undefined);
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [sandboxId, token, addEvents]);

  const refreshScreenshot = useCallback(() => {
    if (!sandboxId || !token) return;
    const url = `/api/sandbox/${sandboxId}/screenshot?t=${Date.now()}`;
    const img = new Image();
    img.onload = () => setScreenshotUrl(url);
    img.onerror = () => {
      // Keep any previous frame; screenshots are optional.
    };
    img.src = url;
  }, [sandboxId, token]);

  useEffect(() => {
    if (!sandboxId || !token) return;
    refreshScreenshot();
    const timer = setInterval(refreshScreenshot, 2200);
    return () => clearInterval(timer);
  }, [sandboxId, token, refreshScreenshot]);

  const sendCommand = useCallback(
    async (command: "reload" | "restart" | "clearConsole" | "stop") => {
      if (!sandboxId || !token) return;
      const endpoint =
        command === "reload"
          ? "reload"
          : command === "restart"
            ? "extension/restart"
            : command === "clearConsole"
              ? "console/clear"
              : "stop";
      const response = await fetch(`/api/sandbox/${sandboxId}/${endpoint}`, {
        method: "POST",
        headers: { "x-sandbox-token": token },
      });
      if (response.ok) {
        const data = (await response.json()) as SandboxInfo;
        setInfo(data);
      }
    },
    [sandboxId, token],
  );

  const isActive = info ? ACTIVE_STATUSES.includes(info.status) : false;
  const isStopping = info?.status === "stopping" || info?.status === "destroyed";

  const statusLabel = useMemo(() => {
    if (!info) return "Starting...";
    const labels: Record<SandboxStatus, string> = {
      idle: "Idle",
      preparing: "Preparing sandbox",
      creating: "Creating isolated environment",
      starting: "Starting browser",
      loading_extension: "Loading extension",
      ready: "Sandbox ready",
      running: "Running",
      stopping: "Stopping",
      completed: "Completed",
      failed: "Failed",
      timeout: "Timed out",
      destroyed: "Destroyed",
    };
    return labels[info.status];
  }, [info]);

  if (fatalError) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="card card-pad mx-auto max-w-xl text-center"
      >
        <span className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--status-error-soft)] text-[var(--status-error)]">
          <WifiOff className="h-7 w-7" aria-hidden="true" />
        </span>
        <h2 className="mt-5 text-2xl font-semibold tracking-tight">
          Sandbox unavailable
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-[var(--text-secondary)]">
          {fatalError} The isolated environment could not be started or was
          destroyed. This is a real backend status — no runtime results were
          simulated.
        </p>
        <a
          href="/dashboard"
          className="mt-6 inline-flex min-h-[44px] items-center gap-2 rounded-full bg-[var(--accent)] px-5 text-sm font-medium text-[var(--accent-foreground)] hover:bg-[var(--accent-hover)]"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to Analysis
        </a>
      </motion.div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          <span className="inline-flex h-3 w-3 rounded-full bg-[var(--accent)]" aria-hidden="true">
            <span className="sr-only">Live</span>
          </span>
          <div>
            <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
              Extension Sandbox
            </h1>
            <p className="text-sm text-[var(--text-secondary)]">{statusLabel}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void sendCommand("reload")}
            disabled={!isActive}
          >
            <RotateCw className="h-4 w-4" aria-hidden="true" />
            Reload Page
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void sendCommand("restart")}
            disabled={!isActive}
          >
            <Activity className="h-4 w-4" aria-hidden="true" />
            Restart Extension
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void sendCommand("clearConsole")}
            disabled={!isActive}
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            Clear Console
          </Button>
          <Button
            variant="accent"
            size="sm"
            onClick={() => void sendCommand("stop")}
            disabled={!isActive && !isStopping}
          >
            <Square className="h-4 w-4" aria-hidden="true" />
            Stop Sandbox
          </Button>
        </div>
      </div>

      {info?.status === "running" || info?.status === "ready" ? (
        <p className="flex items-center gap-2 rounded-xl bg-[var(--status-success-soft)] px-3 py-2 text-sm text-[var(--text-primary)]">
          <span className="inline-flex h-2 w-2 rounded-full bg-[var(--status-success)]" aria-hidden="true" />
          Sandbox active. Browser is running inside a disposable isolated container.
        </p>
      ) : null}

      <BrowserViewport
        screenshotUrl={screenshotUrl}
        status={statusLabel}
        testUrl={info?.testUrl ?? "https://example.com"}
        onRefresh={refreshScreenshot}
      />

      <div className="card overflow-hidden">
        <TesterTabs value={tab} onChange={setTab} />
        <div className="min-h-[260px] p-4 sm:p-5">
          {tab === "console" ? <ConsolePanel events={events} /> : null}
          {tab === "network" ? <NetworkPanel entries={network} /> : null}
          {tab === "extension" ? <ExtensionPanel info={info} events={events} /> : null}
          {tab === "events" ? <EventsPanel events={events} /> : null}
        </div>
      </div>

      {info?.status === "failed" || info?.status === "timeout" ? (
        <div className="flex items-center gap-3 rounded-xl border border-[var(--status-error)] bg-[var(--status-error-soft)] p-4 text-sm">
          <AlertTriangle className="h-5 w-5 shrink-0 text-[var(--status-error)]" aria-hidden="true" />
          <p>
            {info.status === "timeout"
              ? "Sandbox timed out. The environment was automatically destroyed."
              : info.reason ?? "Sandbox failed."}{" "}
            Reference: {info.referenceId}
          </p>
        </div>
      ) : null}
    </div>
  );
}

function TesterTabs({
  value,
  onChange,
}: {
  value: TesterTab;
  onChange: (value: TesterTab) => void;
}) {
  const tabs: Array<{ key: TesterTab; label: string }> = [
    { key: "console", label: "Console" },
    { key: "network", label: "Network" },
    { key: "extension", label: "Extension" },
    { key: "events", label: "Events" },
  ];
  return (
    <div
      role="tablist"
      aria-label="Runtime panels"
      className="flex overflow-x-auto border-b border-[var(--border)] bg-[var(--surface-secondary)] px-2"
    >
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          aria-selected={value === tab.key}
          onClick={() => onChange(tab.key)}
          className={`min-h-[48px] whitespace-nowrap border-b-2 px-4 text-sm font-medium transition-colors ${
            value === tab.key
              ? "border-[var(--accent)] text-[var(--text-primary)]"
              : "border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          }`}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
