"use client";

import { use, useEffect, useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

type Status = {
  message: string;
  step: string;
  current?: number;
  total?: number;
  phase?: string;
  topicsCompleted?: number;
  job_id?: string;
  is_reconnect?: boolean;
};

type CompleteEvent = {
  curriculum_id: string;
  phase: "topics" | "background";
  coverage_status?: "pending" | "complete" | "insufficient" | "failed";
};

type YieldedEvent = {
  message: string;
  topicsCompleted: number;
  totalTopics: number;
};

type PausedEvent = { message: string };

type LogEntry = {
  message: string;
  done: boolean;
};

export default function GeneratePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const router = useRouter();
  const [status, setStatus] = useState<Status>({
    message: "Starting…",
    step: "init",
  });
  const [log, setLog] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [canRetryPaused, setCanRetryPaused] = useState(false);
  const [coverageStatus, setCoverageStatus] = useState<CompleteEvent["coverage_status"]>();
  const [completedCurriculumId, setCompletedCurriculumId] = useState<string | null>(null);
  const [skeletonTitle, setSkeletonTitle] = useState<string | null>(null);
  const [terminalState, setTerminalState] = useState<"none" | "complete" | "failed">("none");
  const terminalStateRef = useRef(terminalState);
  const esRef = useRef<EventSource | null>(null);
  const yieldedHandledRef = useRef(false);
  const connectRef = useRef<() => void>(() => {});
  const reconnectAttemptsRef = useRef(0);
  const continuationAttemptsRef = useRef(0);
  const lastDiscoveryCurrentRef = useRef(0);
  const MAX_RECONNECT_ATTEMPTS = 5;
  // Each of at most 12 targets in two phases can yield once between two
  // coverage attempts and once at the per-invocation target boundary, plus
  // initial structure/source and elapsed-time budget yields. Keep finite room
  // for the full bounded workflow without conflating yields with transport retries.
  const MAX_CONTINUATION_ATTEMPTS = 60;
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep terminalStateRef in sync with terminalState
  useEffect(() => {
    terminalStateRef.current = terminalState;
  }, [terminalState]);

  // Single connection manager - handles all lifecycle
  const connectImpl = useCallback(() => {
    // Don't reconnect if we've reached a terminal state
    if (terminalStateRef.current !== "none") return;

    // A reconnect can be requested by multiple events; keep one connection.
    if (esRef.current && esRef.current.readyState !== EventSource.CLOSED) return;
    esRef.current?.close();

    console.info('[GeneratePage] EventSource constructing for', id);
    const es = new EventSource(`/api/generate/${id}/stream`);
    esRef.current = es;
    yieldedHandledRef.current = false;

    es.addEventListener("open", () => {
      console.info('[GeneratePage] EventSource connected');
    });

    es.addEventListener("status", (e) => {
      const data = JSON.parse(e.data) as Status;
      setStatus(data);
      setLog((prev) => [...prev, { message: data.message, done: false }]);

      if (
        data.step === "discovery" &&
        data.current !== undefined &&
        data.current > lastDiscoveryCurrentRef.current
      ) {
        lastDiscoveryCurrentRef.current = data.current;
        reconnectAttemptsRef.current = 0;
        continuationAttemptsRef.current = 0;
      }

      // A durable status response proves the job can still be observed. Do not
      // let earlier network errors exhaust the client retry budget.
      if (["pending", "running", "waiting", "status_unavailable"].includes(data.step)) {
        reconnectAttemptsRef.current = 0;
      }

      if (data.step === "waiting") {
        setLog((prev) => [
          ...prev.slice(0, -1),
          {
            message: "Another generation is in progress. Waiting for it to complete…",
            done: false,
          },
        ]);
      }
    });

    es.addEventListener("skeleton", (e) => {
      const data = JSON.parse(e.data) as {
        title: string;
        topic_count: number;
        resumed?: boolean;
      };
      setSkeletonTitle(data.title);
      setLog((prev) => [
        ...prev.slice(0, -1),
        {
          message: `${data.resumed ? "Reused saved structure" : "Found structure"}: ${data.title} (${data.topic_count} topics)`,
          done: true,
        },
      ]);
    });

    es.addEventListener("complete", (e) => {
      const data = JSON.parse(e.data) as CompleteEvent;
      if (data.phase === "background") {
        if (terminalStateRef.current !== "none") return;
        terminalStateRef.current = "complete";
        setTerminalState("complete");
        setCoverageStatus(data.coverage_status ?? "pending");
        const completedId = typeof data.curriculum_id === "string" && data.curriculum_id.length > 0
          ? data.curriculum_id
          : null;
        setCompletedCurriculumId(completedId);
        es.close();
        esRef.current = null;
        if (completedId && data.coverage_status === "complete") {
          router.push(`/curriculum/${encodeURIComponent(completedId)}`);
        } else if (completedId && data.coverage_status === "insufficient") {
          router.push(`/admin/curriculum/${encodeURIComponent(completedId)}`);
        } else {
          setLog((prev) => [...prev, { message: "Generation processing finished.", done: true }]);
        }
      } else if (data.phase === "topics") {
        setLog((prev) => [
          ...prev.slice(0, -1),
          {
            message: "Topic-level resources found. Generating per-concept resources…",
            done: false,
          },
        ]);
      }
    });

    es.addEventListener("yielded", (e) => {
      const data = JSON.parse(e.data) as YieldedEvent;
      setLog((prev) => [
        ...prev.slice(0, -1),
        {
          message: `${data.message} (${data.topicsCompleted}/${data.totalTopics} topics this session)`,
          done: true,
        },
      ]);
      yieldedHandledRef.current = true;
      // Close current connection; reconnect will be triggered by the effect
      es.close();
      esRef.current = null;
      continuationAttemptsRef.current += 1;
      if (continuationAttemptsRef.current >= MAX_CONTINUATION_ATTEMPTS) {
        setError("Generation needs another continuation, but the retry limit was reached. Please return to the curriculum and try again.");
        terminalStateRef.current = "failed";
        setTerminalState("failed");
      } else if (reconnectTimerRef.current === null) {
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          connectRef.current?.();
        }, 2000);
      }
    });

    // The server intentionally closes its observer stream before the route
    // execution limit. Reconnect without counting this as a transport failure.
    es.addEventListener("continue", () => {
      es.close();
      if (esRef.current === es) esRef.current = null;
      if (reconnectTimerRef.current === null) {
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          connectRef.current?.();
        }, 1000);
      }
    });

    // A discovery failure leaves the durable job pending but does not trigger
    // an automatic retry loop. The user can explicitly retry the saved job.
    es.addEventListener("paused", (e) => {
      const data = JSON.parse(e.data) as PausedEvent;
      setError(data.message);
      setCanRetryPaused(true);
      terminalStateRef.current = "failed";
      setTerminalState("failed");
      es.close();
      esRef.current = null;
    });

    // Handle explicit "error" events from server (event type = "error", has data)
    es.addEventListener("error", (e) => {
      const event = e as MessageEvent;
      // Only handle explicit error events with data
      if (event.type === "error" && event.data) {
        try {
          const data = JSON.parse(event.data) as { message: string };
          setError(data.message);
          terminalStateRef.current = "failed";
          setTerminalState("failed");
        } catch {
          setError("Something went wrong — please try again");
          terminalStateRef.current = "failed";
          setTerminalState("failed");
        }
        es.close();
        esRef.current = null;
      }
      // Transport errors without data are handled by the bounded reconnect listener.
    });

    // Close native EventSource retries and manage one finite retry path ourselves.
    es.addEventListener("error", (e) => {
      const event = e as MessageEvent;
      if (event.data) return; // Explicit server error is handled below.
      if (terminalStateRef.current !== "none" || yieldedHandledRef.current) return;
      es.close();
      if (esRef.current === es) esRef.current = null;
      reconnectAttemptsRef.current += 1;
      if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
        setError("The generation connection could not make progress after several attempts. Please return to the curriculum and try again.");
        setTerminalState("failed");
        return;
      }
      if (reconnectTimerRef.current === null) {
        reconnectTimerRef.current = setTimeout(() => {
          reconnectTimerRef.current = null;
          connectRef.current?.();
        }, 2000);
      }
    });

    return () => es.close();
  }, [id, router]);

  // Store the connect function in a ref for access from event handlers
  useEffect(() => {
    connectRef.current = connectImpl;
  }, [connectImpl]);

  const connect = useCallback(() => {
    connectImpl();
  }, [connectImpl]);

  const retryPausedGeneration = useCallback(() => {
    terminalStateRef.current = "none";
    setTerminalState("none");
    setError(null);
    setCanRetryPaused(false);
    reconnectAttemptsRef.current = 0;
    continuationAttemptsRef.current = 0;
    lastDiscoveryCurrentRef.current = 0;
    connectRef.current();
  }, []);

  // Initial connection on mount
  useEffect(() => {
    console.info('[GeneratePage] Initial effect running, calling connect()');
    connect();
  }, [connect]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (reconnectTimerRef.current !== null) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, []);

  return (
    <main className="min-h-screen bg-canvas-default text-text-primary flex items-center justify-center px-6 py-12">
      <div className="w-full max-w-lg">
        {error ? (
          <div className="bg-surface-card rounded-2xl border border-status-error/30 p-8 shadow-sm">
            <div className="w-10 h-10 rounded-full bg-status-error-bg text-status-error flex items-center justify-center text-lg font-bold mb-4">
              ✕
            </div>
            <h1 className="font-display text-2xl font-bold mb-2 text-status-error">
              Something went wrong
            </h1>
            <p className="text-sm text-text-secondary mb-6 leading-relaxed">
              {error}
            </p>
            {canRetryPaused && (
              <button
                type="button"
                onClick={retryPausedGeneration}
                className="inline-flex items-center justify-center px-4 py-2 mr-2 rounded-lg bg-brand-forest text-white text-sm font-medium hover:bg-brand-navy transition"
              >
                Retry saved generation
              </button>
            )}
            <Link
              href="/"
              className="inline-flex items-center justify-center px-4 py-2 rounded-lg bg-surface-card border border-border-default text-text-primary text-sm font-medium hover:border-brand-forest transition shadow-xs"
            >
              ← Back to home
            </Link>
          </div>
        ) : (
          <div className="bg-surface-card rounded-2xl border border-border-default shadow-sm p-6 sm:p-8">
            <div className="flex items-center justify-between gap-2 mb-2">
              <p className="text-xs font-display font-semibold uppercase tracking-[0.18em] text-brand-forest">
                {terminalState === "complete" ? "Generation processing finished" : "Building your curriculum"}
              </p>
              {terminalState !== "complete" && (
                <span className="w-2 h-2 rounded-full bg-brand-fresh animate-ping" />
              )}
            </div>

            {skeletonTitle ? (
              <h1 className="font-display text-2xl font-bold text-brand-navy mb-3 leading-tight">
                {skeletonTitle}
              </h1>
            ) : (
              <h1 className="font-display text-2xl font-bold text-brand-navy mb-3 leading-tight">
                Finding structure…
              </h1>
            )}

            {status.step === "discovery" && status.total && (
              <div className="mt-4 mb-6">
                <div className="flex justify-between text-xs text-text-secondary font-medium mb-1.5">
                  <span>Topics Discovered</span>
                  <span className="font-mono text-brand-forest">
                    {status.current} / {status.total}
                  </span>
                </div>
                <div className="h-2 bg-canvas-subtle rounded-full overflow-hidden border border-border-subtle">
                  <div
                    className="h-full bg-brand-forest rounded-full transition-all duration-500 ease-out"
                    style={{
                      width: `${((status.current ?? 0) / status.total) * 100}%`,
                    }}
                  />
                </div>
              </div>
            )}

            {terminalState === "complete" && (
              <div role="status" className="mt-4 rounded-lg border border-border-default bg-canvas-subtle p-4 text-sm text-text-secondary">
                {coverageStatus === "insufficient"
                  ? "Resource coverage is insufficient. Some topic or concept targets did not meet their resource minimums."
                  : coverageStatus === "complete"
                    ? "Resource coverage is complete for all topic and concept targets."
                    : "Resource coverage could not be confirmed."}
                {completedCurriculumId && (coverageStatus === "complete" || coverageStatus === "insufficient") && (
                  <div className="mt-3">
                    <Link
                      href={coverageStatus === "complete"
                        ? `/curriculum/${encodeURIComponent(completedCurriculumId)}`
                        : `/admin/curriculum/${encodeURIComponent(completedCurriculumId)}`}
                      className="font-medium text-brand-forest underline"
                    >
                      View curriculum
                    </Link>
                  </div>
                )}
              </div>
            )}

            <div className="mt-6 space-y-2.5 max-h-64 overflow-y-auto pr-1">
              {log.map((entry, i) => {
                const isFinished = entry.done || i < log.length - 1;
                return (
                  <div key={i} className="flex items-start gap-2.5 text-sm">
                    {isFinished ? (
                      <span className="w-4 h-4 rounded-full bg-status-success-bg text-status-success text-[10px] font-bold inline-flex items-center justify-center shrink-0 mt-0.5">
                        ✓
                      </span>
                    ) : (
                      <span className="w-4 h-4 rounded-full bg-brand-aqua-tint text-brand-forest text-[10px] font-bold inline-flex items-center justify-center shrink-0 mt-0.5 animate-pulse">
                        →
                      </span>
                    )}
                    <p
                      className={`text-sm leading-snug ${
                        isFinished ? "text-text-tertiary" : "text-text-primary font-medium"
                      }`}
                    >
                      {entry.message}
                    </p>
                  </div>
                );
              })}
            </div>

            <p className="text-xs text-text-tertiary mt-8 pt-4 border-t border-border-subtle leading-relaxed">
              This takes a few minutes — compiling and verifying real educational
              resources across the web for each topic. You can safely leave this tab open.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
