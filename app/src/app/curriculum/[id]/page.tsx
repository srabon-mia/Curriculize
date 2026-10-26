import { notFound } from "next/navigation";
import {
  getCurriculum,
  getNodesWithUnderstandings,
  getResourcesForTargets,
  selectEligibleResources,
  type Resource,
} from "@/lib/curriculum-data";
import { CurriculumViewer } from "@/components/CurriculumViewer";
import { CurriculumHeader } from "@/components/CurriculumHeader";

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

  const eligible = selectEligibleResources(allResources);

  const resourcesByTarget: Record<string, Resource[]> = {};
  for (const r of eligible) {
    const key = r.node_id
      ? `node:${r.node_id}`
      : `mu:${r.major_understanding_id}`;
    if (!resourcesByTarget[key]) resourcesByTarget[key] = [];
    resourcesByTarget[key].push(r);
  }

  return (
    <div className="min-h-screen bg-canvas-default text-text-primary flex flex-col">
      <CurriculumHeader
        title={curriculum.title}
        subject={curriculum.subject}
        source_type={curriculum.source_type}
        source_attribution={curriculum.source_attribution}
        source_url={curriculum.source_url}
      />

      <CurriculumViewer nodes={nodes} resourcesByTarget={resourcesByTarget} />
    </div>
  );
}