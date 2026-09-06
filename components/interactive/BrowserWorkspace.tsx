"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Camera,
  ChevronDown,
  CircleSlash,
  Clock,
  Eraser,
  Globe,
  Lock,
  Monitor,
  Puzzle,
  RefreshCw,
  RotateCw,
  Search,
  Square,
  Sparkles,
  WifiOff,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { PaywallNotice, paywallFromError, type PaywallInfo } from "@/components/billing/PaywallNotice";
import { BrowserCanvas } from "./BrowserCanvas";
import { ConsolePanel, EvidencePanel, ExtensionPanel, NetworkPanel, ScreenshotsPanel, TimelinePanel, formatTime } from "./panels";
import { mapPointerToViewport } from "@/lib/interactive/coordinates";
import { cn } from "@/lib/utils";
import type {
  BrowserInputAction,
  ConsoleEntryView,
  ElementInspectionView,
  InteractiveBrowserSessionView,
  InteractiveSessionEventView,
  NetworkEntryView,
  ScreenshotArtifactView,
  SessionEvidenceView,
} from "@/types/interactive";
import type { AIResponseEnvelope } from "@/lib/ai/types";

/* eslint-disable @next/next/no-img-element */

/**
 * Extension Testing Workspace (Phase 12).
 *
 * The canvas shows PNG frames captured from the REAL disposable Chromium
 * container; pointer/keyboard input is translated into the typed allowlisted
 * API and dispatched into that same container. Extension popups render inside
 * the container. Evidence references real runtime records; tests are created
 * through the Phase 4 schema; AI is an explanation layer only. Nothing here
 * renders extension HTML, speaks CDP, or executes script.
 */

type Tab = "console" | "network" | "extension" | "timeline" | "screenshots" | "evidence";

const LIVE_STATUSES = ["READY", "ACTIVE", "IDLE"];
const TERMINAL = ["STOPPED", "EXPIRED", "FAILED"];

const VIEWPORT_PRESETS = [
  { id: "desktop", label: "Desktop", width: 1280, height: 800 },
  { id: "tablet", label: "Tablet", width: 834, height: 1000 },
  { id: "compact", label: "Compact", width: 640, height: 480 },
] as const;

type RecipeStepDraft =
  | { kind: "navigate"; url: string }
  | { kind: "click"; selector: string }
  | { kind: "type"; selector: string; text: string }
  | { kind: "assert_element"; selector: string }
  | { kind: "wait"; milliseconds: number }
  | { kind: "screenshot" };

interface WorkspaceState {
  session: InteractiveBrowserSessionView;
  console: ConsoleEntryView[];
  network: NetworkEntryView[];
  events: InteractiveSessionEventView[];
  artifacts: ScreenshotArtifactView[];
  evidence: SessionEvidenceView[];
  /** artifact id -> screenshot evidence id, derived from the evidence list. */
  screenshotEvidence: Record<string, string>;
}

