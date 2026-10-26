import Link from "next/link";
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { createClient as createServiceClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { canReadCurriculumResult, resultAccessCookieName, splitResultResources, verifyResultAccessToken } from "@/lib/generation/resultAccess";
import { getStoredCoverageStatus } from "@/lib/acquisition/coverage";
import { GenerationResultResources } from "@/components/GenerationResultResources";

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
    service.from("curricula").select("id, title, subject, status, created_by").eq("id", id).maybeSingle(),
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
      .select("id, node_id, major_understanding_id, url, title, source_domain, ai_note, status, content_type_verified")
      .in("node_id", nodeIds);
    resourceRows.push(...(data ?? []));
  }
  if (muIds.length) {
    const { data } = await service.from("resources")
      .select("id, node_id, major_understanding_id, url, title, source_domain, ai_note, status, content_type_verified")
      .in("major_understanding_id", muIds);
    resourceRows.push(...(data ?? []));
  }

  const groupedResources = new Map<string, typeof resourceRows>();
  for (const resource of resourceRows) {
    const target = resource.node_id ? `node:${resource.node_id}` : `mu:${resource.major_understanding_id}`;
    groupedResources.set(target, [...(groupedResources.get(target) ?? []), resource]);
  }
  const resourcesByTarget = new Map(
    [...groupedResources.entries()].map(([target, resources]) => [target, splitResultResources(resources)])
  );

  const coverageStatus = getStoredCoverageStatus({
    jobStatus: job?.status ?? "pending",
    coverage: resultData?.resourceCoverage,
    expectedTargets: topics.length * 2,
  });
  const headline = job?.status === "failed"
    ? "Generation stopped; these saved results are still available."
    : job?.status === "completed" && coverageStatus === "insufficient"
      ? "Generation finished with insufficient resource coverage."
      : job?.status === "completed"
        ? "Generation complete."
        : "Generation is not complete; these partial results are saved.";

  return (
    <main className="min-h-screen bg-canvas-default text-text-primary px-6 py-10">
      <div className="mx-auto max-w-4xl">
        <p className="text-sm font-semibold text-brand-forest">{headline}</p>
        <h1 className="mt-2 font-display text-3xl font-bold text-brand-navy">{curriculum.title}</h1>
        <p className="mt-2 text-sm text-text-secondary">{curriculum.subject}</p>
        {topics.length === 0 ? (
          <section className="mt-8 rounded-xl border border-status-warning/30 bg-status-warning-bg p-5" role="status">
            <p>No curriculum structure was saved yet. Retry generation to create the curriculum outline.</p>
            <Link className="mt-3 inline-block font-medium underline" href={`/generate/${encodeURIComponent(id)}`}>Retry generation</Link>
          </section>
        ) : (
          <>
            {job?.status !== "completed" && (
              <p className="mt-6 rounded-lg border border-status-warning/30 bg-status-warning-bg p-4 text-sm" role="status">
                This is a partial result. Continue generation to add more saved topics and resources.
                <Link className="ml-2 font-medium underline" href={`/generate/${encodeURIComponent(id)}`}>Continue generation</Link>
              </p>
            )}
            {coverageStatus === "insufficient" && (
              <p className="mt-6 rounded-lg border border-status-warning/30 bg-status-warning-bg p-4 text-sm" role="status">
                Some topic or concept targets did not meet their resource minimums. Available approved resources and candidates are shown below.
              </p>
            )}
            {coverageStatus === "failed" && (
              <p className="mt-6 rounded-lg border border-status-error/30 bg-status-error-bg p-4 text-sm" role="status">Resource coverage could not be confirmed.</p>
            )}
            <div className="mt-8 space-y-8">
              {topics.map((topic, index) => (
                <section key={`${topic.id ?? "saved"}-${index}`} className="rounded-xl border border-border-default bg-surface-card p-5">
                  <h2 className="text-xl font-semibold text-brand-navy">{topic.title}</h2>
                  <GenerationResultResources
                    approved={topic.id ? resourcesByTarget.get(`node:${topic.id}`)?.approved ?? [] : []}
                    candidates={topic.id ? resourcesByTarget.get(`node:${topic.id}`)?.candidates ?? [] : []}
                  />
                  <div className="mt-5 space-y-4">
                    {topic.major_understandings.map((mu, muIndex) => (
                      <div key={`${mu.id ?? "saved-mu"}-${muIndex}`} className="border-t border-border-subtle pt-4">
                        <h3 className="font-medium">{mu.code ? `${mu.code} · ` : ""}{mu.description}</h3>
                        <GenerationResultResources
                          approved={mu.id ? resourcesByTarget.get(`mu:${mu.id}`)?.approved ?? [] : []}
                          candidates={mu.id ? resourcesByTarget.get(`mu:${mu.id}`)?.candidates ?? [] : []}
                        />
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </>
        )}
      </div>
    </main>
  );
}
