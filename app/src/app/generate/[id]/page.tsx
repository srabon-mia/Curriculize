"use client";

import { useEffect, useState, use } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

type Status = {
  message: string;
  step: string;
  current?: number;
  total?: number;
  phase?: string;
};

type CompleteEvent = {
  curriculum_id: string;
  phase: "topics" | "background";
};

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
  const [skeletonTitle, setSkeletonTitle] = useState<string | null>(null);

  useEffect(() => {
    const es = new EventSource(`/api/generate/${id}/stream`);

    es.addEventListener("status", (e) => {
      const data = JSON.parse(e.data) as Status;
      setStatus(data);
      setLog((prev) => [...prev, { message: data.message, done: false }]);

      if (data.step === "already_claimed") {
        // Another generation is in progress for this curriculum — redirect
        // to the curriculum page where the student can observe progress via
        // polling (CurriculumViewer polls /api/curricula/[id]/progress).
        es.close();
        router.push(`/curriculum/${id}`);
      }
    });

    es.addEventListener("skeleton", (e) => {
      const data = JSON.parse(e.data) as {
        title: string;
        topic_count: number;
      };
      setSkeletonTitle(data.title);
      setLog((prev) => [
        ...prev.slice(0, -1),
        {
          message: `Found structure: ${data.title} (${data.topic_count} topics)`,
          done: true,
        },
      ]);
    });

    es.addEventListener("complete", (e) => {
      const data = JSON.parse(e.data) as CompleteEvent;
      if (data.phase === "background") {
        // All generation complete (topic + background batch)
        es.close();
        router.push(`/curriculum/${id}`);
      } else if (data.phase === "topics") {
        // Topic-level resources done, background batch starting
        setLog((prev) => [
          ...prev.slice(0, -1),
          {
            message: "Topic-level resources found. Generating per-concept resources…",
            done: false,
          },
        ]);
      }
    });

    es.addEventListener("error", (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as {
          message: string;
        };
        setError(data.message);
      } catch {
        setError("Something went wrong — please try again");
      }
      es.close();
    });

    return () => es.close();
  }, [id, router]);

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
                Building your curriculum
              </p>
              <span className="w-2 h-2 rounded-full bg-brand-fresh animate-ping" />
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