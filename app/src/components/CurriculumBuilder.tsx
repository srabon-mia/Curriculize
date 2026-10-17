"use client";

import { useState, useCallback } from "react";
import type { NodeWithChildren, Resource, MajorUnderstanding } from "@/lib/curriculum-data";
import { ResourceCard } from "./ResourceCard";
import { AddResourceForm } from "./AddResourceForm";

type Selected =
  | { type: "node"; id: string }
  | { type: "mu"; id: string; nodeId: string }
  | null;

function weightBarWidth(pct: string | null): number {
  if (!pct) return 0;
  // "30-40%" -> take the upper bound for the bar, "5-7%" -> 7, etc.
  const match = pct.match(/(\d+)(?:-(\d+))?/);
  if (!match) return 0;
  const upper = match[2] ? parseInt(match[2], 10) : parseInt(match[1], 10);
  return Math.min(upper, 50); // cap visual scale at 50% width-equivalent
}

export function CurriculumBuilder({
  nodes: initialNodes,
  resourcesByTarget,
  curriculumId,
}: {
  nodes: NodeWithChildren[];
  resourcesByTarget: Record<string, Resource[]>;
  curriculumId: string;
}) {
  const [expandedNodeIds, setExpandedNodeIds] = useState<Set<string>>(
    new Set(initialNodes[0] ? [initialNodes[0].id] : [])
  );
  const [selected, setSelected] = useState<Selected>(
    initialNodes[0] ? { type: "node", id: initialNodes[0].id } : null
  );
  const [resources, setResources] = useState(resourcesByTarget);
  const [refreshKey, setRefreshKey] = useState(0);
  const [discovering, setDiscovering] = useState(false);
  const [discoverResult, setDiscoverResult] = useState<string | null>(null);

  async function handleDiscover(granularity: "topic" | "understanding" | "bulk") {
    if (!selected || !selectedNode) return;
    setDiscovering(true);
    setDiscoverResult(null);

    if (granularity === "bulk") {
      // Run each MU as a separate request from the frontend
      // instead of one long backend loop that times out
      const mus = selectedNode.major_understandings;
      let inserted = 0;

      for (let i = 0; i < mus.length; i++) {
        const mu = mus[i];
        setDiscoverResult(`Searching ${i + 1} of ${mus.length}: ${mu.code ?? mu.external_key}…`);

        // Wait between calls to stay under the 30k tokens/min rate limit
        if (i > 0) await new Promise((resolve) => setTimeout(resolve, 60000));

        try {
          const res = await fetch("/api/discover", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              curriculum_id: curriculumId,
              node_id: selectedNode.id,
              granularity: "understanding",
              major_understanding_id: mu.id,
            }),
          });
          const data = await res.json();
          if (res.ok) inserted += data.inserted ?? 0;
        } catch {
          // continue to next MU even if one fails
        }
      }

      setDiscoverResult(`Done — ${inserted} resources added across ${mus.length} understandings`);
      setTimeout(() => refreshResources(), 500);
      setDiscovering(false);
      return;
    }

    // Single topic or single understanding
    const body: Record<string, unknown> = {
      curriculum_id: curriculumId,
      node_id: selectedNode.id,
      granularity,
    };

    if (granularity === "understanding" && selected.type === "mu") {
      body.major_understanding_id = selected.id;
    }

    try {
      const res = await fetch("/api/discover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      setDiscoverResult(data.message ?? data.error ?? "Done");
      if (res.ok) {
        setTimeout(() => refreshResources(), 500);
      }
    } catch {
      setDiscoverResult("Something went wrong");
    } finally {
      setDiscovering(false);
    }
  }

  const toggleExpand = (nodeId: string) => {
    setExpandedNodeIds((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  };

  const selectedNode = initialNodes.find(
    (n) => n.id === (selected?.type === "node" ? selected.id : selected?.nodeId)
  );

  const selectedMu: MajorUnderstanding | undefined =
    selected?.type === "mu" && selectedNode
      ? selectedNode.major_understandings.find((mu) => mu.id === selected.id)
      : undefined;

  const targetKey = selected
    ? selected.type === "node"
      ? `node:${selected.id}`
      : `mu:${selected.id}`
    : null;

  const refreshResources = useCallback(async () => {
    if (!targetKey) return;
    const [kind, id] = targetKey.split(":");
    const param = kind === "node" ? "node_id" : "major_understanding_id";
    const res = await fetch(`/api/resources?${param}=${id}`);
    if (res.ok) {
      const data = await res.json();
      setResources((prev) => ({ ...prev, [targetKey]: data.resources }));
    }
    setRefreshKey((k) => k + 1);
  }, [targetKey]);

  async function updateResourceStatus(id: string, status: "approved" | "rejected") {
    await fetch(`/api/resources/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    refreshResources();
  }

  async function handleDelete(id: string) {
    await fetch(`/api/resources/${id}`, { method: "DELETE" });
    refreshResources();
  }

  const currentResources = targetKey ? resources[targetKey] ?? [] : [];

  return (
    <div className="flex min-h-[calc(100vh-1px)]">
      {/* Left rail: topic tree */}
      <nav className="w-80 shrink-0 border-r border-border-default bg-surface-card overflow-y-auto">
        <ol>
          {initialNodes.map((node) => {
            const isExpanded = expandedNodeIds.has(node.id);
            const isSelected = selected?.type === "node" && selected.id === node.id;
            const barWidth = weightBarWidth(node.exam_weight_pct);

            return (
              <li key={node.id} className="border-b border-border-subtle">
                <div
                  className={`flex items-start gap-2 px-4 py-3 cursor-pointer transition ${
                    isSelected ? "bg-brand-forest-subtle" : "hover:bg-canvas-subtle"
                  }`}
                  onClick={() => {
                    setSelected({ type: "node", id: node.id });
                    if (!isExpanded) toggleExpand(node.id);
                  }}
                >
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleExpand(node.id);
                    }}
                    className="mt-0.5 text-text-muted hover:text-text-primary text-xs w-4 shrink-0"
                    aria-label={isExpanded ? "Collapse" : "Expand"}
                  >
                    {isExpanded ? "▾" : "▸"}
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className={`font-display text-sm leading-snug ${isSelected ? "font-semibold text-brand-forest" : "text-text-primary"}`}>
                      {node.order_index}. {node.title}
                    </p>
                    {node.exam_weight_pct && (
                      <div className="flex items-center gap-2 mt-1.5">
                        <div className="h-1 flex-1 bg-border-subtle rounded-full overflow-hidden max-w-[80px]">
                          <div
                            className="h-full bg-brand-forest rounded-full"
                            style={{ width: `${(barWidth / 50) * 100}%` }}
                          />
                        </div>
                        <span className="text-[10px] text-text-muted tabular-nums">
                          {node.exam_weight_pct}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                {isExpanded && (
                  <ul className="pb-1 bg-surface-card/50">
                    {node.major_understandings.map((mu) => {
                      const muSelected = selected?.type === "mu" && selected.id === mu.id;
                      return (
                        <li key={mu.id}>
                          <button
                            onClick={() => setSelected({ type: "mu", id: mu.id, nodeId: node.id })}
                            className={`w-full text-left px-4 pl-10 py-1.5 text-xs leading-snug transition ${
                              muSelected
                                ? "bg-brand-forest-subtle text-brand-forest font-medium"
                                : "text-text-secondary hover:bg-canvas-subtle"
                            }`}
                          >
                            <span className="text-brand-forest font-mono mr-1.5 font-semibold">
                              {mu.code ?? mu.external_key}
                            </span>
                            {mu.description.length > 70
                              ? mu.description.slice(0, 70) + "…"
                              : mu.description}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ol>
      </nav>

      {/* Right pane: detail + resources */}
      <div className="flex-1 overflow-y-auto bg-canvas-default">
        <div className="max-w-2xl mx-auto px-8 py-10">
          {!selected && <p className="text-text-muted">Select a topic to begin.</p>}

          {selected?.type === "node" && selectedNode && (
            <>
              <p className="text-xs uppercase tracking-[0.18em] text-text-muted mb-2 font-medium">
                Topic {selectedNode.order_index}
                {selectedNode.exam_weight_pct ? ` · ${selectedNode.exam_weight_pct} of exam` : ""}
              </p>
              <h1 className="font-display text-2xl font-bold text-brand-navy mb-1">{selectedNode.title}</h1>
              {selectedNode.claim_statement && (
                <p className="text-text-secondary mt-3 leading-relaxed">{selectedNode.claim_statement}</p>
              )}
              <p className="text-sm text-text-muted mt-4">
                {selectedNode.major_understandings.length} major understandings — select one on the
                left to attach resources at that granularity, or add a resource for the whole topic
                below.
              </p>
            </>
          )}

          {selected?.type === "mu" && selectedMu && selectedNode && (
            <>
              <p className="text-xs uppercase tracking-[0.18em] text-text-muted mb-2 font-medium">
                {selectedNode.title} · {selectedMu.code ?? selectedMu.external_key}
              </p>
              <h1 className="font-display text-xl font-bold text-brand-navy leading-snug">{selectedMu.description}</h1>
            </>
          )}

          {selected && (
            <div className="mt-8 space-y-4" key={refreshKey}>
              <div className="flex items-center justify-between gap-4 flex-wrap">
                <h2 className="text-xs font-semibold text-text-muted uppercase tracking-wider">
                  Resources ({currentResources.length})
                </h2>
                <div className="flex gap-2 flex-wrap">
                  <button
                    onClick={() => handleDiscover("topic")}
                    disabled={discovering}
                    className="text-xs px-3 py-1.5 rounded-lg border border-border-default bg-surface-card text-text-secondary hover:border-brand-forest hover:text-brand-forest transition disabled:opacity-50 shadow-2xs font-medium"
                  >
                    {discovering ? "Searching…" : "Find resources for topic"}
                  </button>
                  <button
                    onClick={() => handleDiscover("bulk")}
                    disabled={discovering}
                    className="text-xs px-3 py-1.5 rounded-lg bg-brand-navy text-white hover:bg-brand-navy/90 transition disabled:opacity-50 shadow-2xs font-medium"
                  >
                    {discovering ? "Searching…" : "Find all understandings"}
                  </button>
                  {selected.type === "mu" && (
                    <button
                      onClick={() => handleDiscover("understanding")}
                      disabled={discovering}
                      className="text-xs px-3 py-1.5 rounded-lg border border-border-default bg-surface-card text-text-secondary hover:border-brand-forest hover:text-brand-forest transition disabled:opacity-50 shadow-2xs font-medium"
                    >
                      {discovering ? "Searching…" : "Find resources for this concept"}
                    </button>
                  )}
                </div>
              </div>

              {discoverResult && (
                <p className="text-xs text-status-success bg-status-success-bg border border-status-success/20 px-3 py-2 rounded-lg font-medium">
                  {discoverResult}
                </p>
              )}

              {currentResources.length === 0 && (
                <p className="text-sm text-text-muted">No resources attached yet.</p>
              )}

              {currentResources.map((r) => (
                <ResourceCard
                  key={r.id}
                  resource={r}
                  onApprove={(id) => updateResourceStatus(id, "approved")}
                  onReject={(id) => updateResourceStatus(id, "rejected")}
                  onDelete={(id) => handleDelete(id)}
                />
              ))}

              <AddResourceForm
                targetType={selected.type === "node" ? "node" : "major_understanding"}
                targetId={selected.id}
                onAdded={refreshResources}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
