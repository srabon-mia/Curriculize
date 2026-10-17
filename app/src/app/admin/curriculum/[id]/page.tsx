import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import {
  getCurriculum,
  getNodesWithUnderstandings,
  getResourcesForTargets,
  type Resource,
} from "@/lib/curriculum-data";
import { CurriculumBuilder } from "@/components/CurriculumBuilder";

export const dynamic = "force-dynamic";

export default async function CurriculumDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { id } = await params;

  const curriculum = await getCurriculum(id);
  if (!curriculum) notFound();

  const nodes = await getNodesWithUnderstandings(id);

  const nodeIds = nodes.map((n) => n.id);
  const muIds = nodes.flatMap((n) => n.major_understandings.map((mu) => mu.id));
  const allResources = await getResourcesForTargets(nodeIds, muIds);

  const resourcesByTarget: Record<string, Resource[]> = {};
  for (const r of allResources) {
    const key = r.node_id ? `node:${r.node_id}` : `mu:${r.major_understanding_id}`;
    if (!resourcesByTarget[key]) resourcesByTarget[key] = [];
    resourcesByTarget[key].push(r);
  }

  return (
    <div className="min-h-screen bg-canvas-default text-text-primary">
      <header className="border-b border-border-default bg-surface-card px-6 py-3.5 flex items-center justify-between gap-4 sticky top-0 z-30">
        <div className="min-w-0">
          <Link
            href="/admin"
            className="text-xs font-medium text-text-secondary hover:text-brand-forest transition flex items-center gap-1 mb-0.5"
          >
            <span>←</span>
            <span>All curricula</span>
          </Link>
          <h1 className="font-display text-lg sm:text-xl font-bold text-brand-navy leading-tight truncate">
            {curriculum.title}
          </h1>
        </div>
        <span
          className={`text-xs px-2.5 py-1 rounded-full font-medium capitalize border shrink-0 ${
            curriculum.status === "published"
              ? "bg-status-success-bg text-status-success border-status-success/20"
              : "bg-status-warning-bg text-status-warning border-status-warning/20"
          }`}
        >
          {curriculum.status}
        </span>
      </header>

      <CurriculumBuilder nodes={nodes} resourcesByTarget={resourcesByTarget} curriculumId={id} />
    </div>
  );
}