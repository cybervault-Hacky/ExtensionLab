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
  Globe,
  Lock,
  Monitor,
  Puzzle,
  RefreshCw,
  Square,
  WifiOff,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { PaywallNotice, paywallFromError, type PaywallInfo } from "@/components/billing/PaywallNotice";
import { cn } from "@/lib/utils";
import type {
  BrowserInputAction,
  ConsoleEntryView,
  InteractiveBrowserSessionView,
  InteractiveSessionEventView,
  NetworkEntryView,
  ScreenshotArtifactView,
} from "@/types/interactive";

/* eslint-disable @next/next/no-img-element */

/**
 * Interactive browser workspace (Phase 11).
 *
 * The viewport shows frames captured from the REAL disposable Chromium
 * container; clicks, typing and scrolling are translated into the typed,
 * allowlisted input API and dispatched into that same container. Nothing here
 * renders extension HTML and nothing speaks CDP.
 */

type Tab = "console" | "network" | "extension" | "events" | "screenshots";

const LIVE_STATUSES = ["READY", "ACTIVE", "IDLE"];
const TERMINAL = ["STOPPED", "EXPIRED", "FAILED"];

interface WorkspaceState {
  session: InteractiveBrowserSessionView;
  console: ConsoleEntryView[];
  network: NetworkEntryView[];
  events: InteractiveSessionEventView[];
  artifacts: ScreenshotArtifactView[];
}

