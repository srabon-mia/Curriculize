import { cache, Suspense } from "react";
import Link from "next/link";
import { GenerateForm } from "../components/GenerateForm";
import { HeroProductPreview } from "../components/HeroProductPreview";
import { StudentHeader } from "../components/StudentHeader";
import { StudentFooter } from "../components/StudentFooter";
import {
  getCurricula,
  getNodesWithUnderstandings,
  getResourcesForTargets,
  type Curriculum,
} from "../lib/curriculum-data";

export const dynamic = "force-dynamic";

function CurriculumCard({ curriculum }: { curriculum: Curriculum }) {
  return (
    <Link
      href={`/curriculum/${curriculum.id}`}
      className="group flex h-full flex-col justify-between rounded-xl border border-border-default bg-surface-card p-5 shadow-sm transition duration-200 hover:-translate-y-0.5 hover:border-brand-forest/50 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-forest focus-visible:ring-offset-2"
    >
      <div>
        <p className="text-xs font-medium text-brand-forest">{curriculum.subject || "Learning path"}</p>
        <h3 className="mt-2 font-display text-lg font-semibold leading-snug text-brand-navy group-hover:text-brand-forest">{curriculum.title}</h3>
        {curriculum.source_attribution && <p className="mt-2 text-xs leading-relaxed text-text-secondary">Source: {curriculum.source_attribution}</p>}
      </div>
      <span className="mt-4 text-sm font-semibold text-brand-forest">Explore curriculum <span aria-hidden="true">→</span></span>
    </Link>
  );
}

function FeaturedCurricula({ curricula, failed }: { curricula: Curriculum[]; failed: boolean }) {
  return (
    <section id="curricula" className="scroll-mt-20 border-t border-border-subtle bg-canvas-default px-6 py-14 sm:py-16">
      <div className="mx-auto max-w-6xl">
        <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-forest">Already have a path in mind?</p>
            <h2 className="mt-2 font-display text-2xl font-bold tracking-tight text-brand-navy sm:text-3xl">Browse existing curricula</h2>
          </div>
          <Link href="/curriculum" className="inline-flex w-fit items-center gap-2 text-sm font-semibold text-brand-forest hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-forest focus-visible:ring-offset-2">View the full catalog <span aria-hidden="true">→</span></Link>
        </div>
        {failed ? (
          <div role="status" className="border-y border-border-default py-7">
            <p className="font-display font-semibold text-brand-navy">Curricula are temporarily unavailable</p>
            <p className="mt-1 text-sm text-text-secondary">Please try the catalog again in a little while.</p>
          </div>
        ) : curricula.length > 0 ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{curricula.slice(0, 4).map((curriculum) => <CurriculumCard key={curriculum.id} curriculum={curriculum} />)}</div>
        ) : (
          <div className="border-y border-border-default py-7">
            <p className="font-display font-semibold text-brand-navy">No curricula are published yet</p>
            <p className="mt-1 text-sm text-text-secondary">You can build a curriculum for your topic or check back as the catalog grows.</p>
          </div>
        )}
      </div>
    </section>
  );
}

function LearningSectionsLoading() {
  return (
    <div aria-live="polite" aria-busy="true" className="px-6 py-14">
      <div className="mx-auto max-w-6xl animate-pulse space-y-5">
        <div className="h-6 w-52 rounded bg-canvas-subtle" />
        <div className="grid gap-8 md:grid-cols-2">
          <div className="h-56 rounded-xl bg-canvas-subtle" />
          <div className="h-56 rounded-xl bg-canvas-subtle" />
        </div>
        <p className="sr-only">Loading learning paths…</p>
      </div>
    </div>
  );
}