export function BrowserWorkspace({ initialSession }: { initialSession: InteractiveBrowserSessionView }) {
  const [state, setState] = useState<WorkspaceState>({
    session: initialSession,
    console: [],
    network: [],
    events: [],
    artifacts: [],
    evidence: [],
    screenshotEvidence: {},
  });
  const [tab, setTab] = useState<Tab>("console");
  const [connection, setConnection] = useState<"connecting" | "live" | "reconnecting" | "closed">("connecting");
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [popupUrl, setPopupUrl] = useState<string | null>(null);
  const [addressValue, setAddressValue] = useState(initialSession.currentUrl ?? "");
  const [navigating, setNavigating] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [paywall, setPaywall] = useState<PaywallInfo | null>(null);
  const [countdown, setCountdown] = useState<number>(0);
  const [inspectMode, setInspectMode] = useState(false);
  const [inspection, setInspection] = useState<ElementInspectionView | null>(null);
  const [recipeOpen, setRecipeOpen] = useState(false);
  const [recipeSteps, setRecipeSteps] = useState<RecipeStepDraft[]>([]);
  const [recipeName, setRecipeName] = useState("");
  const [aiResult, setAiResult] = useState<{ title: string; envelope: AIResponseEnvelope } | null>(null);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);

  const addStep = useCallback((step: RecipeStepDraft) => {
    setRecipeSteps((steps) => [...steps, step].slice(-24));
  }, []);

  const sessionRef = useRef(initialSession);
  sessionRef.current = state.session;
  const frameUrlRef = useRef<string | null>(null);
  const popupUrlRef = useRef<string | null>(null);
  const lastWheelRef = useRef(0);
  const popupRef = useRef<HTMLDivElement | null>(null);
  const sessionId = initialSession.id;

  const session = state.session;
  const isLive = LIVE_STATUSES.includes(session.status);
  const isTerminal = TERMINAL.includes(session.status);

  useEffect(() => {
    setAddressValue((current) => (session.currentUrl && session.currentUrl !== "about:blank" ? session.currentUrl : current));
  }, [session.currentUrl]);

  // --- helpers ------------------------------------------------------------

  const api = useCallback(async (path: string, init?: RequestInit) => {
    const response = await fetch(`/api/browser-sessions/${sessionRef.current.id}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const wall = paywallFromError(body);
      if (wall) setPaywall(wall);
      const message = body?.error?.message ?? "The request failed.";
      throw Object.assign(new Error(message), { body });
    }
    return body;
  }, []);

  const syncSession = useCallback((view: InteractiveBrowserSessionView) => {
    setState((current) => ({ ...current, session: view }));
  }, []);

  // --- live stream + reconnection (same session, never a new one) ---------

  useEffect(() => {
    if (isTerminal) {
      setConnection("closed");
      return;
    }
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const connect = () => {
      source = new EventSource(`/api/browser-sessions/${sessionId}/events/stream`);
      source.addEventListener("state", (event) => {
        setConnection("live");
        try {
          syncSession(JSON.parse((event as MessageEvent).data) as InteractiveBrowserSessionView);
        } catch {
          // Ignore malformed frames.
        }
      });
      source.addEventListener("console", (event) => {
        try {
          const data = JSON.parse((event as MessageEvent).data) as { entries?: ConsoleEntryView[] };
          if (Array.isArray(data.entries)) setState((current) => ({ ...current, console: data.entries as ConsoleEntryView[] }));
        } catch {
          // Ignore malformed frames.
        }
      });
      source.addEventListener("network", (event) => {
        try {
          const data = JSON.parse((event as MessageEvent).data) as { entries?: NetworkEntryView[] };
          if (Array.isArray(data.entries)) setState((current) => ({ ...current, network: data.entries as NetworkEntryView[] }));
        } catch {
          // Ignore malformed frames.
        }
      });
      source.addEventListener("events", (event) => {
        try {
          const data = JSON.parse((event as MessageEvent).data) as { events?: InteractiveSessionEventView[] };
          if (Array.isArray(data.events)) setState((current) => ({ ...current, events: data.events as InteractiveSessionEventView[] }));
        } catch {
          // Ignore malformed frames.
        }
      });
      source.onopen = () => setConnection("live");
      source.onerror = () => {
        setConnection("reconnecting");
        if (source && source.readyState === EventSource.CLOSED && !stopped) {
          retry = setTimeout(connect, 3000);
        }
      };
    };
    connect();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      source?.close();
    };
  }, [sessionId, isTerminal, syncSession]);

  // --- keepalive (never extends the hard lifetime) --------------------------

  useEffect(() => {
    if (isTerminal) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void api("/keepalive", { method: "POST", body: "{}" })
        .then((body) => {
          if (body?.session) syncSession(body.session);
        })
        .catch(() => undefined);
    }, 30_000);
    return () => clearInterval(timer);
  }, [api, isTerminal, syncSession]);

  // --- lifetime countdown ---------------------------------------------------

  useEffect(() => {
    const timer = setInterval(() => {
      setCountdown(Math.max(0, Math.round((sessionRef.current.expiresAt - Date.now()) / 1000)));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // --- frame polling (newest frame wins; stale frames drop) ----------------

  const pollFrames = useCallback(async (target: "page" | "popup") => {
    try {
      const response = await fetch(`/api/browser-sessions/${sessionRef.current.id}/screenshot?target=${target}&t=${Date.now()}`);
      if (!response.ok) return;
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      if (target === "page") {
        if (frameUrlRef.current?.startsWith("blob:")) URL.revokeObjectURL(frameUrlRef.current);
        frameUrlRef.current = url;
        setFrameUrl(url);
      } else {
        if (popupUrlRef.current?.startsWith("blob:")) URL.revokeObjectURL(popupUrlRef.current);
        popupUrlRef.current = url;
        setPopupUrl(url);
      }
    } catch {
      // Transient frame failures keep the previous frame.
    }
  }, []);

  useEffect(() => {
    if (!isLive) return;
    const interval = Math.max(400, session.limits.frameIntervalMs);
    let stopped = false;
    let inFlight = false;
    const tick = async () => {
      if (stopped || inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      await pollFrames("page");
      if (sessionRef.current.popupOpen) await pollFrames("popup");
      inFlight = false;
    };
    void tick();
    const timer = setInterval(tick, interval);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [isLive, pollFrames, session.limits.frameIntervalMs, session.id]);

  useEffect(() => {
    if (!session.popupOpen) {
      if (popupUrlRef.current?.startsWith("blob:")) URL.revokeObjectURL(popupUrlRef.current);
      popupUrlRef.current = null;
      setPopupUrl(null);
    }
  }, [session.popupOpen]);

  // --- input ----------------------------------------------------------------

  const sendInput = useCallback(
    async (action: BrowserInputAction) => {
      try {
        await api("/input", { method: "POST", body: JSON.stringify({ action }) });
      } catch (error) {
        setNotice({ kind: "error", text: error instanceof Error ? error.message : "The input action failed." });
      }
    },
    [api],
  );

  // Explicit, user-initiated paste: read once, size-capped, sent as a normal
  // type_text action. Clipboard contents are never logged or persisted here.
  const pasteFromClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text.length > 2000) {
        setNotice({ kind: "error", text: "Clipboard content exceeds the 2000-character typing limit." });
        return;
      }
      if (text.length === 0) return;
      await sendInput({ type: "type_text", text, target: "page" });
    } catch {
      setNotice({ kind: "error", text: "Clipboard access was denied by the browser." });
    }
  }, [sendInput]);

  // --- navigation -----------------------------------------------------------

  const navigate = useCallback(async (op: "navigate" | "back" | "forward" | "reload", url?: string) => {
    setNavigating(true);
    setNotice(null);
    try {
      const body = await api("/navigate", {
        method: "POST",
        body: JSON.stringify(op === "navigate" ? { op, url } : { op }),
      });
      if (body?.session) {
        syncSession(body.session);
        setAddressValue(body.session.currentUrl ?? url ?? "");
      }
      if (op === "navigate" && url) addStep({ kind: "navigate", url });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Navigation failed." });
    } finally {
      setNavigating(false);
    }
  }, [api, syncSession, addStep]);

  // --- inspection -----------------------------------------------------------

  const runInspect = useCallback(
    async (x: number, y: number) => {
      try {
        const body = await api("/inspect", { method: "POST", body: JSON.stringify({ x, y, target: "page" }) });
        if (body?.inspection) setInspection(body.inspection as ElementInspectionView);
      } catch (error) {
        setNotice({ kind: "error", text: error instanceof Error ? error.message : "The element could not be inspected." });
      }
    },
    [api],
  );

  // --- popup ------------------------------------------------------------------

  const openPopup = async () => {
    setBusy("popup");
    try {
      const body = await api("/popup", { method: "POST", body: JSON.stringify({ op: "open" }) });
      if (body?.session) syncSession(body.session);
      await pollFrames("popup");
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "The popup could not be opened." });
    } finally {
      setBusy(null);
    }
  };

  const closePopup = async () => {
    setBusy("popup");
    try {
      const body = await api("/popup", { method: "POST", body: JSON.stringify({ op: "close" }) });
      if (body?.session) syncSession(body.session);
    } catch {
      // Closing is best-effort; the sweep also closes popups on expiry.
    } finally {
      setBusy(null);
    }
  };

  const popupPoint = (event: { clientX: number; clientY: number }) => {
    const element = popupRef.current;
    const size = session.popupSize ?? { width: 380, height: 480 };
    if (!element) return null;
    return mapPointerToViewport({
      clientX: event.clientX,
      clientY: event.clientY,
      rect: element.getBoundingClientRect(),
      viewportWidth: size.width,
      viewportHeight: size.height,
    });
  };

  const onPopupKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key.length === 1) {
      event.preventDefault();
      void sendInput({ type: "type_text", text: event.key, target: "popup" });
      return;
    }
    const named = ["Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"];
    if (named.includes(event.key)) {
      event.preventDefault();
      void sendInput({ type: "key_press", key: event.key, target: "popup" });
    }
  };

  // --- session controls -------------------------------------------------------

  const reloadExtension = async () => {
    setBusy("reload");
    try {
      const body = await api("/extension/reload", { method: "POST", body: "{}" });
      if (body?.session) syncSession(body.session);
      setNotice({ kind: "info", text: "Extension reloaded from the original package." });
      setTimeout(() => void pollFrames("page"), 1200);
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "The extension could not be reloaded." });
    } finally {
      setBusy(null);
    }
  };

  const restartBrowser = async () => {
    setSessionMenuOpen(false);
    setBusy("restart");
    try {
      const body = await api("/restart", { method: "POST", body: "{}" });
      if (body?.session) syncSession(body.session);
      setNotice({ kind: "info", text: "Browser restarted from the verified package; extension reload confirmed." });
      setTimeout(() => void pollFrames("page"), 1500);
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "The browser could not be restarted." });
    } finally {
      setBusy(null);
    }
  };

  const clearBrowserState = async () => {
    setClearConfirmOpen(false);
    setSessionMenuOpen(false);
    setBusy("clear");
    try {
      const body = await api("/clear-state", { method: "POST", body: "{}" });
      if (body?.session) syncSession(body.session);
      setNotice({ kind: "info", text: "Disposable browser state cleared. Your ExtensionLab data is untouched." });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Browser state could not be cleared." });
    } finally {
      setBusy(null);
    }
  };

  const stopSession = async () => {
    setSessionMenuOpen(false);
    setBusy("stop");
    try {
      const body = await api("/stop", { method: "POST", body: "{}" });
      if (body?.session) syncSession(body.session);
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "The session could not be stopped." });
    } finally {
      setBusy(null);
    }
  };

  const capture = async () => {
    setSessionMenuOpen(false);
    setBusy("capture");
    try {
      const body = await api("/screenshot", { method: "POST", body: "{}" });
      if (body?.artifact) {
        setState((current) => ({ ...current, artifacts: [body.artifact, ...current.artifacts] }));
        setNotice({ kind: "info", text: "Screenshot saved to this session's artifacts." });
      }
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "The screenshot could not be captured." });
    } finally {
      setBusy(null);
    }
  };

  const applyViewportPreset = async (preset: (typeof VIEWPORT_PRESETS)[number]) => {
    try {
      const body = await api("/viewport", { method: "POST", body: JSON.stringify({ width: preset.width, height: preset.height }) });
      if (body?.session) syncSession(body.session);
      setTimeout(() => void pollFrames("page"), 600);
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "The viewport could not be changed." });
    }
  };

  // --- evidence ---------------------------------------------------------------

  const refreshEvidence = useCallback(async () => {
    try {
      const body = await api("/evidence");
      if (Array.isArray(body?.evidence)) {
        const list = body.evidence as SessionEvidenceView[];
        const map: Record<string, string> = {};
        for (const item of list) if (item.kind === "screenshot" && item.refId) map[item.refId] = item.id;
        setState((current) => ({ ...current, evidence: list, screenshotEvidence: map }));
      }
    } catch {
      // Evidence list is a secondary view.
    }
  }, [api]);

  const refreshArtifacts = useCallback(async () => {
    try {
      const body = await api("/artifacts");
      if (Array.isArray(body?.artifacts)) setState((current) => ({ ...current, artifacts: body.artifacts }));
    } catch {
      // Artifacts are a secondary view.
    }
  }, [api]);

  useEffect(() => {
    if (tab === "screenshots") void refreshArtifacts();
    if (tab === "evidence") void refreshEvidence();
  }, [tab, refreshArtifacts, refreshEvidence]);

  const saveEvidence = useCallback(
    async (kind: "console" | "network" | "event" | "screenshot", refId: string | null, detail: string, metadata: Record<string, string | number | boolean | null> = {}) => {
      try {
        const body = await api("/evidence", { method: "POST", body: JSON.stringify({ kind, refId, detail, metadata }) });
        setNotice({ kind: "info", text: "Saved as evidence." });
        void refreshEvidence();
        return (body?.evidence as SessionEvidenceView | undefined) ?? null;
      } catch (error) {
        setNotice({ kind: "error", text: error instanceof Error ? error.message : "The evidence could not be saved." });
        return null;
      }
    },
    [api, refreshEvidence],
  );

  const attachEvidence = useCallback(
    async (evidenceId: string) => {
      try {
        const body = await api(`/evidence/${evidenceId}/report`, { method: "POST", body: JSON.stringify({}) });
        if (body?.evidence) {
          setState((current) => ({
            ...current,
            evidence: current.evidence.map((item) => (item.id === evidenceId ? (body.evidence as SessionEvidenceView) : item)),
          }));
          setNotice({ kind: "info", text: "Evidence attached to a report." });
        }
      } catch (error) {
        setNotice({ kind: "error", text: error instanceof Error ? error.message : "The evidence could not be attached." });
      }
    },
    [api],
  );

  const deleteEvidence = useCallback(
    async (evidenceId: string) => {
      try {
        await api(`/evidence/${evidenceId}`, { method: "DELETE" });
        setState((current) => ({
          ...current,
          evidence: current.evidence.filter((item) => item.id !== evidenceId),
          screenshotEvidence: Object.fromEntries(
            Object.entries(current.screenshotEvidence).filter(([, id]) => id !== evidenceId),
          ),
        }));
      } catch (error) {
        setNotice({ kind: "error", text: error instanceof Error ? error.message : "The evidence could not be deleted." });
      }
    },
    [api],
  );

  // --- tests -------------------------------------------------------------------

  const runTest = async () => {
    setBusy("runtest");
    try {
      const body = await api("/run-test", { method: "POST", body: "{}" });
      if (body?.runId) {
        setNotice({ kind: "info", text: `Automated test run queued (${body.runId}). Open it from Recent test runs.` });
      }
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "The test run could not be started." });
    } finally {
      setBusy(null);
    }
  };

  const saveRecipe = async () => {
    setBusy("recipe");
    try {
      await api("/test-recipe", {
        method: "POST",
        body: JSON.stringify({ name: recipeName, actions: recipeSteps, confirm: true }),
      });
      setRecipeOpen(false);
      setRecipeSteps([]);
      setRecipeName("");
      setNotice({ kind: "info", text: "Test saved from session actions (validated against the Phase 4 schema)." });
      void refreshEvidence();
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "The test could not be saved." });
    } finally {
      setBusy(null);
    }
  };

  // --- AI (explanation layer only) ----------------------------------------------

  const runAI = async (path: "ai/explain" | "ai/summary", title: string, body: Record<string, unknown>) => {
    setBusy("ai");
    try {
      const result = await api(`/${path}`, { method: "POST", body: JSON.stringify(body) });
      setAiResult({ title, envelope: result as AIResponseEnvelope });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "The AI request failed." });
    } finally {
      setBusy(null);
    }
  };

  // --- crash recovery -------------------------------------------------------------

  const startNewSession = async () => {
    setBusy("newsession");
    try {
      const createResponse = await fetch("/api/browser-sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ packageId: session.packageId }),
      });
      const created = await createResponse.json().catch(() => null);
      if (!createResponse.ok || !created?.session?.id) {
        const wall = paywallFromError(created);
        if (wall) setPaywall(wall);
        throw new Error(created?.error?.message ?? "A new session could not be created.");
      }
      await fetch(`/api/browser-sessions/${created.session.id}/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      window.location.href = `/dashboard/browser/${created.session.id}`;
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "A new session could not be created." });
      setBusy(null);
    }
  };

  // --- rendering ----------------------------------------------------------------

  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: "console", label: "Console", count: state.console.length },
    { id: "network", label: "Network", count: state.network.length },
    { id: "extension", label: "Extension" },
    { id: "timeline", label: "Timeline", count: state.events.length + state.console.length + state.network.length },
    { id: "screenshots", label: "Screenshots", count: state.artifacts.length },
    { id: "evidence", label: "Evidence", count: state.evidence.length },
  ];

  const backHref = session.projectId ? `/dashboard/extensions/${session.projectId}` : "/dashboard";
  const crashed = isTerminal && session.failureKind === "browser_crash";

  const terminalOverlay = isTerminal ? (
    <div className="max-w-sm">
      <TerminalState session={session} />
      {crashed || session.status === "FAILED" ? (
        <div className="mt-4 flex justify-center">
          <Button variant="accent" size="sm" onClick={() => void startNewSession()} loading={busy === "newsession"}>
            <RotateCw className="h-4 w-4" aria-hidden="true" />
            Start New Session
          </Button>
        </div>
      ) : null}
    </div>
  ) : undefined;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow">Extension Testing Workspace</p>
          <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight">
            {session.extension.name ?? session.packageName ?? "Extension"}
            {session.packageVersion ? <span className="text-[var(--text-secondary)]"> v{session.packageVersion}</span> : null}
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--text-secondary)]">
            <span className="inline-flex items-center gap-1">
              <Globe className="h-3.5 w-3.5" aria-hidden="true" />
              {labelForBrowser(session.browser)} {session.browserVersion ?? ""}
            </span>
            <span className="inline-flex items-center gap-1 font-mono" title={`SHA-256 ${session.packageSha256}`}>
              {session.packageSha256.slice(0, 12)}…
            </span>
            <span className="inline-flex items-center gap-1">
              <Clock className="h-3.5 w-3.5" aria-hidden="true" />
              {formatCountdown(countdown)} remaining
            </span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ExtensionStatusBadge status={session.extensionRuntimeStatus} />
          <StatusPill status={session.status} connection={connection} />
          {isLive || session.status === "STOPPING" ? (
            <SessionMenu
              open={sessionMenuOpen}
              setOpen={setSessionMenuOpen}
              busy={busy}
              onRestart={() => void restartBrowser()}
              onClearState={() => setClearConfirmOpen(true)}
              onCapture={() => void capture()}
              onStop={() => void stopSession()}
            />
          ) : null}
          {!isTerminal ? null : (
            <Link href={backHref} className="text-sm font-medium text-[var(--accent)]">
              Back to project
            </Link>
          )}
        </div>
      </div>

      {paywall ? <PaywallNotice info={paywall} /> : null}
      {notice ? (
        <div
          role="status"
          className={cn(
            "flex items-start gap-2 rounded-xl border px-4 py-3 text-sm",
            notice.kind === "error"
              ? "border-[var(--status-error)]/40 bg-[var(--surface-secondary)]"
              : "border-[var(--border)] bg-[var(--surface-secondary)]",
          )}
        >
          {notice.kind === "error" ? (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--status-error)]" aria-hidden="true" />
          ) : null}
          <span className="min-w-0 flex-1">{notice.text}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss message" className="text-[var(--text-secondary)]">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {/* Browser chrome */}
      <div className="card overflow-hidden">
        <div className="flex flex-wrap items-center gap-1.5 border-b border-[var(--border)] bg-[var(--surface-secondary)] px-2 py-2">
          <button type="button" onClick={() => void navigate("back")} disabled={!isLive || navigating} aria-label="Go back"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface)] hover:text-[var(--text-primary)] disabled:opacity-40">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          </button>
          <button type="button" onClick={() => void navigate("forward")} disabled={!isLive || navigating} aria-label="Go forward"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface)] hover:text-[var(--text-primary)] disabled:opacity-40">
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </button>
          <button type="button" onClick={() => void navigate("reload")} disabled={!isLive || navigating} aria-label="Reload page"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface)] hover:text-[var(--text-primary)] disabled:opacity-40">
            <RefreshCw className={cn("h-4 w-4", navigating && "animate-spin")} aria-hidden="true" />
          </button>

          <form
            className="ml-1 flex min-w-[200px] flex-1 items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              if (addressValue.trim()) void navigate("navigate", addressValue.trim());
            }}
          >
            <Lock className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
            <label className="sr-only" htmlFor="ibrowser-address">Page address</label>
            <input
              id="ibrowser-address"
              value={addressValue}
              onChange={(event) => setAddressValue(event.target.value)}
              placeholder={isLive ? "Enter a public https:// address" : "The browser is not running"}
              disabled={!isLive}
              spellCheck={false}
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent font-mono text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-secondary)]"
            />
            {navigating ? <span className="text-xs text-[var(--text-secondary)]">loading…</span> : null}
            {addressValue ? (
              <button type="button" onClick={() => setAddressValue("")} aria-label="Clear address" className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            ) : null}
          </form>

          <button
            type="button"
            onClick={() => setInspectMode((mode) => !mode)}
            disabled={!isLive}
            aria-pressed={inspectMode}
            title="Inspect element (bounded metadata)"
            className={cn(
              "inline-flex h-9 w-9 items-center justify-center rounded-full transition-colors disabled:opacity-40",
              inspectMode ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "text-[var(--text-secondary)] hover:bg-[var(--surface)] hover:text-[var(--text-primary)]",
            )}
          >
            <Search className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => void pasteFromClipboard()}
            disabled={!isLive}
            aria-label="Paste text into the browser"
            title="Paste (explicit)"
            className="inline-flex h-9 items-center justify-center rounded-full px-2 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface)] hover:text-[var(--text-primary)] disabled:opacity-40"
          >
            Paste
          </button>
          <button
            type="button"
            onClick={() => void capture()}
            disabled={!isLive || busy === "capture"}
            aria-label="Capture screenshot artifact"
            title="Capture screenshot"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface)] hover:text-[var(--text-primary)] disabled:opacity-40"
          >
            <Camera className="h-4 w-4" aria-hidden="true" />
          </button>

          {/* Viewport presets */}
          <div className="hidden items-center gap-1 sm:flex" role="group" aria-label="Viewport preset">
            {VIEWPORT_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                onClick={() => void applyViewportPreset(preset)}
                disabled={!isLive}
                aria-pressed={session.viewport.width === preset.width && session.viewport.height === preset.height}
                className="rounded-full px-2.5 py-1 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface)] hover:text-[var(--text-primary)] disabled:opacity-40 aria-pressed:bg-[var(--accent-soft)] aria-pressed:text-[var(--accent)]"
              >
                {preset.label}
              </button>
            ))}
          </div>

          {/* Extension menu */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((open) => !open)}
              disabled={!isLive}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              aria-label="Extension menu"
              className="inline-flex h-9 items-center gap-1 rounded-full px-2.5 text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface)] hover:text-[var(--text-primary)] disabled:opacity-40"
            >
              <Puzzle className="h-4 w-4" aria-hidden="true" />
              <ChevronDown className="h-3 w-3" aria-hidden="true" />
            </button>
            {menuOpen ? (
              <div role="menu" className="absolute right-0 top-11 z-20 w-72 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-sm shadow-[var(--shadow-card)]">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-[var(--text-primary)]">{session.extension.name ?? "Extension"}</p>
                    <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
                      {session.extension.version ? `v${session.extension.version} · ` : ""}
                      {session.extension.manifestVersion ?? "Manifest"}
                    </p>
                  </div>
                  <ExtensionStatusBadge status={session.extensionRuntimeStatus} />
                </div>
                <dl className="mt-2 space-y-1 text-xs text-[var(--text-secondary)]">
                  <div className="flex justify-between"><dt>Popup</dt><dd>{session.extension.popupPath ? "Available" : "None"}</dd></div>
                  <div className="flex justify-between"><dt>Service worker</dt><dd>{session.extension.hasServiceWorker ? "Declared" : "—"}</dd></div>
                  <div className="flex justify-between"><dt>Content scripts</dt><dd>{session.extension.hasContentScripts ? "Declared" : "—"}</dd></div>
                </dl>
                <div className="mt-3 space-y-2">
                  <Button variant="secondary" size="sm" fullWidth
                    onClick={() => { setMenuOpen(false); void openPopup(); }}
                    loading={busy === "popup" && !session.popupOpen}
                    disabled={!session.extension.popupPath}
                    title={session.extension.popupPath ? undefined : "This extension does not declare a popup"}
                  >
                    {session.popupOpen ? "Popup is open" : "Open Popup"}
                  </Button>
                  <Button variant="secondary" size="sm" fullWidth
                    onClick={() => { setMenuOpen(false); void reloadExtension(); }}
                    loading={busy === "reload"}
                  >
                    Reload Extension
                  </Button>
                  <Button variant="ghost" size="sm" fullWidth
                    onClick={() => { setMenuOpen(false); setTab("extension"); }}
                  >
                    Details
                  </Button>
                </div>
                <p className="mt-3 border-t border-[var(--border)] pt-2 text-xs text-[var(--text-secondary)]">
                  Loads exactly {session.packageSha256.slice(0, 12)}… in the isolated browser.
                </p>
              </div>
            ) : null}
          </div>
        </div>

        {/* Viewport */}
        <BrowserCanvas
          frameUrl={frameUrl}
          viewport={session.viewport}
          disabled={!isLive}
          inspectMode={inspectMode}
          onInput={(action) => void sendInput(action)}
          onInspect={(x, y) => void runInspect(x, y)}
          onPaste={() => void pasteFromClipboard()}
          overlays={{
            live: isLive,
            loading: session.status === "STARTING" || session.status === "QUEUED",
            reconnecting: connection === "reconnecting" || connection === "connecting",
            overlay: isTerminal
              ? terminalOverlay
              : session.status === "STARTING" || session.status === "QUEUED"
                ? <StartingState session={session} />
                : connection === "reconnecting"
                  ? <ReconnectingState />
                  : undefined,
          }}
        />

        {/* Real extension popup, rendered by the container browser */}
        {session.popupOpen && popupUrl ? (
          <div className="absolute bottom-6 left-6 z-10 max-w-[380px] rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)]">
            <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-3 py-1.5">
              <span className="text-xs font-medium text-[var(--text-secondary)]">{session.extension.name ?? "Extension"} popup</span>
              <button type="button" onClick={() => void closePopup()} aria-label="Close extension popup"
                className="inline-flex h-6 w-6 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-secondary)]">
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
            <div
              ref={popupRef}
              role="application"
              aria-label="Extension popup inside the isolated browser"
              tabIndex={0}
              onClick={(event) => {
                const point = popupPoint(event);
                if (point) void sendInput({ type: "click", x: point.x, y: point.y, target: "popup" });
              }}
              onWheel={(event) => {
                event.preventDefault();
                const now = Date.now();
                if (now - lastWheelRef.current < 120) return;
                lastWheelRef.current = now;
                const point = popupPoint(event);
                if (!point) return;
                void sendInput({ type: "scroll", x: point.x, y: point.y, deltaX: Math.round(event.deltaX), deltaY: Math.round(event.deltaY), target: "popup" });
              }}
              onKeyDown={onPopupKeyDown}
              className="select-none focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
              style={{ width: Math.min(session.popupSize?.width ?? 380, 380), height: Math.min(session.popupSize?.height ?? 480, 480) }}
            >
              <img src={popupUrl} alt="Extension popup rendered by the isolated browser" draggable={false}
                className="pointer-events-none h-full w-full object-fill" />
            </div>
          </div>
        ) : null}
      </div>

      {/* Inspection result */}
      {inspection ? <InspectionCard inspection={inspection} onClose={() => setInspection(null)} onAddStep={addStep} /> : null}

      {/* Workspace actions */}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" onClick={() => setRecipeOpen(true)}>
          Create test from actions{recipeSteps.length ? ` (${recipeSteps.length})` : ""}
        </Button>
        <Button variant="secondary" size="sm" onClick={() => void runTest()} loading={busy === "runtest"} disabled={isTerminal}>
          Run Test
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void runAI("ai/summary", "Session summary", {})} loading={busy === "ai"} disabled={isTerminal}>
          <Sparkles className="h-4 w-4" aria-hidden="true" />
          Summarize Session
        </Button>
      </div>

      {/* Runtime panels */}
      <div className="card overflow-hidden">
        <div className="flex gap-1 overflow-x-auto border-b border-[var(--border)] bg-[var(--surface-secondary)] px-2" role="tablist" aria-label="Runtime panels">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              onClick={() => setTab(item.id)}
              className={cn(
                "whitespace-nowrap px-3 py-2.5 text-sm font-medium transition-colors",
                tab === item.id
                  ? "border-b-2 border-[var(--accent)] text-[var(--text-primary)]"
                  : "border-b-2 border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]",
              )}
            >
              {item.label}
              {typeof item.count === "number" && item.count > 0 ? (
                <span className="ml-1.5 text-xs text-[var(--text-secondary)]">{item.count}</span>
              ) : null}
            </button>
          ))}
        </div>
        <div className="max-h-[380px] overflow-y-auto p-3">
          {tab === "console" ? (
            <ConsolePanel
              entries={state.console}
              onSaveEvidence={(refId, detail, source) => void saveEvidence("console", refId, detail, { source })}
              onExplain={(entry) => void runAI("ai/explain", "AI interpretation", { entryId: entry.id })}
            />
          ) : null}
          {tab === "network" ? (
            <NetworkPanel entries={state.network} onSaveEvidence={(refId, detail, url) => void saveEvidence("network", refId, detail, { url: url.slice(0, 200) })} />
          ) : null}
          {tab === "extension" ? <ExtensionPanel session={session} onReload={() => void reloadExtension()} busy={busy === "reload"} /> : null}
          {tab === "timeline" ? (
            <TimelinePanel
              events={state.events}
              consoleEntries={state.console}
              networkEntries={state.network}
              onSaveEvidence={(refId, detail) => void saveEvidence("event", refId, detail)}
            />
          ) : null}
          {tab === "screenshots" ? (
            <ScreenshotsPanel
              artifacts={state.artifacts}
              sessionId={session.id}
              onCapture={() => void capture()}
              onAttach={(artifactId) => void saveEvidence("screenshot", artifactId, "Screenshot artifact", {})}
              evidenceByArtifact={state.screenshotEvidence}
              onDeleteEvidence={(artifactId) => {
                const evidenceId = state.screenshotEvidence[artifactId];
                if (evidenceId) void deleteEvidence(evidenceId);
              }}
              busy={busy === "capture"}
            />
          ) : null}
          {tab === "evidence" ? <EvidencePanel evidence={state.evidence} onAttach={(id) => void attachEvidence(id)} onDelete={(id) => void deleteEvidence(id)} /> : null}
        </div>
      </div>

      {/* Clear-state confirmation */}
      <Modal open={clearConfirmOpen} onClose={() => setClearConfirmOpen(false)} title="Clear browser state?"
        description="This clears cookies and storage inside THIS disposable browser only. It never touches your real browser, other sessions, or ExtensionLab data.">
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => setClearConfirmOpen(false)}>Cancel</Button>
          <Button variant="secondary" size="sm" onClick={() => void clearBrowserState()} loading={busy === "clear"}>
            <Eraser className="h-4 w-4" aria-hidden="true" />
            Clear state
          </Button>
        </div>
      </Modal>

      {/* Test recipe builder */}
      <Modal open={recipeOpen} onClose={() => setRecipeOpen(false)} title="Create test from actions"
        description="Steps are validated against the Phase 4 test schema (safe selectors, safe URLs). Nothing is saved until you confirm.">
        <div className="mt-3 space-y-3 text-sm">
          <div>
            <label htmlFor="recipe-name" className="text-xs font-medium text-[var(--text-secondary)]">Test name</label>
            <input id="recipe-name" value={recipeName} onChange={(event) => setRecipeName(event.target.value)} placeholder="e.g. Login flow smoke test"
              className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm outline-none focus-visible:outline-2 focus-visible:outline-[var(--accent)]" />
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => addStep({ kind: "wait", milliseconds: 500 })}
              className="rounded-full border border-[var(--border)] px-2.5 py-1 text-xs hover:bg-[var(--surface-secondary)]">+ Wait 500ms</button>
            <button type="button" onClick={() => addStep({ kind: "screenshot" })}
              className="rounded-full border border-[var(--border)] px-2.5 py-1 text-xs hover:bg-[var(--surface-secondary)]">+ Screenshot</button>
          </div>
          {recipeSteps.length === 0 ? (
            <p className="rounded-lg border border-dashed border-[var(--border)] px-3 py-6 text-center text-xs text-[var(--text-secondary)]">
              No steps yet. Navigate, or use Inspect to add clicks, typing and assertions.
            </p>
          ) : (
            <ol className="space-y-1" aria-label="Draft test steps">
              {recipeSteps.map((step, index) => (
                <li key={index} className="flex items-center justify-between gap-2 rounded-lg bg-[var(--surface-secondary)] px-3 py-1.5 font-mono text-xs">
                  <span className="min-w-0 truncate">
                    {index + 1}. {describeStep(step)}
                  </span>
                  <button type="button" aria-label={`Remove step ${index + 1}`} onClick={() => setRecipeSteps((steps) => steps.filter((_, i) => i !== index))}
                    className="text-[var(--text-secondary)] hover:text-[var(--status-error)]">
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ol>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setRecipeOpen(false)}>Cancel</Button>
            <Button variant="accent" size="sm" onClick={() => void saveRecipe()} loading={busy === "recipe"} disabled={recipeSteps.length === 0 || recipeName.trim().length === 0}>
              Save test
            </Button>
          </div>
        </div>
      </Modal>

      {/* AI result */}
      <Modal open={aiResult !== null} onClose={() => setAiResult(null)} title={aiResult?.title ?? ""}
        description="AI interpretation — separate from ExtensionLab's verified evidence.">
        <div className="mt-3 space-y-3 text-sm">
          {aiResult ? <AIResultBody envelope={aiResult.envelope} /> : null}
        </div>
      </Modal>
    </div>
  );
}

// --- small view helpers -------------------------------------------------------

function describeStep(step: RecipeStepDraft): string {
  switch (step.kind) {
    case "navigate": return `open ${step.url.slice(0, 60)}`;
    case "click": return `click ${step.selector}`;
    case "type": return `type into ${step.selector}: "${step.text.slice(0, 30)}"`;
    case "assert_element": return `assert exists ${step.selector}`;
    case "wait": return `wait ${step.milliseconds}ms`;
    case "screenshot": return "capture screenshot";
  }
}

function AIResultBody({ envelope }: { envelope: AIResponseEnvelope }) {
  const result = envelope.result as unknown as Record<string, unknown>;
  const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  return (
    <div className="space-y-3">
      <p className="font-medium">{text(result.summary) || text(result.headline) || text(result.answer)}</p>
      {text(result.meaning) ? <p className="text-[var(--text-secondary)]">{text(result.meaning)}</p> : null}
      {list(result.likelyCauses).length > 0 ? (
        <div><p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Likely causes</p>
          <ul className="mt-1 list-disc pl-5 text-sm">{list(result.likelyCauses).map((cause, index) => <li key={index}>{cause}</li>)}</ul></div>
      ) : null}
      {list(result.recommendations).length > 0 ? (
        <div><p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Recommendations</p>
          <ul className="mt-1 list-disc pl-5 text-sm">{list(result.recommendations).map((item, index) => <li key={index}>{item}</li>)}</ul></div>
      ) : null}
      {list(result.risks).length > 0 ? (
        <div><p className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Risks</p>
          <ul className="mt-1 list-disc pl-5 text-sm">{list(result.risks).map((item, index) => <li key={index}>{item}</li>)}</ul></div>
      ) : null}
      <p className="rounded-lg bg-[var(--surface-secondary)] px-3 py-2 text-xs text-[var(--text-secondary)]">{envelope.meta.disclaimer}</p>
    </div>
  );
}

function ExtensionStatusBadge({ status }: { status: string }) {
  const tone =
    status === "RUNNING" || status === "READY"
      ? "bg-[var(--status-success)]/15 text-[var(--status-success)]"
      : status === "ERROR"
        ? "bg-[var(--status-error)]/15 text-[var(--status-error)]"
        : status === "RELOADING" || status === "LOADING"
          ? "bg-[var(--status-warning)]/15 text-[var(--status-warning)]"
          : "bg-[var(--surface-secondary)] text-[var(--text-secondary)]";
  return <span className={cn("inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium", tone)}>{status}</span>;
}

function SessionMenu({
  open,
  setOpen,
  busy,
  onRestart,
  onClearState,
  onCapture,
  onStop,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
  busy: string | null;
  onRestart: () => void;
  onClearState: () => void;
  onCapture: () => void;
  onStop: () => void;
}) {
  return (
    <div className="relative">
      <Button variant="secondary" size="sm" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu">
        Session
        <ChevronDown className="h-3 w-3" aria-hidden="true" />
      </Button>
      {open ? (
        <div role="menu" className="absolute right-0 top-10 z-20 w-56 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1.5 text-sm shadow-[var(--shadow-card)]">
          <MenuItem onClick={onRestart} disabled={busy === "restart"} label={busy === "restart" ? "Restarting…" : "Restart Browser"} />
          <MenuItem onClick={onClearState} disabled={busy === "clear"} label="Clear Browser State" />
          <MenuItem onClick={onCapture} disabled={busy === "capture"} label="Capture Screenshot" />
          <div className="my-1 border-t border-[var(--border)]" />
          <MenuItem onClick={onStop} disabled={busy === "stop"} label={busy === "stop" ? "Stopping…" : "Stop Session"} danger />
        </div>
      ) : null}
    </div>
  );
}

function MenuItem({ onClick, disabled, label, danger }: { onClick: () => void; disabled?: boolean; label: string; danger?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "w-full rounded-lg px-3 py-1.5 text-left transition-colors hover:bg-[var(--surface-secondary)] disabled:opacity-50",
        danger ? "text-[var(--status-error)]" : "text-[var(--text-primary)]",
      )}
    >
      {label}
    </button>
  );
}

