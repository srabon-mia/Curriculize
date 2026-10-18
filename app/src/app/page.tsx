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
      className="group flex h-full flex-col justify-between rounded-xl border border-border-default bg-surface-card p-5 transition hover:-translate-y-0.5 hover:border-brand-forest/50 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-forest focus-visible:ring-offset-2"
    >
      <div>
        <p className="text-xs font-medium text-brand-forest">{curriculum.subject || "Learning path"}</p>
        <h3 className="mt-2 font-display text-lg font-semibold leading-snug text-brand-navy group-hover:text-brand-forest">{curriculum.title}</h3>
        {curriculum.source_attribution && <p className="mt-2 text-xs leading-relaxed text-text-secondary">Source: {curriculum.source_attribution}</p>}
      </div>
      <span className="mt-5 text-sm font-semibold text-brand-forest">Explore curriculum <span aria-hidden="true">→</span></span>
    </Link>
  );
}

function FeaturedCurricula({ curricula, failed }: { curricula: Curriculum[]; failed: boolean }) {
  return (
    <section id="curricula" className="scroll-mt-20 border-y border-border-subtle bg-canvas-subtle/45 px-6 py-16 sm:py-20">
      <div className="mx-auto max-w-6xl">
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-forest">Start exploring</p>
            <h2 className="mt-2 font-display text-2xl font-bold tracking-tight text-brand-navy sm:text-3xl">Browse learning paths</h2>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-text-secondary">Explore published curricula with topics and learning resources arranged around a subject.</p>
          </div>
          <Link href="/curriculum" className="inline-flex w-fit items-center gap-2 rounded-md text-sm font-semibold text-brand-forest hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-forest focus-visible:ring-offset-2">Browse all curricula <span aria-hidden="true">→</span></Link>
        </div>
        {failed ? (
          <div role="status" className="rounded-xl border border-border-default bg-surface-card px-6 py-8 text-center">
            <p className="font-display font-semibold text-brand-navy">Curricula are temporarily unavailable</p>
            <p className="mt-1 text-sm text-text-secondary">Please try browsing again in a little while.</p>
            <Link href="/curriculum" className="mt-4 inline-flex text-sm font-semibold text-brand-forest hover:underline">Open the curriculum catalog →</Link>
          </div>
        ) : curricula.length > 0 ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{curricula.slice(0, 4).map((curriculum) => <CurriculumCard key={curriculum.id} curriculum={curriculum} />)}</div>
        ) : (
          <div className="rounded-xl border border-dashed border-border-default bg-surface-card px-6 py-8 text-center">
            <p className="font-display font-semibold text-brand-navy">No curricula are published yet</p>
            <p className="mt-1 text-sm text-text-secondary">You can still request a learning path or check back as the catalog grows.</p>
            <a href="#generate" className="mt-4 inline-flex text-sm font-semibold text-brand-forest hover:underline">Explore a topic →</a>
          </div>
        )}
      </div>
    </section>
  );
}

