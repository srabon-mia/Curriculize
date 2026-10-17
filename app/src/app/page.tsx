"use client";

import Link from "next/link";
import { GenerateForm } from "../components/GenerateForm";
import { StudentHeader } from "../components/StudentHeader";
import { StudentFooter } from "../components/StudentFooter";
import { HeroProductPreview } from "../components/HeroProductPreview";

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-canvas-default text-text-primary flex flex-col justify-between">
      <StudentHeader />

      <main className="flex-1">
        {/* Split-Layout Hero Section */}
        <section className="relative overflow-hidden pt-12 sm:pt-16 lg:pt-20 pb-16 sm:pb-24 px-6 max-w-6xl mx-auto">
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 lg:gap-14 items-center">
            {/* Left Column: Messaging & CTAs */}
            <div className="lg:col-span-7 text-left">
              {/* Eyebrow badge */}
              <div className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-brand-aqua-tint border border-brand-aqua/40 text-brand-navy text-xs font-medium uppercase tracking-[0.16em] mb-6">
                <span className="w-1.5 h-1.5 rounded-full bg-brand-forest" />
                <span>Human-curated · AI-organized</span>
              </div>

              {/* Display Headline with selective color emphasis */}
              <h1 className="font-display text-4xl sm:text-5xl lg:text-[3.25rem] xl:text-[3.5rem] font-bold tracking-tight text-brand-navy leading-[1.08] mb-6">
                Turn curiosity into{" "}
                <span className="text-brand-forest">structured understanding</span>.
              </h1>

              {/* Concise supporting copy */}
              <p className="text-base sm:text-lg text-text-secondary leading-relaxed mb-8 max-w-xl">
                Explore structured learning guides compiled from official syllabi and the
                web&apos;s best educational resources. Real course frameworks, open
                textbooks, and practice problems — organized into coherent learning paths.
              </p>

              {/* Dual Calls to Action */}
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3.5 mb-8">
                <a
                  href="#generate"
                  className="inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl bg-brand-forest text-white text-sm sm:text-base font-semibold hover:bg-brand-forest-hover active:scale-[0.99] transition-all shadow-sm hover:shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-forest focus-visible:ring-offset-2"
                >
                  <span>Start a Learning Path</span>
                  <svg
                    className="w-4 h-4"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2.25}
                    aria-hidden="true"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
                  </svg>
                </a>
                <Link
                  href="/curriculum"
                  className="inline-flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl bg-surface-card hover:bg-canvas-subtle text-brand-navy border border-border-default hover:border-brand-forest/40 text-sm sm:text-base font-semibold transition-all shadow-2xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-forest focus-visible:ring-offset-2"
                >
                  <span>Browse Existing Guides</span>
                  <span aria-hidden="true">→</span>
                </Link>
              </div>

              {/* Trust & Orientation Indicators */}
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-text-tertiary pt-4 border-t border-border-subtle">
                <span className="flex items-center gap-1.5 font-medium">
                  <span className="text-brand-forest font-bold">✓</span> Official syllabus frameworks
                </span>
                <span className="flex items-center gap-1.5 font-medium">
                  <span className="text-brand-forest font-bold">✓</span> Free educational resources
                </span>
                <span className="flex items-center gap-1.5 font-medium">
                  <span className="text-brand-forest font-bold">✓</span> Topic &amp; concept hierarchy
                </span>
              </div>
            </div>

            {/* Right Column: Visual Product Preview */}
            <div className="lg:col-span-5 w-full">
              <HeroProductPreview />
            </div>
          </div>
        </section>

        {/* Dedicated Generator Section */}
        <section
          id="generate"
          className="scroll-mt-20 border-t border-border-subtle bg-canvas-subtle/30 py-16 sm:py-20 px-6"
        >
          <div className="max-w-4xl mx-auto">
            <div className="text-center max-w-2xl mx-auto mb-8 sm:mb-10">
              <p className="text-xs font-display font-semibold uppercase tracking-[0.18em] text-brand-forest mb-2">
                Study Guide Generator
              </p>
              <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-brand-navy mb-3">
                Create your custom learning path
              </h2>
              <p className="text-sm sm:text-base text-text-secondary leading-relaxed">
                Specify what you want to learn, your background, and your time commitment.
                We&apos;ll organize an academic structure and gather verified free resources for each concept.
              </p>
            </div>

            {/* Centered Generator Form Card */}
            <div className="max-w-2xl mx-auto bg-surface-card rounded-2xl border border-border-default shadow-sm p-6 sm:p-8 text-left transition-all">
              <GenerateForm />
            </div>
          </div>
        </section>

        {/* How it works Section (Preserved Supporting Content) */}
        <section className="border-t border-border-subtle bg-canvas-default py-16 sm:py-20 px-6">
          <div className="max-w-5xl mx-auto">
            <div className="text-center sm:text-left mb-10">
              <p className="text-xs font-display font-semibold uppercase tracking-[0.18em] text-brand-forest mb-2">
                Process
              </p>
              <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-brand-navy mb-2">
                How it works
              </h2>
              <p className="text-sm text-text-secondary max-w-xl">
                Combining official syllabus structures with human-reviewed web resources.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {[
                {
                  step: "01",
                  title: "Real curriculum",
                  body: "Topics are structured around official curricula from NYSED and other reputable sources — not AI-generated outlines.",
                },
                {
                  step: "02",
                  title: "Curated resources",
                  body: "Every link is sourced from trusted educational sites, reviewed by a human before it goes live.",
                },
                {
                  step: "03",
                  title: "Practice included",
                  body: "Each concept comes with learning resources and separate practice problems so you can actually test yourself.",
                },
              ].map((item) => (
                <div
                  key={item.step}
                  className="bg-surface-card rounded-xl border border-border-default p-6 shadow-2xs hover:border-brand-forest/50 transition-colors flex flex-col justify-between"
                >
                  <div>
                    <span className="font-mono text-xs font-semibold text-brand-forest bg-brand-aqua-tint px-2.5 py-1 rounded-md inline-block mb-3.5">
                      {item.step}
                    </span>
                    <h3 className="font-display text-lg font-semibold text-brand-navy mb-2">
                      {item.title}
                    </h3>
                    <p className="text-sm text-text-secondary leading-relaxed">
                      {item.body}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-10 text-center">
              <Link
                href="/curriculum"
                className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-forest hover:text-brand-forest-hover hover:underline transition"
              >
                Browse already published curricula →
              </Link>
            </div>
          </div>
        </section>
      </main>

      <StudentFooter />
    </div>
  );
}