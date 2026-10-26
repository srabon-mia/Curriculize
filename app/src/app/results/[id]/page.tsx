import Link from "next/link";
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { canReadCurriculumResult, resultAccessCookieName, splitResultResources, verifyResultAccessToken } from "@/lib/generation/resultAccess";
import { CurriculumViewer } from "@/components/CurriculumViewer";
import { CurriculumHeader } from "@/components/CurriculumHeader";
import type { NodeWithChildren, Resource } from "@/lib/curriculum-data";

export const dynamic = "force-dynamic";

type SavedUnderstanding = { id?: string | null; code?: string | null; description: string; order_index?: number };
type SavedTopic = { id?: string | null; title: string; order_index?: number; major_understandings?: SavedUnderstanding[] };

const service = createServiceClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export default async function GenerationResultsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [{ data: curriculum }, userClient, cookieStore] = await Promise.all([
    service.from("curricula").select("id, title, subject, status, created_by, source_type, source_attribution, source_url").eq("id", id).maybeSingle(),
    createClient(),
    cookies(),
  ]);
  if (!curriculum) notFound();

  const { data: authData } = await userClient.auth.getUser();
  const { data: adminRow } = authData.user
    ? await service.from("admins").select("user_id").eq("user_id", authData.user.id).maybeSingle()
    : { data: null };
  const resultToken = cookieStore.get(resultAccessCookieName(id))?.value;
  const allowed = canReadCurriculumResult({
    published: curriculum.status === "published",
    createdBy: curriculum.created_by ?? null,
    userId: authData.user?.id ?? null,
    isAdmin: Boolean(adminRow),
    hasValidResultToken: verifyResultAccessToken(
      id,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      resultToken
    ),
  });
  if (!allowed) notFound();

  const [{ data: savedNodes }, { data: jobs }] = await Promise.all([
    service.from("nodes")
      .select("id, external_key, title, order_index, major_understandings(id, code, description, order_index)")
      .eq("curriculum_id", id)
      .order("order_index", { ascending: true }),
    service.from("acquisition_jobs")
      .select("status, result_data")
      .eq("curriculum_id", id)
      .eq("job_type", "curriculum_generation")
      .order("created_at", { ascending: false })
      .limit(1),
  ]);

  const job = jobs?.[0];
  const resultData = job?.result_data && typeof job.result_data === "object"
    ? job.result_data as { skeleton?: { nodes?: SavedTopic[] }; resourceCoverage?: Record<string, { status?: string }> }
    : null;
  const storedNodes = (savedNodes ?? []) as Array<SavedTopic & { id: string; external_key: string | null }>;
  const persistedByExternalKey = new Map(storedNodes.map((node) => [node.external_key, node]));
  const skeletonNodes = resultData?.skeleton?.nodes ?? [];
  const topics: Array<SavedTopic & { id: string | null; major_understandings: Array<SavedUnderstanding & { id: string | null }> }> =
    skeletonNodes.length > 0
      ? skeletonNodes.map((topic, index) => {
          const topicOrder = topic.order_index ?? index + 1;
          const saved = persistedByExternalKey.get(`topic-${topicOrder}`);
          const savedMus = saved?.major_understandings ?? [];
          return {
            ...topic,
            id: saved?.id ?? null,
            major_understandings: (topic.major_understandings ?? []).map((mu, muIndex) => {
              const matched = savedMus.find((savedMu) =>
                savedMu.code === mu.code && savedMu.description === mu.description
              ) ?? savedMus[muIndex];
              return { ...mu, id: matched?.id ?? null };
            }),
          };
        })
      : storedNodes.map((topic) => ({
          ...topic,
          id: topic.id,
          major_understandings: (topic.major_understandings ?? []).map((mu) => ({ ...mu, id: mu.id ?? null })),
        }));

  const nodeIds = topics.flatMap((topic) => topic.id ? [topic.id] : []);
  const muIds = topics.flatMap((topic) => topic.major_understandings.flatMap((mu) => mu.id ? [mu.id] : []));
  const resourceRows: any[] = [];
  if (nodeIds.length) {
    const { data } = await service.from("resources")
      .select("*")
      .in("node_id", nodeIds);
    resourceRows.push(...(data ?? []));
  }
  if (muIds.length) {
    const { data } = await service.from("resources")
      .select("*")
      .in("major_understanding_id", muIds);
    resourceRows.push(...(data ?? []));
  }

  const groupedResources = new Map<string, typeof resourceRows>();
  for (const resource of resourceRows) {
    const target = resource.node_id ? `node:${resource.node_id}` : `mu:${resource.major_understanding_id}`;
    groupedResources.set(target, [...(groupedResources.get(target) ?? []), resource]);
  }
  const resourcesByTarget: Record<string, Resource[]> = {};
  const candidateResourcesByTarget: Record<string, Resource[]> = {};
  for (const [target, resources] of groupedResources) {
    const split = splitResultResources(resources);
    resourcesByTarget[target] = split.approved.filter((resource) => resource.title?.trim() && /^https?:\/\//i.test(resource.url));
    candidateResourcesByTarget[target] = split.candidates.filter((resource) => resource.title?.trim() && /^https?:\/\//i.test(resource.url));
  }
  const viewerNodes: NodeWithChildren[] = topics.map((topic, index) => {
    const nodeId = topic.id ?? `saved-topic-${index + 1}`;
    return {
      id: nodeId,
      curriculum_id: id,
      external_key: `topic-${topic.order_index ?? index + 1}`,
      title: topic.title,
      order_index: topic.order_index ?? index + 1,
      exam_weight_pct: null,
      claim_statement: null,
      major_understandings: topic.major_understandings.map((mu, muIndex) => ({
        id: mu.id ?? `saved-${nodeId}-concept-${muIndex + 1}`,
        node_id: nodeId,
        external_key: mu.code ?? null,
        code: mu.code ?? null,
        description: mu.description,
        order_index: mu.order_index ?? muIndex + 1,
      })),
    };
  });

  return (
    <div className="min-h-screen bg-canvas-default text-text-primary flex flex-col">
      <CurriculumHeader
        title={curriculum.title}
        subject={curriculum.subject}
        source_type={curriculum.source_type}
        source_attribution={curriculum.source_attribution}
        source_url={curriculum.source_url}
      />
      {viewerNodes.length === 0 ? (
        <main className="mx-auto max-w-3xl px-6 py-10">
          <section className="mt-8 rounded-xl border border-status-warning/30 bg-status-warning-bg p-5" role="status">
            <p>No curriculum structure was saved yet. Retry generation to create the curriculum outline.</p>
            <Link className="mt-3 inline-block font-medium underline" href={`/generate/${encodeURIComponent(id)}`}>Retry generation</Link>
          </section>
        </main>
      ) : <CurriculumViewer nodes={viewerNodes} resourcesByTarget={resourcesByTarget} candidateResourcesByTarget={candidateResourcesByTarget} />}
    </div>
  );
}