const getLandingCurricula = cache(async () => {
  let publishedCurricula: Curriculum[] = [];
  let catalogFailed = false;
  try {
    const allCurricula = await getCurricula();
    publishedCurricula = allCurricula.filter((curriculum) => curriculum.status === "published");
  } catch {
    catalogFailed = true;
  }

  let previewCurriculum: {
    id: string;
    title: string;
    subject: string;
    topics: { title: string; understandings: string[]; resources: { title: string; source_domain: string | null }[] }[];
  } | null = null;
  const firstPublished = publishedCurricula[0];
  if (firstPublished) {
    try {
      const nodes = await getNodesWithUnderstandings(firstPublished.id);
      const nodeIds = nodes.map((node) => node.id);
      const understandingIds = nodes.flatMap((node) => node.major_understandings.map((item) => item.id));
      const resources = await getResourcesForTargets(nodeIds, understandingIds);
      const eligibleResources = resources.filter((resource) => resource.status === "approved" && resource.content_type_verified === true);
      previewCurriculum = {
        id: firstPublished.id,
        title: firstPublished.title,
        subject: firstPublished.subject,
        topics: nodes.slice(0, 2).map((node) => ({
          title: node.title,
          understandings: node.major_understandings.slice(0, 2).map((item) => item.description),
          resources: eligibleResources.filter((resource) => resource.node_id === node.id || node.major_understandings.some((item) => item.id === resource.major_understanding_id)).slice(0, 2).map((resource) => ({ title: resource.title, source_domain: resource.source_domain })),
        })),
      };
    } catch {
      previewCurriculum = null;
    }
  }

  return { publishedCurricula, catalogFailed, previewCurriculum };
});

function HeroPreviewLoading() {
  return (
    <div aria-live="polite" aria-busy="true" className="min-h-64 animate-pulse border border-border-default bg-surface-card p-6">
      <div className="h-4 w-36 bg-canvas-subtle" />
      <div className="mt-5 h-7 w-3/4 bg-canvas-subtle" />
      <div className="mt-8 space-y-3"><div className="h-4 w-full bg-canvas-subtle" /><div className="h-4 w-5/6 bg-canvas-subtle" /><div className="h-4 w-2/3 bg-canvas-subtle" /></div>
      <p className="sr-only">Loading curriculum preview…</p>
    </div>
  );
}

async function HeroCurriculumExample() {
  const { previewCurriculum } = await getLandingCurricula();
  return <HeroProductPreview curriculum={previewCurriculum} />;
}