function InspectionCard({
  inspection,
  onClose,
  onAddStep,
}: {
  inspection: ElementInspectionView;
  onClose: () => void;
  onAddStep: (step: RecipeStepDraft) => void;
}) {
  const [typeValue, setTypeValue] = useState("");
  if (!inspection.exists) {
    return (
      <div className="card flex items-center justify-between gap-3 p-3 text-sm">
        <p className="text-[var(--text-secondary)]">No element at that position.</p>
        <button type="button" onClick={onClose} className="text-xs text-[var(--accent)]">Close</button>
      </div>
    );
  }
  return (
    <div className="card space-y-2 p-4 text-sm">
      <div className="flex items-start justify-between gap-2">
        <p className="font-mono text-xs">
          <span className="font-semibold">{inspection.tag ?? "element"}</span>
          {inspection.id ? <span className="text-[var(--accent)]"> #{inspection.id}</span> : null}
          {inspection.classes.slice(0, 3).map((cls) => <span key={cls} className="text-[var(--text-secondary)]"> .{cls}</span>)}
        </p>
        <button type="button" onClick={onClose} aria-label="Close inspection" className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>
      {inspection.textPreview ? <p className="break-words text-xs text-[var(--text-secondary)]">“{inspection.textPreview}”</p> : null}
      {inspection.isPassword ? <p className="text-xs text-[var(--status-warning)]">Password field — values are always redacted.</p> : null}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
        <div><dt className="text-[var(--text-secondary)]">Visible</dt><dd>{inspection.visible ? "yes" : "no"}</dd></div>
        <div><dt className="text-[var(--text-secondary)]">Rect</dt><dd className="font-mono">{inspection.rect ? `${inspection.rect.width}×${inspection.rect.height}` : "—"}</dd></div>
        <div><dt className="text-[var(--text-secondary)]">Attributes</dt><dd>{inspection.attributes.length}</dd></div>
        <div><dt className="text-[var(--text-secondary)]">Classes</dt><dd>{inspection.classes.length}</dd></div>
      </dl>
      {inspection.suggestedSelector ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-[var(--text-secondary)]">Selector</span>
          <code className="rounded bg-[var(--surface-secondary)] px-2 py-1 font-mono text-xs">{inspection.suggestedSelector}</code>
          <button type="button" onClick={() => void navigator.clipboard.writeText(inspection.suggestedSelector!)} className="text-xs text-[var(--accent)]">Copy</button>
        </div>
      ) : (
        <p className="text-xs text-[var(--text-secondary)]">No safe selector could be derived for this element.</p>
      )}
      {inspection.attributes.length > 0 ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-[var(--text-secondary)]">Attributes ({inspection.attributes.length})</summary>
          <ul className="mt-1 space-y-0.5 font-mono">
            {inspection.attributes.map((attribute) => (
              <li key={attribute.name} className="break-all"><span className="text-[var(--text-secondary)]">{attribute.name}</span>=&quot;{attribute.value}&quot;</li>
            ))}
          </ul>
        </details>
      ) : null}
      {inspection.suggestedSelector ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-2">
          <button type="button" onClick={() => onAddStep({ kind: "click", selector: inspection.suggestedSelector! })}
            className="rounded-full border border-[var(--border)] px-2.5 py-1 text-xs hover:bg-[var(--surface-secondary)]">+ Click step</button>
          <button type="button" onClick={() => onAddStep({ kind: "assert_element", selector: inspection.suggestedSelector! })}
            className="rounded-full border border-[var(--border)] px-2.5 py-1 text-xs hover:bg-[var(--surface-secondary)]">+ Assert exists</button>
          <span className="inline-flex items-center gap-1 text-xs">
            <input value={typeValue} onChange={(event) => setTypeValue(event.target.value)} placeholder="Text to type"
              aria-label="Text to type into this element"
              className="w-36 rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs outline-none" />
            <button type="button" disabled={typeValue.length === 0}
              onClick={() => { onAddStep({ kind: "type", selector: inspection.suggestedSelector!, text: typeValue }); setTypeValue(""); }}
              className="rounded-full border border-[var(--border)] px-2.5 py-1 text-xs hover:bg-[var(--surface-secondary)] disabled:opacity-50">+ Type</button>
          </span>
        </div>
      ) : null}
    </div>
  );
}