export function BrowserWorkspace({ initialSession }: { initialSession: InteractiveBrowserSessionView }) {
  const [state, setState] = useState<WorkspaceState>({
    session: initialSession,
    console: [],
    network: [],
    events: [],
    artifacts: [],
  });
  const [tab, setTab] = useState<Tab>("console");
  const [connection, setConnection] = useState<"connecting" | "live" | "reconnecting" | "closed">("connecting");
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [popupUrl, setPopupUrl] = useState<string | null>(null);
  const [addressValue, setAddressValue] = useState(initialSession.currentUrl ?? "");
  const [navigating, setNavigating] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [paywall, setPaywall] = useState<PaywallInfo | null>(null);
  const [countdown, setCountdown] = useState<number>(0);

  const sessionRef = useRef(initialSession);
  sessionRef.current = state.session;
  const frameUrlRef = useRef<string | null>(null);
  const popupUrlRef = useRef<string | null>(null);
  const lastMoveRef = useRef(0);
  const lastWheelRef = useRef(0);
  const viewportRef = useRef<HTMLDivElement | null>(null);

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
      source = new EventSource(`/api/browser-sessions/${initialSession.id}/events/stream`);
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
        // EventSource retries automatically; mark the UI honestly meanwhile.
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
  }, [initialSession.id, isTerminal, syncSession]);

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

  // --- frame polling --------------------------------------------------------

  const pollFrames = useCallback(
    async (target: "page" | "popup") => {
      try {
        const response = await fetch(`/api/browser-sessions/${sessionRef.current.id}/screenshot?target=${target}&t=${Date.now()}`);
        if (!response.ok) return;
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        if (target === "page") {
          frameUrlRef.current?.startsWith("blob:") && URL.revokeObjectURL(frameUrlRef.current);
          frameUrlRef.current = url;
          setFrameUrl(url);
        } else {
          popupUrlRef.current?.startsWith("blob:") && URL.revokeObjectURL(popupUrlRef.current);
          popupUrlRef.current = url;
          setPopupUrl(url);
        }
      } catch {
        // Transient frame failures keep the previous frame.
      }
    },
    [],
  );

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

  const coordinatesFor = (event: { clientX: number; clientY: number }, target: "page" | "popup") => {
    const element = viewportRef.current;
    if (!element) return null;
    const bounds = target === "popup" && session.popupSize ? session.popupSize : session.viewport;
    const rect = element.getBoundingClientRect();
    const scale = bounds.width / Math.max(1, rect.width);
    const scaleY = bounds.height / Math.max(1, rect.height);
    return {
      x: Math.max(0, Math.min(bounds.width, Math.round((event.clientX - rect.left) * scale))),
      y: Math.max(0, Math.min(bounds.height, Math.round((event.clientY - rect.top) * scaleY))),
    };
  };

  const onViewportClick = (event: React.MouseEvent<HTMLDivElement>, target: "page" | "popup") => {
    const point = coordinatesFor(event, target);
    if (!point) return;
    void sendInput({ type: "click", x: point.x, y: point.y, target });
  };

  const onViewportDoubleClick = (event: React.MouseEvent<HTMLDivElement>, target: "page" | "popup") => {
    const point = coordinatesFor(event, target);
    if (!point) return;
    void sendInput({ type: "double_click", x: point.x, y: point.y, target });
  };

  const onViewportWheel = (event: React.WheelEvent<HTMLDivElement>, target: "page" | "popup") => {
    const now = Date.now();
    if (now - lastWheelRef.current < 120) return;
    lastWheelRef.current = now;
    const point = coordinatesFor(event, target);
    if (!point) return;
    void sendInput({
      type: "scroll",
      x: point.x,
      y: point.y,
      deltaX: Math.round(event.deltaX),
      deltaY: Math.round(event.deltaY),
      target,
    });
  };

  const onViewportKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, target: "page" | "popup") => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key.length === 1) {
      event.preventDefault();
      void sendInput({ type: "type_text", text: event.key, target });
      return;
    }
    const named = ["Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"];
    if (named.includes(event.key)) {
      event.preventDefault();
      void sendInput({ type: "key_press", key: event.key, target });
    }
  };

  // --- navigation -----------------------------------------------------------

  const navigate = async (op: "navigate" | "back" | "forward" | "reload", url?: string) => {
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
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Navigation failed." });
    } finally {
      setNavigating(false);
    }
  };

  // --- popup / extension menu -------------------------------------------------

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

  const stopSession = async () => {
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
  }, [tab, refreshArtifacts]);

  // --- rendering --------------------------------------------------------------

  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: "console", label: "Console", count: state.console.length },
    { id: "network", label: "Network", count: state.network.length },
    { id: "extension", label: "Extension" },
    { id: "events", label: "Events", count: state.events.length },
    { id: "screenshots", label: "Screenshots", count: state.artifacts.length },
  ];

  const backHref = session.projectId ? `/dashboard/extensions/${session.projectId}` : "/dashboard";

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="eyebrow">Interactive Browser</p>
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
        <div className="flex items-center gap-2">
          <StatusPill status={session.status} connection={connection} />
          {isLive || session.status === "STOPPING" ? (
            <Button variant="secondary" size="sm" onClick={stopSession} loading={busy === "stop"}>
              <Square className="h-4 w-4" aria-hidden="true" />
              Stop
            </Button>
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
          <button
            type="button"
            onClick={() => void navigate("back")}
            disabled={!isLive || navigating}
            aria-label="Go back"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface)] hover:text-[var(--text-primary)] disabled:opacity-40"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => void navigate("forward")}
            disabled={!isLive || navigating}
            aria-label="Go forward"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface)] hover:text-[var(--text-primary)] disabled:opacity-40"
          >
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => void navigate("reload")}
            disabled={!isLive || navigating}
            aria-label="Reload page"
            className="inline-flex h-9 w-9 items-center justify-center rounded-full text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface)] hover:text-[var(--text-primary)] disabled:opacity-40"
          >
            <RefreshCw className={cn("h-4 w-4", navigating && "animate-spin")} aria-hidden="true" />
          </button>

          <form
            className="ml-1 flex min-w-[220px] flex-1 items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              if (addressValue.trim()) void navigate("navigate", addressValue.trim());
            }}
          >
            <Lock className="h-3.5 w-3.5 shrink-0 text-[var(--text-secondary)]" aria-hidden="true" />
            <label className="sr-only" htmlFor="ibrowser-address">
              Page address
            </label>
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
          </form>

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
              <div
                role="menu"
                className="absolute right-0 top-11 z-20 w-72 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-sm shadow-[var(--shadow-card)]"
              >
                <p className="font-medium text-[var(--text-primary)]">
                  {session.extension.name ?? "Extension"}
                </p>
                <p className="mt-0.5 text-xs text-[var(--text-secondary)]">
                  {session.extension.version ? `v${session.extension.version} · ` : ""}
                  {session.extension.manifestVersion ?? "Manifest"}
                </p>
                <div className="mt-3 space-y-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    fullWidth
                    onClick={() => {
                      setMenuOpen(false);
                      void openPopup();
                    }}
                    loading={busy === "popup" && !session.popupOpen}
                    disabled={!session.extension.popupPath}
                    title={session.extension.popupPath ? undefined : "This extension does not declare a popup"}
                  >
                    {session.popupOpen ? "Popup is open" : "Open Popup"}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    fullWidth
                    onClick={() => {
                      setMenuOpen(false);
                      void reloadExtension();
                    }}
                    loading={busy === "reload"}
                  >
                    Reload Extension
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    fullWidth
                    onClick={() => {
                      setMenuOpen(false);
                      setTab("extension");
                    }}
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
        <div className="relative bg-[var(--bg)]">
          <div className="mx-auto" style={{ maxWidth: `${session.viewport.width}px` }}>
            <div
              ref={viewportRef}
              role="application"
              aria-label={`Interactive browser viewport, ${session.viewport.width} by ${session.viewport.height} pixels`}
              tabIndex={0}
              onClick={(event) => onViewportClick(event, "page")}
              onDoubleClick={(event) => onViewportDoubleClick(event, "page")}
              onWheel={(event) => onViewportWheel(event, "page")}
              onKeyDown={(event) => onViewportKeyDown(event, "page")}
              style={{ aspectRatio: `${session.viewport.width} / ${session.viewport.height}` }}
              className={cn(
                "relative w-full select-none outline-none transition-opacity focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--accent)]",
                isLive ? "cursor-default" : "cursor-not-allowed",
              )}
            >
              {frameUrl ? (
                <img
                  src={frameUrl}
                  alt="Live page inside the isolated ExtensionLab browser"
                  draggable={false}
                  className="pointer-events-none absolute inset-0 h-full w-full object-fill"
                />
              ) : (
                <div className="absolute inset-0 flex items-center justify-center p-6 text-center">
                  <ViewportPlaceholder session={session} connection={connection} />
                </div>
              )}

              {/* Real extension popup, rendered by the container browser */}
              {session.popupOpen && popupUrl ? (
                <div className="absolute bottom-6 right-6 z-10 rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-card)]">
                  <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-3 py-1.5">
                    <span className="text-xs font-medium text-[var(--text-secondary)]">
                      {session.extension.name ?? "Extension"} popup
                    </span>
                    <button
                      type="button"
                      onClick={() => void closePopup()}
                      aria-label="Close extension popup"
                      className="inline-flex h-6 w-6 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--surface-secondary)]"
                    >
                      <X className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                  <div
                    role="application"
                    aria-label="Extension popup inside the isolated browser"
                    tabIndex={0}
                    onClick={(event) => onViewportClick(event, "popup")}
                    onDoubleClick={(event) => onViewportDoubleClick(event, "popup")}
                    onWheel={(event) => onViewportWheel(event, "popup")}
                    onKeyDown={(event) => onViewportKeyDown(event, "popup")}
                    className="select-none"
                    style={{
                      width: Math.min(session.popupSize?.width ?? 380, 380),
                      height: Math.min(session.popupSize?.height ?? 480, 480),
                    }}
                  >
                    <img
                      src={popupUrl}
                      alt="Extension popup rendered by the isolated browser"
                      draggable={false}
                      className="pointer-events-none h-full w-full object-fill"
                    />
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
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
        <div className="max-h-[360px] overflow-y-auto p-3">
          {tab === "console" ? <ConsoleTab entries={state.console} /> : null}
          {tab === "network" ? <NetworkTab entries={state.network} /> : null}
          {tab === "extension" ? <ExtensionTab session={session} onReload={() => void reloadExtension()} busy={busy === "reload"} /> : null}
          {tab === "events" ? <EventsTab events={state.events} /> : null}
          {tab === "screenshots" ? <ScreenshotsTab artifacts={state.artifacts} onRefresh={() => void refreshArtifacts()} /> : null}
        </div>
      </div>
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
            : terminal
              ? "border-[var(--border)] text-[var(--text-secondary)]"
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

function ViewportPlaceholder({ session, connection }: { session: InteractiveBrowserSessionView; connection: string }) {
  if (connection === "reconnecting" || connection === "connecting") {
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
  if (TERMINAL.includes(session.status)) {
    return <TerminalState session={session} />;
  }
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
      <p className="mt-1 text-sm text-[var(--text-secondary)]">
        {session.stateReason ?? "The page runs only inside the disposable container."}
      </p>
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
      <p className="mt-3 text-xs text-[var(--text-secondary)]">
        Reason recorded: <span className="font-mono">{session.stopReason ?? session.status.toLowerCase()}</span>
      </p>
    </div>
  );
}

function ConsoleTab({ entries }: { entries: ConsoleEntryView[] }) {
  const [filter, setFilter] = useState("");
  const [level, setLevel] = useState<"all" | "log" | "warning" | "error">("all");
  const filtered = useMemo(
    () =>
      entries.filter(
        (entry) =>
          (level === "all" || entry.level === level) &&
          (filter === "" || entry.message.toLowerCase().includes(filter.toLowerCase())),
      ),
    [entries, filter, level],
  );
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Search console"
          aria-label="Search console messages"
          className="min-w-[160px] flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-1.5 text-sm outline-none focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        />
        <div className="flex gap-1" role="group" aria-label="Console level filter">
          {(["all", "log", "warning", "error"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => setLevel(option)}
              aria-pressed={level === option}
              className={cn(
                "rounded-full px-2.5 py-1 text-xs font-medium transition-colors",
                level === option ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "text-[var(--text-secondary)] hover:bg-[var(--surface-secondary)]",
              )}
            >
              {option === "all" ? "All" : option === "log" ? "Logs" : option === "warning" ? "Warnings" : "Errors"}
            </button>
          ))}
        </div>
      </div>
      {filtered.length === 0 ? (
        <p className="py-8 text-center text-sm text-[var(--text-secondary)]">No console output yet.</p>
      ) : (
        <div role="log" aria-live="polite" className="space-y-0.5">
          {filtered.map((entry) => (
            <div key={entry.id} className="flex gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-[var(--surface-secondary)]">
              <span className="shrink-0 font-mono text-xs tabular-nums text-[var(--text-secondary)]">{formatTime(entry.timestamp)}</span>
              <span
                className={cn(
                  "w-14 shrink-0 text-xs font-semibold uppercase",
                  entry.level === "error"
                    ? "text-[var(--status-error)]"
                    : entry.level === "warning"
                      ? "text-[var(--status-warning)]"
                      : "text-[var(--text-secondary)]",
                )}
              >
                {entry.level === "warning" ? "warn" : entry.level}
              </span>
              <span className="min-w-0 flex-1 break-words text-[var(--text-primary)]">{entry.message}</span>
              <span className="shrink-0 text-xs text-[var(--text-secondary)]">{entry.source}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function NetworkTab({ entries }: { entries: NetworkEntryView[] }) {
  if (entries.length === 0) {
    return <p className="py-8 text-center text-sm text-[var(--text-secondary)]">No network activity captured yet.</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-left text-sm">
        <thead>
          <tr className="border-b border-[var(--border)] text-xs uppercase tracking-wide text-[var(--text-secondary)]">
            <th className="px-2 py-2 font-medium">Time</th>
            <th className="px-2 py-2 font-medium">Method</th>
            <th className="px-2 py-2 font-medium">URL</th>
            <th className="px-2 py-2 font-medium">Status</th>
            <th className="px-2 py-2 font-medium">Type</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id} className="border-b border-[var(--border)] last:border-0">
              <td className="px-2 py-1.5 font-mono text-xs text-[var(--text-secondary)]">{formatTime(entry.timestamp)}</td>
              <td className="px-2 py-1.5 font-medium">{entry.method}</td>
              <td className="max-w-[320px] truncate px-2 py-1.5 font-mono text-xs" title={entry.url}>
                {entry.url}
              </td>
              <td className={cn("px-2 py-1.5", entry.status !== null && entry.status >= 400 ? "text-[var(--status-error)]" : "")}>
                {entry.status ?? "—"}
              </td>
              <td className="px-2 py-1.5 text-[var(--text-secondary)]">{entry.resourceType}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExtensionTab({ session, onReload, busy }: { session: InteractiveBrowserSessionView; onReload: () => void; busy: boolean }) {
  const extension = session.extension;
  const rows: Array<[string, string]> = [
    ["Name", extension.name ?? "—"],
    ["Version", extension.version ?? "—"],
    ["Manifest", extension.manifestVersion ?? "—"],
    ["Package SHA-256", session.packageSha256],
    ["Browser", `${labelForBrowser(session.browser)}${session.browserVersion ? ` ${session.browserVersion}` : ""}`],
    ["Popup", extension.popupPath ? `Available (${extension.popupPath})` : "Not declared"],
    ["Service worker", extension.hasServiceWorker ? "Declared" : "Not declared"],
    ["Content scripts", extension.hasContentScripts ? extension.contentScriptMatches.join(", ") || "Declared" : "Not declared"],
  ];
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <dl className="space-y-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex justify-between gap-4 border-b border-[var(--border)] pb-2 last:border-0">
            <dt className="shrink-0 text-[var(--text-secondary)]">{label}</dt>
            <dd className="min-w-0 break-all text-right font-mono text-xs text-[var(--text-primary)]">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="space-y-4">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--text-secondary)]">Permissions</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {extension.permissions.length === 0 ? (
              <span className="text-sm text-[var(--text-secondary)]">None declared</span>
            ) : (
              extension.permissions.map((permission) => (
                <span key={permission} className="rounded-full bg-[var(--surface-secondary)] px-2 py-0.5 text-xs text-[var(--text-primary)]">
                  {permission}
                </span>
              ))
            )}
          </div>
        </div>
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--text-secondary)]">Host permissions</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {extension.hostPermissions.length === 0 ? (
              <span className="text-sm text-[var(--text-secondary)]">None declared</span>
            ) : (
              extension.hostPermissions.map((permission) => (
                <span key={permission} className="rounded-full bg-[var(--surface-secondary)] px-2 py-0.5 text-xs text-[var(--text-primary)]">
                  {permission}
                </span>
              ))
            )}
          </div>
        </div>
        <Button variant="secondary" size="sm" onClick={onReload} loading={busy}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Reload Extension
        </Button>
      </div>
    </div>
  );
}