async function LearningSections() {
  const { publishedCurricula, catalogFailed } = await getLandingCurricula();

  return (
    <>
      <section className="border-y border-border-subtle bg-surface-card px-6 py-14 sm:py-16">
        <div className="mx-auto max-w-6xl">
          <div className="mx-auto mb-9 max-w-3xl text-center">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-forest">Why a learning path helps</p>
            <h2 className="mt-2 font-display text-3xl font-bold tracking-tight text-brand-navy sm:text-4xl">Less sorting. More sense of direction.</h2>
            <p className="mt-3 text-base text-text-secondary">Turn scattered resources into a clearer place to begin and continue.</p>
          </div>
          <div className="grid items-stretch gap-5 md:grid-cols-2 md:gap-6">
            <div className="rounded-xl border border-border-default bg-canvas-subtle p-6 sm:p-8">
              <h3 className="font-display text-xl font-semibold text-brand-navy">Finding your own way</h3>
              <ul className="mt-5 space-y-4 text-sm leading-relaxed text-text-secondary sm:text-base">
                <li className="flex gap-3"><span aria-hidden="true" className="text-text-tertiary">•</span><span className="line-through decoration-text-tertiary/70">Jump between sites with no clear place to start.</span></li>
                <li className="flex gap-3"><span aria-hidden="true" className="text-text-tertiary">•</span><span className="line-through decoration-text-tertiary/70">Piece ideas together yourself—and risk learning them out of order.</span></li>
                <li className="flex gap-3"><span aria-hidden="true" className="text-text-tertiary">•</span><span className="line-through decoration-text-tertiary/70">Spend time collecting links and judging which ones are useful.</span></li>
              </ul>
            </div>
            <div className="min-w-0 rounded-xl border border-brand-aqua/60 bg-brand-aqua-tint p-6 sm:p-8">
              <h3 className="font-display text-xl font-semibold text-brand-navy">Learning with a curriculum</h3>
              <ul className="mt-5 space-y-4 text-sm leading-relaxed text-text-secondary sm:text-base">
                <li className="flex gap-3"><span aria-hidden="true" className="text-brand-forest">•</span><span>Explore <strong className="font-semibold text-brand-forest">structured topics</strong> for a clearer starting point.</span></li>
                <li className="flex gap-3"><span aria-hidden="true" className="text-brand-forest">•</span><span>See <strong className="font-semibold text-brand-forest">key ideas</strong> organized under each topic.</span></li>
                <li className="flex gap-3"><span aria-hidden="true" className="text-brand-forest">•</span><span>Find <strong className="font-semibold text-brand-forest">related resources</strong> connected to topics and ideas.</span></li>
              </ul>
            </div>
          </div>
          <div className="mt-7 flex flex-col gap-3 border-t border-border-subtle pt-5 text-sm sm:flex-row sm:items-start sm:justify-between">
            <p className="max-w-xl leading-relaxed text-text-secondary">Explore school subjects, university topics, practical skills, and personal interests. Available curricula vary by topic.</p>
            <p className="max-w-xl text-xs leading-relaxed text-text-tertiary">AI helps organize learning structures and connect educational resources; generated structures are labeled as AI-organized. Resource checks indicate specific eligibility conditions, not a guarantee of quality or fit.</p>
          </div>
        </div>
      </section>
      <FeaturedCurricula curricula={publishedCurricula} failed={catalogFailed} />
    </>
  );
}

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-canvas-default text-text-primary">
      <StudentHeader />
      <main>
        <section className="px-6 py-12 sm:py-16 lg:py-20">
          <div className="mx-auto grid max-w-6xl items-center gap-10 lg:grid-cols-12 lg:gap-12">
            <div className="lg:col-span-6">
              <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-brand-aqua/60 bg-brand-aqua-tint px-3 py-1 text-xs font-semibold text-brand-forest"><span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-brand-fresh" />Independent learning, with more structure</p>
              <h1 className="max-w-[13ch] font-display text-5xl font-bold leading-[0.98] tracking-[-0.045em] text-brand-navy sm:text-6xl lg:text-7xl">A clearer path to <span className="text-brand-forest">what you want to learn.</span></h1>
              <p className="mt-6 max-w-xl text-lg leading-relaxed text-text-secondary sm:text-xl">Spend less time sorting through scattered resources and deciding where to start. Build a curriculum that organizes a topic into a learning path.</p>
              <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
                <a href="#generate" className="inline-flex items-center justify-center gap-2 rounded-lg bg-brand-forest px-6 py-3.5 text-base font-semibold text-white shadow-sm transition hover:bg-brand-forest-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-forest focus-visible:ring-offset-2">Build my curriculum <span aria-hidden="true">→</span></a>
                <Link href="/curriculum" className="inline-flex items-center gap-1.5 text-sm font-semibold text-brand-forest hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-forest focus-visible:ring-offset-2">Browse existing curricula <span aria-hidden="true">→</span></Link>
              </div>
              <p className="mt-6 text-sm font-medium text-text-tertiary">Free to use. No subscriptions.</p>
            </div>
            <div className="min-w-0 lg:col-span-6">
              <Suspense fallback={<HeroPreviewLoading />}>
                <HeroCurriculumExample />
              </Suspense>
            </div>
          </div>
        </section>
        <section id="generate" className="scroll-mt-20 border-y border-border-subtle bg-canvas-subtle px-6 py-10 sm:py-12">
          <div className="mx-auto max-w-4xl">
            <h2 className="mb-5 font-display text-2xl font-bold tracking-tight text-brand-navy sm:text-3xl">Build a curriculum for your topic</h2>
              <div className="rounded-xl border border-border-default bg-surface-card p-5 shadow-sm sm:p-7">
                <div className="mb-5 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
                  <p className="text-xs text-text-tertiary">If a suitable published curriculum exists, you can use that instead.</p>
                </div>
                <GenerateForm />
              </div>
          </div>
        </section>
        <Suspense fallback={<LearningSectionsLoading />}>
          <LearningSections />
        </Suspense>
      </main>
      <StudentFooter />
    </div>
  );
}
