"use client";

import { useState, useMemo, useEffect  } from "react";
import type { NodeWithChildren, Resource } from "@/lib/curriculum-data";

const RESOURCE_TYPE_LABEL: Record<string, string> = {
  video: "Video",
  text: "Reading",
  textbook: "Textbook",
  problem_set: "Problem set",
  reference_tool: "Reference",
  practice_exam: "Practice exam",
  other: "Resource",
};

const RESOURCE_TYPE_COLOR: Record<string, string> = {
  video: "bg-[#E8EEF8] text-[#3D5FA0]",
  text: "bg-[#F0EDE3] text-[#5A564A]",
  textbook: "bg-[#F0EDE3] text-[#5A564A]",
  problem_set: "bg-[#E8F2EA] text-[#3D7A4F]",
  reference_tool: "bg-[#F5EFF8] text-[#6B4A8A]",
  practice_exam: "bg-[#FBF3E6] text-[#B8753D]",
  other: "bg-[#F0EDE3] text-[#5A564A]",
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
    <div className="flex items-start gap-3 py-2.5 border-b border-[#F0EDE3] last:border-0">
      <span
        className={`shrink-0 text-xs px-2 py-0.5 rounded-full mt-0.5 ${typeColor}`}
      >
        {typeLabel}
      </span>
      <div className="min-w-0">
        <a
          href={resource.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-medium text-[#1A1A18] hover:text-[#B8753D] underline decoration-[#D8D4C8] underline-offset-2 break-words"
        >
          {resource.title}
        </a>
        {resource.source_domain && (
          <span className="text-xs text-[#8A8578] ml-2">
            {resource.source_domain}
          </span>
        )}
        {displayNote && (
          <p className="text-xs text-[#8A8578] mt-0.5 italic">
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

  // Poll for background resource updates every 30 seconds
  // Stops once all understandings have resources
  useEffect(() => {
    // Extract curriculum_id from the first node
    const curriculumId = nodes[0]?.curriculum_id;
    if (!curriculumId) return;

    let stopped = false;

    async function poll() {
      const res = await fetch(`/api/curricula/${curriculumId}/progress`);
      if (!res.ok) return;
      const data = await res.json() as {
        total: number;
        with_resources: number;
        complete: boolean;
      };

      if (data.complete) {
        stopped = true;
        return;
      }

      // Refetch all resources for the current node
      if (selectedNodeId) {
        const nodeRes = await fetch(`/api/resources?node_id=${selectedNodeId}`);
        if (nodeRes.ok) {
          const nodeData = await nodeRes.json();
          // Also fetch MU resources
          const currentNode = nodes.find((n) => n.id === selectedNodeId);
          if (currentNode) {
            const muFetches = currentNode.major_understandings.map(async (mu) => {
              const muRes = await fetch(
                `/api/resources?major_understanding_id=${mu.id}`
              );
              if (muRes.ok) {
                const muData = await muRes.json();
                setResourcesByTarget((prev) => ({
                  ...prev,
                  [`mu:${mu.id}`]: muData.resources,
                }));
              }
            });
            await Promise.all(muFetches);
          }
          setResourcesByTarget((prev) => ({
            ...prev,
            [`node:${selectedNodeId}`]: nodeData.resources,
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

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedNodeId),
    [nodes, selectedNodeId]
  );

  // Collect all resources for the selected node: node-level ones first,
  // then per-understanding ones (shown inline beneath each understanding).
  const nodeResources = selectedNode
    ? (resourcesByTarget[`node:${selectedNode.id}`] ?? [])
    : [];

  return (
    <div className="flex min-h-[calc(100vh-65px)]">
      {/* Left rail */}
      <nav className="w-72 shrink-0 border-r border-[#E7E3D7] bg-white overflow-y-auto sticky top-0 h-[calc(100vh-65px)]">
        <p className="px-5 pt-5 pb-2 text-xs uppercase tracking-[0.15em] text-[#8A8578]">
          Topics
        </p>
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
                  onClick={() => setSelectedNodeId(node.id)}
                  className={`w-full text-left px-5 py-3.5 border-b border-[#F0EDE3] transition ${
                    isSelected
                      ? "bg-[#FBF3E6] border-l-2 border-l-[#B8753D]"
                      : "hover:bg-[#FAFAF7] border-l-2 border-l-transparent"
                  }`}
                >
                  <p
                    className={`font-serif text-sm leading-snug ${
                      isSelected ? "text-[#1A1A18]" : "text-[#3A3730]"
                    }`}
                  >
                    {node.order_index}. {node.title}
                  </p>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-[10px] text-[#8A8578]">
                      {muCount} concepts
                    </span>
                    {resourceCount > 0 && (
                      <>
                        <span className="text-[#D8D4C8]">·</span>
                        <span className="text-[10px] text-[#B8753D]">
                          {resourceCount} resource{resourceCount !== 1 ? "s" : ""}
                        </span>
                      </>
                    )}
                    {node.exam_weight_pct && (
                      <>
                        <span className="text-[#D8D4C8]">·</span>
                        <span className="text-[10px] text-[#8A8578]">
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

      {/* Right pane */}
      <div className="flex-1 overflow-y-auto">
        {selectedNode && (
          <div className="max-w-2xl mx-auto px-8 py-10">
            {/* Topic header */}
            <div className="mb-8">
              <p className="text-xs uppercase tracking-[0.18em] text-[#8A8578] mb-1">
                Topic {selectedNode.order_index}
                {selectedNode.exam_weight_pct &&
                  ` · ${selectedNode.exam_weight_pct} of exam`}
              </p>
              <h2 className="font-serif text-3xl leading-tight">
                {selectedNode.title}
              </h2>
            </div>

            {/* Topic-level resources (apply to whole topic, not a specific understanding) */}
            {nodeResources.length > 0 && (() => {
                const learning = nodeResources.filter(
                    (r) => r.resource_type !== "problem_set" && r.resource_type !== "practice_exam"
                );
                const practice = nodeResources.filter(
                    (r) => r.resource_type === "problem_set" || r.resource_type === "practice_exam"
                );
                return (
                    <div className="mb-8 space-y-2">
                    {learning.length > 0 && (
                        <div className="rounded-md border border-[#E7E3D7] bg-white px-5 py-4">
                        <p className="text-xs uppercase tracking-wide text-[#8A8578] mb-3">
                            Learning resources
                        </p>
                        {learning.map((r) => (
                            <ResourceLink key={r.id} resource={r} />
                        ))}
                        </div>
                    )}
                    {practice.length > 0 && (
                        <div className="rounded-md border border-[#E7E3D7] bg-white px-5 py-4">
                        <p className="text-xs uppercase tracking-wide text-[#8A8578] mb-3">
                            Practice problems
                        </p>
                        {practice.map((r) => (
                            <ResourceLink key={r.id} resource={r} />
                        ))}
                        </div>
                    )}
                    </div>
                );
                })()}

            {/* Major understandings, each with their own resources */}
            <div className="space-y-6">
              {selectedNode.major_understandings.map((mu, i) => {
                const muResources =
                  resourcesByTarget[`mu:${mu.id}`] ?? [];

                return (
                  <div key={mu.id} className="group">
                    <div className="flex items-baseline gap-3 mb-2">
                      <span className="shrink-0 font-mono text-xs text-[#B8753D] bg-[#FBF3E6] px-2 py-0.5 rounded">
                        {mu.code ?? mu.external_key}
                      </span>
                      <p className="text-[#1A1A18] leading-relaxed">
                        {mu.description}
                      </p>
                    </div>

                    {muResources.length > 0 && (() => {
                        
                    const learning = muResources.filter(
                        (r) => r.resource_type !== "problem_set" && r.resource_type !== "practice_exam"
                    );
                    const practice = muResources.filter(
                        (r) => r.resource_type === "problem_set" || r.resource_type === "practice_exam"
                    );
                    return (
                        <div className="mt-2 space-y-2">
                        {learning.length > 0 && (
                            <div className="rounded-md border border-[#E7E3D7] bg-white px-4 py-1">
                            <p className="text-[10px] uppercase tracking-wide text-[#8A8578] pt-2 pb-1">
                                Learning resources
                            </p>
                            {learning.map((r) => (
                                <ResourceLink key={r.id} resource={r} />
                            ))}
                            </div>
                        )}
                        {practice.length > 0 && (
                            <div className="rounded-md border border-[#E7E3D7] bg-white px-4 py-1">
                            <p className="text-[10px] uppercase tracking-wide text-[#8A8578] pt-2 pb-1">
                                Practice problems
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
                      <p className="text-xs text-[#8A8578] mt-1 italic">
                        Finding resources…
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
                <div className="mt-6 rounded-md border border-dashed border-[#D8D4C8] px-6 py-8 text-center">
                  <p className="text-sm text-[#8A8578]">
                    No resources added for this topic yet.
                  </p>
                </div>
              )}
          </div>
        )}
      </div>
    </div>
  );
}