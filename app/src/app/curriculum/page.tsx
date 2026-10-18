import Link from "next/link";
import { getCurricula } from "@/lib/curriculum-data";
import { StudentHeader } from "@/components/StudentHeader";
import { StudentFooter } from "@/components/StudentFooter";

export const dynamic = "force-dynamic";

export default async function CurriculaIndexPage() {
  const all = await getCurricula();
  const published = all.filter((c) => c.status === "published");

  return (
    <div className="min-h-screen bg-canvas-default text-text-primary flex flex-col justify-between">
      <StudentHeader />

      <main className="flex-1 max-w-5xl w-full mx-auto px-6 py-12 sm:py-16">
        <header className="mb-10 sm:mb-12">
          <p className="text-xs font-display font-semibold uppercase tracking-[0.18em] text-brand-forest mb-2.5">
            Published learning paths
          </p>
          <h1 className="font-display text-3xl sm:text-4xl font-bold tracking-tight text-brand-navy mb-3">
            Browse Curricula
          </h1>
          <p className="text-base text-text-secondary leading-relaxed max-w-2xl">
            Browse published curricula organized by subject. Each path may include
            topics, key ideas, and available learning resources; coverage varies.
          </p>
        </header>

        {published.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border-default bg-surface-card p-12 text-center max-w-md mx-auto my-8">
            <p className="font-display font-medium text-text-primary mb-1">
              No curricula published yet
            </p>
            <p className="text-sm text-text-secondary mb-5">
              Build a curriculum for a topic you want to learn, or check back as the catalog grows.
            </p>
            <Link
              href="/"
              className="inline-flex items-center justify-center px-4 py-2 rounded-lg bg-brand-forest text-white text-sm font-medium hover:bg-brand-forest-hover transition shadow-sm"
            >
              Create a Curriculum →
            </Link>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {published.map((c) => (
              <article key={c.id}>
                <Link
                  href={`/curriculum/${c.id}`}
                  className="group flex flex-col justify-between h-full rounded-xl border border-border-default bg-surface-card p-6 transition-all duration-200 hover:border-brand-forest hover:shadow-md"
                >
                  <div>
                    <div className="flex items-center justify-between gap-2 mb-3">
                      {c.subject ? (
                        <span className="text-xs font-medium px-2.5 py-0.5 rounded-full bg-brand-aqua-tint text-brand-navy border border-brand-aqua/40">
                          {c.subject}
                        </span>
                      ) : (
                        <span />
                      )}
                      <span className="text-xs font-mono text-text-tertiary uppercase">
                        {c.source_type === "adapted" ? "Adapted structure" : "AI-organized structure"}
                      </span>
                    </div>

                    <h2 className="font-display text-xl font-semibold text-text-primary group-hover:text-brand-forest transition-colors leading-snug">
                      {c.title}
                    </h2>

                    {c.source_attribution && (
                      <p className="text-xs text-text-secondary mt-2.5 flex items-center gap-1">
                        <span>Source:</span>
                        <span className="font-medium text-text-primary">
                          {c.source_attribution}
                        </span>
                      </p>
                    )}
                  </div>

                  <div className="pt-5 mt-4 border-t border-border-subtle flex items-center justify-between text-sm">
                    <span className="text-xs text-text-tertiary">Published curriculum</span>
                    <span className="font-medium text-brand-forest flex items-center gap-1 group-hover:translate-x-0.5 transition-transform">
                      Explore guide <span aria-hidden="true">→</span>
                    </span>
                  </div>
                </Link>
              </article>
            ))}
          </div>
        )}
      </main>

      <StudentFooter />
    </div>
  );
}
