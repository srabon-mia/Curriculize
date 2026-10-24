"use client";

import { useState, useMemo, useEffect } from "react";
import type { NodeWithChildren, Resource } from "@/lib/curriculum-data";

const RESOURCE_TYPE_LABEL: Record<string, string> = {
  video: "Video",
  text: "Reading",
  textbook: "Textbook",
  problem_set: "Problem Set",
  reference_tool: "Reference Tool",
  practice_exam: "Practice Exam",
  other: "Resource",
};

const RESOURCE_TYPE_COLOR: Record<string, string> = {
  video: "bg-[#EBF5FB] text-[#1E5B94] border border-[#D4E6F1]",
  text: "bg-canvas-subtle text-text-secondary border border-border-default",
  textbook: "bg-canvas-subtle text-text-secondary border border-border-default",
  problem_set: "bg-[#EAF7ED] text-[#166534] border border-[#CEEBD3]",
  reference_tool: "bg-[#F5EEF8] text-[#6B21A8] border border-[#E9D5FF]",
  practice_exam: "bg-[#FEF3E2] text-[#B45309] border border-[#FCD34D]",
  other: "bg-canvas-subtle text-text-secondary border border-border-default",
};

function ResourceLink({ resource }: { resource: Resource }) {
  const typeLabel =
    RESOURCE_TYPE_LABEL[resource.resource_type] ?? "Resource";
  const typeColor =
    RESOURCE_TYPE_COLOR[resource.resource_type] ?? RESOURCE_TYPE_COLOR.other;

  // Strip internal seed marker from student-facing description
  const displayNote = resource.ai_note
    ? resource.ai_note.replace(/^\[SEED:demo-2026\]\s*/, "").trim()
    : null;

  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-border-subtle last:border-0">
      <span
        className={`shrink-0 text-[11px] font-medium px-2.5 py-0.5 rounded-full mt-0.5 ${typeColor}`}
      >
        {typeLabel}
      </span>
      <div className="min-w-0 flex-1">
        <a
          href={resource.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-medium text-text-primary hover:text-brand-forest underline decoration-border-default hover:decoration-brand-forest underline-offset-2 break-words transition-colors"
        >
          {resource.title}
        </a>
        {resource.source_domain && (
          <span className="text-xs font-mono text-text-tertiary ml-2">
            ({resource.source_domain})
          </span>
        )}
        {displayNote && (
          <p className="text-xs text-text-secondary mt-0.5 italic">
            {displayNote}
          </p>
        )}
      </div>
    </div>
  );
}