export default async function LandingPage() {
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

  return (
    <div className="min-h-screen bg-canvas-default text-text-primary">
      <StudentHeader />
      <main>
        <section className="px-6 py-14 sm:py-20 lg:py-24">
          <div className="mx-auto grid max-w-6xl items-center gap-12 lg:grid-cols-12 lg:gap-14">
            <div className="lg:col-span-6">
              <p className="mb-5 inline-flex items-center gap-2 rounded-full border border-brand-aqua/60 bg-brand-aqua-tint px-3 py-1 text-xs font-semibold text-brand-forest"><span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-brand-fresh" />Independent learning, with more structure</p>
              <h1 className="font-display text-4xl font-bold leading-[1.08] tracking-tight text-brand-navy sm:text-5xl lg:text-[3.5rem]">Spend less time organizing. <span className="text-brand-forest">More time learning.</span></h1>
              <p className="mt-6 max-w-xl text-base leading-relaxed text-text-secondary sm:text-lg">Learning something new shouldn’t mean sorting through the whole internet first. Find a structured place to begin, explore how ideas connect, and see learning resources in the context of a subject.</p>
              <div className="mt-8 flex flex-col gap-3 sm:flex-row">
                <Link href="/curriculum" className="inline-flex items-center justify-center gap-2 rounded-lg bg-brand-forest px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-forest-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-forest focus-visible:ring-offset-2">Browse curricula <span aria-hidden="true">→</span></Link>
                <a href="#generate" className="inline-flex items-center justify-center rounded-lg border border-border-default bg-surface-card px-5 py-3 text-sm font-semibold text-brand-navy transition hover:border-brand-forest/50 hover:bg-canvas-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-forest focus-visible:ring-offset-2">Request a learning path</a>
              </div>
              <p className="mt-5 text-xs font-medium text-text-tertiary">Free to use · No subscriptions or paid tiers</p>
            </div>
            <div className="lg:col-span-6"><HeroProductPreview curriculum={previewCurriculum} /></div>
          </div>
        </section>

        <FeaturedCurricula curricula={publishedCurricula} failed={catalogFailed} />

        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto grid max-w-6xl gap-10 md:grid-cols-12 md:items-center">
            <div className="md:col-span-5"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-forest">The effort before learning</p><h2 className="mt-3 font-display text-2xl font-bold leading-tight text-brand-navy sm:text-3xl">Finding information is only the beginning.</h2></div>
            <div className="md:col-span-7 md:border-l md:border-border-default md:pl-10"><p className="text-base leading-relaxed text-text-secondary">A search can surface articles, videos, and courses. Then you still have to judge where to start, what builds on what, and which resource fits each part of the subject. That organizing work can turn curiosity into a project of its own.</p><p className="mt-4 text-sm font-semibold text-brand-navy">The goal is to make that first step feel more manageable.</p></div>
          </div>
        </section>

        <section className="border-y border-border-subtle bg-white/60 px-6 py-16 sm:py-20">
          <div className="mx-auto grid max-w-6xl gap-10 md:grid-cols-2 md:items-center">
            <div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-forest">A path through a subject</p><h2 className="mt-3 font-display text-2xl font-bold leading-tight text-brand-navy sm:text-3xl">Understand how the pieces fit together.</h2><p className="mt-4 max-w-xl text-sm leading-relaxed text-text-secondary">A curriculum groups a subject into topics and key understandings, with available resources connected to the parts they can help explain. It gives you a map to explore, while leaving room to follow your questions.</p></div>
            <div className="flex items-center gap-3 sm:gap-5" aria-label="Learning resources organized around a subject"><div className="flex-1 border-y border-border-default py-4"><p className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">Subject</p><p className="mt-1 font-display font-semibold text-brand-navy">What you want to learn</p></div><span aria-hidden="true" className="text-brand-forest">→</span><div className="flex-1 border-y border-brand-aqua py-4"><p className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">Structure</p><p className="mt-1 font-display font-semibold text-brand-navy">Topics &amp; key ideas</p></div><span aria-hidden="true" className="text-brand-forest">→</span><div className="flex-1 border-y border-border-default py-4"><p className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">Explore</p><p className="mt-1 font-display font-semibold text-brand-navy">Related resources</p></div></div>
          </div>
        </section>

        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-6xl">
            <div className="max-w-2xl"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-forest">Curiosity has no syllabus</p><h2 className="mt-3 font-display text-2xl font-bold text-brand-navy sm:text-3xl">Explore what matters to you.</h2><p className="mt-3 text-sm leading-relaxed text-text-secondary">From a class you’re taking to a subject you just discovered, start with your interests. Available curricula and resources vary by topic and continue to grow.</p></div>
            <div className="mt-8 flex flex-wrap gap-2.5">{["School subjects", "University topics", "Practical skills", "History & culture", "Science & nature", "Arts & hobbies", "Something new"].map((item, index) => <span key={item} className={`rounded-full border px-3.5 py-2 text-sm ${index % 2 === 0 ? "border-brand-aqua/70 bg-brand-aqua-tint/60 text-brand-navy" : "border-border-default bg-surface-card text-text-secondary"}`}>{item}</span>)}</div>
          </div>
        </section>

        <section className="border-y border-border-subtle bg-brand-navy px-6 py-16 text-white sm:py-20">
          <div className="mx-auto grid max-w-6xl gap-8 md:grid-cols-12 md:items-start">
            <div className="md:col-span-5"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-aqua">Human knowledge, easier to navigate</p><h2 className="mt-3 font-display text-2xl font-bold leading-tight sm:text-3xl">AI can help organize learning. It isn’t the lesson.</h2></div>
            <div className="md:col-span-7"><p className="text-sm leading-relaxed text-white/80">The product’s guiding approach is to use AI to help discover, extract, and arrange learning structures and resources, while keeping educational material grounded in existing sources. When a suitable curriculum structure isn’t available, AI may help create an outline. That outline is not an official or human-authored curriculum.</p><p className="mt-4 text-sm leading-relaxed text-white/70">Checks can help determine whether a resource is accessible and meets specific requirements; they do not prove that it is accurate or the best fit. Publication approval and resource checks are separate steps, and the current process does not mean every resource has been personally reviewed by an educator.</p></div>
          </div>
        </section>

        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-6xl">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-forest">A practical starting point</p><h2 className="mt-3 font-display text-2xl font-bold text-brand-navy sm:text-3xl">How it works</h2>
            <ol className="mt-8 grid gap-x-8 gap-y-7 border-t border-border-default pt-6 sm:grid-cols-2 lg:grid-cols-4">{[
              ["01", "Choose a topic", "Browse a published curriculum or request a path for something you want to learn."],
              ["02", "Build a structure", "An existing curriculum may provide a starting point; otherwise, a generated outline can organize the subject."],
              ["03", "Connect resources", "Available educational materials are associated with relevant topics or key ideas."],
              ["04", "Explore at your pace", "Use the structure as a guide and follow the resources available for each part."],
            ].map(([number, title, body]) => <li key={number}><span className="font-mono text-xs font-semibold text-brand-forest">{number}</span><h3 className="mt-2 font-display font-semibold text-brand-navy">{title}</h3><p className="mt-2 text-sm leading-relaxed text-text-secondary">{body}</p></li>)}</ol>
          </div>
        </section>

        <section className="border-y border-border-subtle bg-canvas-subtle/45 px-6 py-16 sm:py-20">
          <div className="mx-auto grid max-w-6xl gap-8 md:grid-cols-12 md:items-center"><div className="md:col-span-5"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-forest">For self-directed learners</p><h2 className="mt-3 font-display text-2xl font-bold text-brand-navy sm:text-3xl">A little more direction for your next question.</h2></div><p className="text-sm leading-relaxed text-text-secondary md:col-span-7">Whether you’re reviewing a school subject, learning independently, building a practical skill, or exploring an interest, a clear structure can help you decide where to begin and what to look at next. Use it alongside teachers, courses, books, and other sources that work for you.</p></div>
        </section>

        <section className="px-6 py-16 sm:py-20">
          <div className="mx-auto flex max-w-6xl flex-col gap-5 border-b border-border-default pb-12 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-forest">Open to everyone</p><h2 className="mt-2 font-display text-2xl font-bold text-brand-navy sm:text-3xl">Free to learn. No subscriptions.</h2><p className="mt-3 max-w-2xl text-sm leading-relaxed text-text-secondary">The product is free to use, with no paid tiers or subscription barriers.</p></div><span aria-hidden="true" className="font-display text-5xl font-bold text-brand-aqua">$0</span></div>
        </section>

        <section id="generate" className="scroll-mt-20 bg-canvas-subtle/40 px-6 py-16 sm:py-20">
          <div className="mx-auto max-w-6xl">
            <div className="grid gap-10 lg:grid-cols-12 lg:items-start">
              <div className="lg:col-span-5"><p className="text-xs font-semibold uppercase tracking-[0.18em] text-brand-forest">Where will curiosity take you?</p><h2 className="mt-3 font-display text-2xl font-bold text-brand-navy sm:text-3xl">Find a path or start with a question.</h2><p className="mt-3 text-sm leading-relaxed text-text-secondary">Browse published curricula to see what’s available, or request a learning path for a topic you have in mind.</p><Link href="/curriculum" className="mt-5 inline-flex text-sm font-semibold text-brand-forest hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-forest">Browse published curricula →</Link><p className="mt-5 text-xs text-text-tertiary">Free to use, with no subscriptions or paid tiers.</p></div>
              <div className="rounded-2xl border border-border-default bg-surface-card p-5 shadow-sm sm:p-7 lg:col-span-7"><p className="mb-5 font-display text-lg font-semibold text-brand-navy">Request a learning path</p><GenerateForm /></div>
            </div>
          </div>
        </section>
      </main>
      <StudentFooter />
    </div>
  );
}
