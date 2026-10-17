"use client";

import Link from "next/link";
import { GenerateForm } from "../components/GenerateForm";
import { StudentHeader } from "../components/StudentHeader";
import { StudentFooter } from "../components/StudentFooter";

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-canvas-default text-text-primary flex flex-col justify-between">
      <StudentHeader />

      <main className="flex-1">
        {/* Hero Section */}
        <section className="max-w-4xl mx-auto px-6 pt-16 sm:pt-20 pb-16 text-center">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-brand-aqua-tint border border-brand-aqua/40 text-brand-navy text-xs font-medium uppercase tracking-[0.16em] mb-6">
            <span>Human-curated · AI-organized</span>
          </div>

          <h1 className="font-display text-4xl sm:text-5xl lg:text-6xl font-bold tracking-tight text-brand-navy leading-[1.12] mb-6 max-w-3xl mx-auto">
            Study guides built from real resources
          </h1>

          <p className="text-base sm:text-lg text-text-secondary leading-relaxed mb-10 max-w-2xl mx-auto">
            Type a subject and we&apos;ll build you a full curriculum from the best
            existing resources on the internet — no AI-generated content, just
            real explanations, videos, and practice problems.
          </p>

          {/* Centered Generator Form Card */}
          <div className="max-w-2xl mx-auto bg-surface-card rounded-2xl border border-border-default shadow-sm p-6 sm:p-8 text-left transition-all">
            <GenerateForm />
          </div>
        </section>

        {/* How it works Section */}
        <section className="border-t border-border-subtle bg-canvas-subtle/40 py-16 sm:py-20 px-6">
          <div className="max-w-5xl mx-auto">
            <div className="text-center sm:text-left mb-10">
              <p className="text-xs font-display font-semibold uppercase tracking-[0.18em] text-brand-forest mb-2">
                Process
              </p>
              <h2 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-brand-navy">
                How it works
              </h2>
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
                  className="bg-surface-card rounded-xl border border-border-default p-6 shadow-xs hover:border-brand-forest/50 transition-colors flex flex-col justify-between"
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