function StatusPill({ status, connection }: { status: string; connection: string }) {
  const live = (status === "READY" || status === "ACTIVE") && connection === "live";
  const idle = status === "IDLE";
  const terminal = TERMINAL.includes(status as never);
  const starting = status === "CREATED" || status === "QUEUED" || status === "STARTING";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
        live
          ? "border-transparent bg-[var(--status-success)]/15 text-[var(--status-success)]"
          : idle
            ? "border-[var(--border)] text-[var(--status-warning)]"
            : "border-[var(--border)] text-[var(--text-secondary)]",
      )}
    >
      <span
        className={cn(
          "h-2 w-2 rounded-full",
          live ? "bg-[var(--status-success)] motion-reduce:animate-none animate-pulse" : starting ? "bg-[var(--status-warning)]" : terminal ? "bg-[var(--text-secondary)]" : "bg-[var(--status-warning)]",
        )}
        aria-hidden="true"
      />
      {live ? "LIVE" : status}
      {connection === "reconnecting" ? " · reconnecting" : ""}
    </span>
  );
}

function ReconnectingState() {
  return (
    <div className="max-w-sm">
      <WifiOff className="mx-auto h-6 w-6 text-[var(--text-secondary)]" aria-hidden="true" />
      <p className="mt-2 text-sm font-semibold text-[var(--text-primary)]">Reconnecting to the browser session</p>
      <p className="mt-1 text-sm text-[var(--text-secondary)]">
        The session keeps running while the connection restores. You will rejoin the same browser.
      </p>
    </div>
  );
}

