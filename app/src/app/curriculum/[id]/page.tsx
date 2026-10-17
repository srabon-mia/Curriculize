import { notFound } from "next/navigation";
import Link from "next/link";
import {
  getCurriculum,
  getNodesWithUnderstandings,
  getResourcesForTargets,
  type Resource,
} from "@/lib/curriculum-data";
import { CurriculumViewer } from "@/components/CurriculumViewer";

export const dynamic = "force-dynamic";

export default async function CurriculumViewerPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const curriculum = await getCurriculum(id);
  if (!curriculum || curriculum.status !== "published") notFound();

  const nodes = await getNodesWithUnderstandings(id);

  const nodeIds = nodes.map((n) => n.id);
  const muIds = nodes.flatMap((n) =>
    n.major_understandings.map((mu) => mu.id)
  );
  const allResources = await getResourcesForTargets(nodeIds, muIds);

  const approved = allResources.filter((r) => r.status === "approved");

  const resourcesByTarget: Record<string, Resource[]> = {};
  for (const r of approved) {
    const key = r.node_id
      ? `node:${r.node_id}`
      : `mu:${r.major_understanding_id}`;
    if (!resourcesByTarget[key]) resourcesByTarget[key] = [];
    resourcesByTarget[key].push(r);
  }

  return (
    <div className="min-h-screen bg-canvas-default text-text-primary flex flex-col">
      <header className="border-b border-border-default bg-surface-card/95 backdrop-blur-sm px-6 py-3.5 sticky top-0 z-30 transition-colors">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <Link
                href="/curriculum"
                className="text-xs font-medium text-text-secondary hover:text-brand-forest transition flex items-center gap-1"
              >
                <span>←</span>
                <span>Browse Guides</span>
              </Link>
              <span className="text-text-tertiary text-xs">/</span>
              <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-brand-forest bg-brand-aqua-tint px-2 py-0.5 rounded-full border border-brand-aqua/40">
                {curriculum.subject}
              </span>
            </div>
            <h1 className="font-display text-lg sm:text-xl font-bold text-brand-navy leading-tight truncate">
              {curriculum.title}
            </h1>
          </div>

          {curriculum.source_attribution && (
            <div className="text-xs text-text-secondary hidden sm:block max-w-xs text-right shrink-0">
              <span className="text-text-tertiary">Adapted from </span>
              {curriculum.source_url ? (
                <a
                  href={curriculum.source_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-brand-forest hover:underline underline-offset-2"
                >
                  {curriculum.source_attribution} ↗
                </a>
              ) : (
                <span className="font-medium text-text-primary">
                  {curriculum.source_attribution}
                </span>
              )}
            </div>
          )}
        </div>
      </header>

      <CurriculumViewer nodes={nodes} resourcesByTarget={resourcesByTarget} />
    </div>
  );
}