import type { Metadata } from "next";
import Link from "next/link";
import { StudentHeader } from "../../components/StudentHeader";
import { StudentFooter } from "../../components/StudentFooter";

export const metadata: Metadata = {
  title: "About | Curriculum Generator",
  description:
    "A free platform for building structured learning paths around the topics you want to explore.",
};

const steps = [
  ["01", "Pick a topic", "A class, hobby, new skill, or something you’re curious about."],
  ["02", "Look for a path", "Browse published curricula first; a new one is optional."],
  ["03", "Build one if needed", "If nothing suitable exists, request a curriculum for your topic."],
  ["04", "Explore and learn", "Move through topics and follow the resources connected to them."],
];

export default function AboutPage() {
  return (
    <div className="min-h-screen bg-canvas-default text-text-primary">
      <StudentHeader />
      <main>
        <section className="relative overflow-hidden border-b border-border-subtle bg-gradient-to-br from-brand-aqua-tint via-canvas-default to-canvas-subtle px-6 pb-12 pt-12 sm:pb-16 sm:pt-16">
          <div aria-hidden="true" className="absolute -right-24 -top-28 h-72 w-72 rounded-full bg-brand-aqua/20 blur-3xl" />
          <div className="relative mx-auto max-w-3xl text-center">
            <span className="inline-flex items-center gap-2 rounded-full border border-brand-aqua/70 bg-surface-card/80 px-3 py-1 text-xs font-semibold text-brand-forest">
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-brand-fresh" />
              A little about us
            </span>
            <h1 className="mt-4 font-display text-4xl font-bold tracking-tight text-brand-navy sm:text-5xl">About <span className="text-brand-forest">Curriculum Generator</span></h1>
            <p className="mx-auto mt-4 max-w-2xl text-base leading-relaxed text-text-secondary sm:text-lg">A free place to make one for the subject you want to explore or skill you want to develop.</p>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              <span className="rounded-full border border-border-default bg-surface-card/80 px-3 py-1.5 text-xs font-medium text-text-secondary">Free to use</span>
              <span className="rounded-full border border-border-default bg-surface-card/80 px-3 py-1.5 text-xs font-medium text-text-secondary">For students and curious minds</span>
            </div>
          </div>
        </section>

        <section className="bg-surface-card px-6 py-10 sm:py-14">
          <div className="mx-auto grid max-w-5xl items-center gap-6 md:grid-cols-12 md:gap-8">
            <div className="md:col-span-5">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-forest">The idea</p>
              <h2 className="mt-2 font-display text-2xl font-bold tracking-tight text-brand-navy sm:text-3xl">What is Curriculum Generator?</h2>
              <p className="mt-4 text-sm leading-relaxed text-text-secondary sm:text-base">Learning on your own often means searching for good material, deciding what to study first, and organizing it all yourself. This site helps bring a topic, a sequence of ideas, and related educational resources into one place, so you don't have to jump around from website to website with no proper order.</p>
            </div>
            <div className="md:col-span-7">
              <div className="rounded-2xl border border-border-default bg-surface-card p-5 shadow-sm sm:p-6">
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-text-tertiary">A simple way to picture it</p>
                <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto_1fr_auto_1fr] sm:items-center">
                  <div className="rounded-xl bg-brand-aqua-tint p-4"><span aria-hidden="true" className="text-lg text-brand-forest">⌕</span><p className="mt-2 text-sm font-semibold text-brand-navy">Your topic</p><p className="mt-1 text-xs text-text-secondary">What you want to learn</p></div>
                  <span aria-hidden="true" className="text-center text-brand-forest sm:hidden">↓</span>
                  <span aria-hidden="true" className="hidden text-lg text-brand-forest sm:block">→</span>
                  <div className="rounded-xl bg-canvas-subtle p-4"><span aria-hidden="true" className="text-lg text-brand-forest">≋</span><p className="mt-2 text-sm font-semibold text-brand-navy">A learning path</p><p className="mt-1 text-xs text-text-secondary">Topics in a useful order</p></div>
                  <span aria-hidden="true" className="text-center text-brand-forest sm:hidden">↓</span>
                  <span aria-hidden="true" className="hidden text-lg text-brand-forest sm:block">→</span>
                  <div className="rounded-xl bg-status-success-bg/70 p-4"><span aria-hidden="true" className="text-lg text-brand-forest">↗</span><p className="mt-2 text-sm font-semibold text-brand-navy">Resources</p><p className="mt-1 text-xs text-text-secondary">Existing material to explore</p></div>
                </div>
                <p className="mt-3 text-center text-[11px] text-text-tertiary">An illustration, not a specific curriculum</p>
              </div>
            </div>
          </div>
        </section>

        <section className="border-y border-border-subtle bg-canvas-subtle/60 px-6 py-10 sm:py-14">
          <div className="mx-auto max-w-5xl">
            <div className="mb-7 text-center">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-forest">From question to next step</p>
              <h2 className="mt-2 font-display text-2xl font-bold tracking-tight text-brand-navy sm:text-3xl">How it works</h2>
            </div>
            <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 lg:gap-6">
              {steps.map(([number, title, description], index) => (
                <li key={number} className="relative rounded-xl border border-border-default bg-surface-card p-4 shadow-sm sm:p-5">
                  {index < steps.length - 1 && <span aria-hidden="true" className="absolute -right-3 top-8 z-10 hidden text-brand-forest lg:block">→</span>}
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-aqua-tint font-mono text-xs font-bold text-brand-forest">{number}</span>
                  <h3 className="mt-4 font-display text-base font-semibold text-brand-navy">{title}</h3>
                  <p className="mt-2 text-xs leading-relaxed text-text-secondary sm:text-sm">{description}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="bg-canvas-default px-6 py-10 sm:py-14">
          <div className="mx-auto grid max-w-5xl gap-4 md:grid-cols-2">
            <article className="rounded-2xl border border-border-default bg-surface-card p-6 shadow-sm sm:p-7">
              <span aria-hidden="true" className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand-aqua-tint text-lg text-brand-forest">◎</span>
              <p className="mt-4 text-xs font-semibold uppercase tracking-[0.16em] text-brand-forest">Who it’s for</p>
              <h2 className="mt-2 font-display text-xl font-bold text-brand-navy">For whatever you’re ready to learn.</h2>
              <p className="mt-3 text-sm leading-relaxed text-text-secondary">Students preparing for classes or exams, beginners exploring a new subject, people who want to pursue a new hobby, and independent learners following a personal interest can all use a structured starting point.</p>
            </article>
            <article className="rounded-2xl border border-brand-aqua/70 bg-brand-aqua-tint p-6 shadow-sm sm:p-7">
              <span aria-hidden="true" className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface-card text-lg text-brand-forest">↗</span>
              <p className="mt-4 text-xs font-semibold uppercase tracking-[0.16em] text-brand-forest">Our goal</p>
              <h2 className="mt-2 font-display text-xl font-bold text-brand-navy">Less time getting organized. More room to learn.</h2>
              <p className="mt-3 text-sm leading-relaxed text-text-secondary">Finding resources, choosing where to start, and arranging a learning journey can make a new subject feel like a lot. We want to make those first steps simpler.</p>
            </article>
          </div>
        </section>

        <section className="bg-canvas-subtle/50 px-6 pb-10 sm:pb-14">
          <div className="mx-auto max-w-5xl rounded-2xl border border-border-default bg-surface-card px-5 py-5 shadow-sm sm:px-7">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-forest">A note on how paths are made</p>
            <p className="mt-2 text-sm leading-relaxed text-text-secondary">Some curricula use adapted structures; others may be AI-organized. Educational resources come from existing sources. Availability and fit vary, and resource checks do not mean an educator has reviewed or endorsed every item.</p>
          </div>
        </section>

        <section className="border-t border-brand-forest/20 bg-brand-forest px-6 py-9 text-white sm:py-11">
          <div className="mx-auto flex max-w-5xl flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
            <div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-aqua">Ready to get started?</p><h2 className="mt-1 font-display text-2xl font-bold">Choose a path that fits.</h2></div>
            <div className="flex flex-wrap gap-3">
              <Link href="/#generate" className="inline-flex items-center justify-center gap-2 rounded-lg bg-brand-aqua px-4 py-2.5 text-sm font-semibold text-brand-navy transition hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-brand-forest">Build a Curriculum <span aria-hidden="true">→</span></Link>
              <Link href="/curriculum" className="inline-flex items-center justify-center gap-2 rounded-lg border border-white/30 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-brand-forest">Browse Existing Curricula <span aria-hidden="true">→</span></Link>
            </div>
          </div>
        </section>
      </main>
      <StudentFooter />
    </div>
  );
}