function StartingState({ session }: { session: InteractiveBrowserSessionView }) {
  return (
    <div className="max-w-sm">
      <Monitor className="mx-auto h-8 w-8 text-[var(--text-secondary)]" aria-hidden="true" />
      <p className="mt-3 text-sm font-semibold text-[var(--text-primary)]">
        {session.status === "STARTING"
          ? "Starting the disposable browser and loading your extension"
          : session.status === "QUEUED"
            ? "Waiting for a free browser slot"
            : "Waiting for the first browser frame"}
      </p>
      <p className="mt-1 text-sm text-[var(--text-secondary)]">{session.stateReason ?? "The page runs only inside the disposable container."}</p>
    </div>
  );
}

function TerminalState({ session }: { session: InteractiveBrowserSessionView }) {
  const map: Record<string, { title: string; detail: string }> = {
    STOPPED: { title: "Session stopped", detail: "The browser and its profile were destroyed and all resources cleaned up." },
    EXPIRED: { title: "Session expired", detail: session.stopReason === "idle_timeout" ? "The session expired after being idle." : "The session reached its maximum lifetime." },
    FAILED: { title: "Session failed", detail: session.stateReason ?? "The browser session ended with a failure." },
  };
  const entry = map[session.status] ?? { title: "Session ended", detail: session.stateReason ?? "" };
  return (
    <div className="max-w-sm">
      <CircleSlash className="mx-auto h-8 w-8 text-[var(--text-secondary)]" aria-hidden="true" />
      <p className="mt-3 text-sm font-semibold text-[var(--text-primary)]">{entry.title}</p>
      <p className="mt-1 text-sm text-[var(--text-secondary)]">{entry.detail}</p>
      {session.failureKind ? (
        <p className="mt-2 text-xs text-[var(--text-secondary)]">Classified as <span className="font-mono">{session.failureKind}</span></p>
      ) : null}
      <p className="mt-3 text-xs text-[var(--text-secondary)]">
        Reason recorded: <span className="font-mono">{session.stopReason ?? session.status.toLowerCase()}</span>
      </p>
    </div>
  );
}

function labelForBrowser(browser: string): string {
  return browser === "chromium" ? "Chromium" : browser;
}

function formatCountdown(seconds: number): string {
  if (seconds <= 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}