function EventsTab({ events }: { events: InteractiveSessionEventView[] }) {
  if (events.length === 0) {
    return <p className="py-8 text-center text-sm text-[var(--text-secondary)]">Session events will appear here as they are observed.</p>;
  }
  return (
    <div role="log" aria-live="polite" className="space-y-0.5">
      {[...events].reverse().map((event) => (
        <div key={event.seq} className="flex gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-[var(--surface-secondary)]">
          <span className="shrink-0 font-mono text-xs tabular-nums text-[var(--text-secondary)]">{formatTime(event.timestamp)}</span>
          <span
            className={cn(
              "w-36 shrink-0 truncate font-mono text-xs",
              event.level === "error"
                ? "text-[var(--status-error)]"
                : event.level === "warning"
                  ? "text-[var(--status-warning)]"
                  : "text-[var(--accent)]",
            )}
            title={event.type}
          >
            {event.type}
          </span>
          <span className="min-w-0 flex-1 break-words text-[var(--text-primary)]">{event.message}</span>
        </div>
      ))}
    </div>
  );
}

function ScreenshotsTab({ artifacts, onRefresh }: { artifacts: ScreenshotArtifactView[]; onRefresh: () => void }) {
  return (
    <div>
      <div className="mb-2 flex justify-end">
        <Button variant="ghost" size="sm" onClick={onRefresh}>
          <RefreshCw className="h-4 w-4" aria-hidden="true" />
          Refresh
        </Button>
      </div>
      {artifacts.length === 0 ? (
        <p className="py-8 text-center text-sm text-[var(--text-secondary)]">
          No screenshots captured yet. Use the camera button in the browser toolbar.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {artifacts.map((artifact) => (
            <a
              key={artifact.id}
              href={artifact.url}
              target="_blank"
              rel="noreferrer"
              className="group overflow-hidden rounded-lg border border-[var(--border)] transition-colors hover:border-[var(--accent)]"
            >
              <img src={artifact.url} alt={artifact.label ?? "Captured screenshot"} className="aspect-video w-full object-cover object-top" />
              <div className="px-2 py-1.5 text-xs text-[var(--text-secondary)]">
                {new Date(artifact.createdAt).toLocaleTimeString()}
                {artifact.expiresAt < Date.now() ? " · expired" : ""}
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function labelForBrowser(browserId: string): string {
  if (browserId === "chromium") return "Chromium";
  if (browserId === "edge") return "Microsoft Edge";
  if (browserId === "firefox") return "Firefox";
  return browserId;
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatCountdown(seconds: number): string {
  if (seconds <= 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}