export function CurriculumViewer({
  nodes,
  resourcesByTarget: initialResourcesByTarget,
}: {
  nodes: NodeWithChildren[];
  resourcesByTarget: Record<string, Resource[]>;
}) {
  const [resourcesByTarget, setResourcesByTarget] = useState(initialResourcesByTarget);
  const [selectedNodeId, setSelectedNodeId] = useState<string>(
    nodes[0]?.id ?? ""
  );
  const [generationFinished, setGenerationFinished] = useState(false);
  const [coverageStatus, setCoverageStatus] = useState<"pending" | "complete" | "insufficient" | "failed">("pending");

  // Poll for background resource updates every 30 seconds
  // Stops only after quality targets are met or generation reaches a terminal state.
  useEffect(() => {
    // Extract curriculum_id from the first node
    const curriculumId = nodes[0]?.curriculum_id;
    if (!curriculumId) return;

    let stopped = false;

    async function poll() {
      const res = await fetch(`/api/curricula/${curriculumId}/progress`);
      if (!res.ok) return;
      const data = (await res.json()) as {
        total: number;
        with_resources: number;
        complete: boolean;
        generation_finished?: boolean;
        coverage_status?: "pending" | "complete" | "insufficient" | "failed";
      };

      if (data.complete) {
        stopped = true;
        setCoverageStatus("complete");
        return;
      }

      if (data.generation_finished) {
        stopped = true;
        setGenerationFinished(true);
        setCoverageStatus(data.coverage_status ?? "failed");
        return;
      }

      // Refetch all resources for the current node
      if (selectedNodeId) {
        const nodeRes = await fetch(`/api/resources?node_id=${selectedNodeId}`);
        if (nodeRes.ok) {
          const nodeData = await nodeRes.json();
          // Apply eligibility gate: only approved + content_type_verified resources
          const eligibleNodeResources = (nodeData.resources ?? []).filter(
            (r: Resource) => r.status === "approved" && r.content_type_verified === true
          );
          // Also fetch MU resources
          const currentNode = nodes.find((n) => n.id === selectedNodeId);
          if (currentNode) {
            const muFetches = currentNode.major_understandings.map(async (mu) => {
              const muRes = await fetch(
                `/api/resources?major_understanding_id=${mu.id}`
              );
              if (muRes.ok) {
                const muData = await muRes.json();
                const eligibleMuResources = (muData.resources ?? []).filter(
                  (r: Resource) => r.status === "approved" && r.content_type_verified === true
                );
                setResourcesByTarget((prev) => ({
                  ...prev,
                  [`mu:${mu.id}`]: eligibleMuResources,
                }));
              }
            });
            await Promise.all(muFetches);
          }
          setResourcesByTarget((prev) => ({
            ...prev,
            [`node:${selectedNodeId}`]: eligibleNodeResources,
          }));
        }
      }
    }

    const interval = setInterval(() => {
      if (!stopped) poll();
      else clearInterval(interval);
    }, 30000);

    // Run once immediately on mount
    poll();

    return () => {
      stopped = true;
      clearInterval(interval);
    };
  }, [nodes, selectedNodeId]);

  const selectedNodeIndex = useMemo(
    () => nodes.findIndex((n) => n.id === selectedNodeId),
    [nodes, selectedNodeId]
  );

  const selectedNode = useMemo(
    () => nodes[selectedNodeIndex],
    [nodes, selectedNodeIndex]
  );

  const prevNode = selectedNodeIndex > 0 ? nodes[selectedNodeIndex - 1] : null;
  const nextNode =
    selectedNodeIndex >= 0 && selectedNodeIndex < nodes.length - 1
      ? nodes[selectedNodeIndex + 1]
      : null;

  // Collect all resources for the selected node: node-level ones first,
  // then per-understanding ones (shown inline beneath each understanding).
  const nodeResources = selectedNode
    ? resourcesByTarget[`node:${selectedNode.id}`] ?? []
    : [];
  const selectedTopicResourceCount = nodeResources.length;

  return (
    <div className="flex flex-col md:flex-row flex-1 min-h-[calc(100vh-65px)]">
      {/* Mobile Topic Switcher (< 768px) */}
      <div className="md:hidden border-b border-border-default bg-surface-card px-4 py-3 sticky top-[65px] z-20 shadow-xs">
        <label
          htmlFor="mobile-topic-selector"
          className="block text-[11px] font-semibold uppercase tracking-wider text-text-secondary mb-1"
        >
          Select Topic ({selectedNode?.order_index} of {nodes.length})
        </label>
        <div className="relative">
          <select
            id="mobile-topic-selector"
            value={selectedNodeId}
            onChange={(e) => setSelectedNodeId(e.target.value)}
            className="w-full rounded-lg border border-border-default bg-surface-card px-3 py-2 text-sm font-medium text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-forest appearance-none pr-8 cursor-pointer shadow-xs"
          >
            {nodes.map((node) => (
              <option key={node.id} value={node.id}>
                {node.order_index}. {node.title}{" "}
                {node.exam_weight_pct ? `(${node.exam_weight_pct})` : ""}
              </option>
            ))}
          </select>
          <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-text-tertiary text-xs">
            ▾
          </span>
        </div>
      </div>

      {/* Desktop Left Rail (>= 768px) */}
      <nav className="w-72 lg:w-80 shrink-0 border-r border-border-default bg-surface-card overflow-y-auto sticky top-[65px] h-[calc(100vh-65px)] hidden md:block">
        <div className="px-5 pt-5 pb-3 flex items-center justify-between border-b border-border-subtle">
          <p className="text-xs font-display font-semibold uppercase tracking-[0.16em] text-text-secondary">
            Curriculum Topics
          </p>
          <span className="text-xs font-mono text-text-tertiary">
            {nodes.length} units
          </span>
        </div>
        <ol>
          {nodes.map((node) => {
            const isSelected = node.id === selectedNodeId;
            const muCount = node.major_understandings.length;
            const resourceCount = Object.entries(resourcesByTarget)
              .filter(
                ([key]) =>
                  key === `node:${node.id}` ||
                  node.major_understandings.some(
                    (mu) => key === `mu:${mu.id}`
                  )
              )
              .reduce((sum, [, rs]) => sum + rs.length, 0);

            return (
              <li key={node.id}>
                <button
                  type="button"
                  onClick={() => setSelectedNodeId(node.id)}
                  className={`w-full text-left px-5 py-4 border-b border-border-subtle transition-all ${
                    isSelected
                      ? "bg-brand-aqua-tint/40 border-l-[3px] border-l-brand-forest"
                      : "hover:bg-canvas-subtle border-l-[3px] border-l-transparent"
                  }`}
                >
                  <p
                    className={`font-display text-sm leading-snug font-semibold ${
                      isSelected ? "text-brand-navy" : "text-text-primary"
                    }`}
                  >
                    {node.order_index}. {node.title}
                  </p>
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    <span className="text-[11px] text-text-tertiary">
                      {muCount} concept{muCount !== 1 ? "s" : ""}
                    </span>
                    {resourceCount > 0 && (
                      <>
                        <span className="text-border-default">·</span>
                        <span className="text-[11px] font-medium text-brand-forest">
                          {resourceCount} resource{resourceCount !== 1 ? "s" : ""}
                        </span>
                      </>
                    )}
                    {node.exam_weight_pct && (
                      <>
                        <span className="text-border-default">·</span>
                        <span className="text-[11px] font-mono text-text-tertiary">
                          {node.exam_weight_pct}
                        </span>
                      </>
                    )}
                  </div>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      {/* Right Content Pane */}
      <div className="flex-1 overflow-y-auto">
        {selectedNode && (
          <div className="max-w-3xl mx-auto px-6 sm:px-10 py-8 sm:py-10">
            {/* Topic header */}
            <div className="mb-8 pb-6 border-b border-border-subtle">
              <p className="text-xs font-display font-semibold uppercase tracking-[0.18em] text-brand-forest mb-2">
                Topic {selectedNode.order_index}
                {selectedNode.exam_weight_pct &&
                  ` · ${selectedNode.exam_weight_pct} of exam`}
              </p>
              <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-brand-navy leading-tight">
                {selectedNode.title}
              </h2>
              {selectedNode.claim_statement && (
                <p className="text-sm text-text-secondary mt-2.5 leading-relaxed italic">
                  {selectedNode.claim_statement}
                </p>
              )}
              {coverageStatus === "insufficient" && selectedTopicResourceCount < 3 && (
                <p className="mt-3 text-sm text-amber-800" role="status">
                  Resource coverage is incomplete: {selectedTopicResourceCount} verified resources are available for this topic; the quality target is at least 3.
                </p>
              )}
              {coverageStatus === "failed" && (
                <p className="mt-3 text-sm text-red-800" role="status">
                  Resource discovery failed before coverage could be confirmed.
                </p>
              )}
            </div>

            {/* Topic-level resources */}
            {nodeResources.length > 0 &&
              (() => {
                const learning = nodeResources.filter(
                  (r) =>
                    r.resource_type !== "problem_set" &&
                    r.resource_type !== "practice_exam"
                );
                const practice = nodeResources.filter(
                  (r) =>
                    r.resource_type === "problem_set" ||
                    r.resource_type === "practice_exam"
                );
                return (
                  <div className="mb-8 space-y-4">
                    {learning.length > 0 && (
                      <div className="rounded-xl border border-border-default bg-surface-card p-5 shadow-xs">
                        <p className="text-xs font-semibold uppercase tracking-wider text-text-secondary mb-3 flex items-center gap-1.5">
                          <span>📚</span>
                          <span>Unit Learning Resources</span>
                        </p>
                        <div className="divide-y divide-border-subtle">
                          {learning.map((r) => (
                            <ResourceLink key={r.id} resource={r} />
                          ))}
                        </div>
                      </div>
                    )}
                    {practice.length > 0 && (
                      <div className="rounded-xl border border-border-default bg-surface-card p-5 shadow-xs">
                        <p className="text-xs font-semibold uppercase tracking-wider text-text-secondary mb-3 flex items-center gap-1.5">
                          <span>✍️</span>
                          <span>Unit Practice Problems</span>
                        </p>
                        <div className="divide-y divide-border-subtle">
                          {practice.map((r) => (
                            <ResourceLink key={r.id} resource={r} />
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })()}

            {/* Major understandings, each with their own resources */}
            <div className="space-y-4">
              <div className="mb-2">
                <p className="text-xs font-display font-semibold uppercase tracking-[0.16em] text-text-tertiary">
                  Key Concepts & Understandings
                </p>
              </div>

              {selectedNode.major_understandings.map((mu) => {
                const muResources = resourcesByTarget[`mu:${mu.id}`] ?? [];

                return (
                  <div
                    key={mu.id}
                    className="rounded-xl border border-border-default bg-surface-card p-5 shadow-xs transition hover:border-border-hover"
                  >
                    <div className="flex items-start gap-3">
                      <span className="shrink-0 font-mono text-xs font-semibold text-brand-forest bg-brand-aqua-tint px-2.5 py-1 rounded border border-brand-aqua/40">
                        {mu.code ?? mu.external_key}
                      </span>
                      <p className="text-sm sm:text-base text-text-primary leading-relaxed font-normal flex-1">
                        {mu.description}
                      </p>
                    </div>

                    {muResources.length > 0 &&
                      (() => {
                        const learning = muResources.filter(
                          (r) =>
                            r.resource_type !== "problem_set" &&
                            r.resource_type !== "practice_exam"
                        );
                        const practice = muResources.filter(
                          (r) =>
                            r.resource_type === "problem_set" ||
                            r.resource_type === "practice_exam"
                        );
                        return (
                          <div className="mt-3.5 pt-3 border-t border-border-subtle space-y-3">
                            {learning.length > 0 && (
                              <div>
                                <p className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary mb-1">
                                  Learning resources
                                </p>
                                {learning.map((r) => (
                                  <ResourceLink key={r.id} resource={r} />
                                ))}
                              </div>
                            )}
                            {practice.length > 0 && (
                              <div>
                                <p className="text-[11px] font-semibold uppercase tracking-wider text-text-tertiary mb-1">
                                  Practice exercises
                                </p>
                                {practice.map((r) => (
                                  <ResourceLink key={r.id} resource={r} />
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })()}

                    {muResources.length === 0 && (
                      generationFinished ? (
                        <p className="text-xs text-text-tertiary mt-2.5 italic flex items-center gap-1.5">
                          <span>⚠</span>
                          <span>
                            No verified resources were found for this concept.
                          </span>
                        </p>
                      ) : (
                        <p className="text-xs text-text-tertiary mt-2.5 italic flex items-center gap-1.5">
                          <span>⏳</span>
                          <span>Finding verified resources…</span>
                        </p>
                      )
                    )}
                    {generationFinished && coverageStatus === "insufficient" && muResources.length > 0 && muResources.length < 2 && (
                      <p className="mt-2 text-xs text-amber-800" role="status">
                        Coverage is incomplete: {muResources.length} verified resource{muResources.length === 1 ? " is" : "s are"} available; the quality target is at least 2.
                      </p>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Empty state if no resources anywhere on this topic yet */}
            {nodeResources.length === 0 &&
              selectedNode.major_understandings.every(
                (mu) => (resourcesByTarget[`mu:${mu.id}`] ?? []).length === 0
              ) && (
                <div className="mt-8 rounded-xl border border-dashed border-border-default bg-surface-card px-6 py-10 text-center">
                  {generationFinished ? (
                    <p className="text-sm text-text-secondary">
                      {coverageStatus === "failed"
                        ? "Resource discovery failed before verified resources could be confirmed."
                        : "No verified resources were found for this topic. Coverage is insufficient."}
                    </p>
                  ) : (
                    <p className="text-sm text-text-secondary">
                      No resources verified for this topic yet. The discovery process runs in the background.
                    </p>
                  )}
                </div>
              )}

            {/* Mobile Topic Navigation Footer */}
            <div className="mt-10 pt-6 border-t border-border-default flex items-center justify-between gap-3 md:hidden">
              {prevNode ? (
                <button
                  type="button"
                  onClick={() => setSelectedNodeId(prevNode.id)}
                  className="text-xs font-medium px-3.5 py-2.5 rounded-lg border border-border-default bg-surface-card hover:bg-canvas-subtle transition flex items-center gap-1 text-text-secondary shadow-xs"
                >
                  ← Topic {prevNode.order_index}
                </button>
              ) : (
                <div />
              )}
              {nextNode ? (
                <button
                  type="button"
                  onClick={() => setSelectedNodeId(nextNode.id)}
                  className="text-xs font-medium px-3.5 py-2.5 rounded-lg bg-brand-forest text-white hover:bg-brand-forest-hover transition flex items-center gap-1 shadow-xs ml-auto"
                >
                  Topic {nextNode.order_index} →
                </button>
              ) : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}