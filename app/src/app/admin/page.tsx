import Link from "next/link";
import { getCurricula } from "@/lib/curriculum-data";
import { LogoutButton } from "@/components/LogoutButton";
import { requireAdmin } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function AdminHome() {
  await requireAdmin();
  const curricula = await getCurricula();

  return (
    <main className="min-h-screen bg-canvas-default text-text-primary py-12 sm:py-16">
      <div className="mx-auto max-w-4xl px-6">
        <header className="mb-10 flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-display font-semibold uppercase tracking-[0.18em] text-brand-forest mb-2">
              Curriculum Builder · Admin
            </p>
            <h1 className="font-display text-2xl sm:text-3xl font-bold tracking-tight text-brand-navy">
              Your Curricula
            </h1>
          </div>
          <LogoutButton />
        </header>

        {curricula.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border-default bg-surface-card px-6 py-12 text-center">
            <p className="text-text-secondary text-sm">
              Nothing here yet. Run{" "}
              <code className="px-2 py-0.5 bg-canvas-subtle border border-border-default rounded text-xs font-mono text-text-primary">
                npm run seed
              </code>{" "}
              to load the Chemistry curriculum from Phase 0.
            </p>
          </div>
        ) : (
          <ul className="space-y-3.5">
            {curricula.map((c) => (
              <li key={c.id}>
                <Link
                  href={`/admin/curriculum/${c.id}`}
                  className="group flex items-center justify-between rounded-xl border border-border-default bg-surface-card px-6 py-5 transition-all hover:border-brand-forest hover:shadow-xs"
                >
                  <div className="min-w-0 pr-4">
                    <p className="font-display text-lg font-semibold text-text-primary group-hover:text-brand-forest transition-colors">
                      {c.title}
                    </p>
                    <div className="flex items-center gap-2 text-xs text-text-tertiary mt-1.5 flex-wrap">
                      <span className="font-medium text-text-secondary">
                        {c.subject}
                      </span>
                      <span>·</span>
                      <span
                        className={`px-2 py-0.5 rounded-full text-[11px] font-medium capitalize border ${
                          c.status === "published"
                            ? "bg-status-success-bg text-status-success border-status-success/20"
                            : c.status === "archived"
                            ? "bg-canvas-subtle text-text-tertiary border-border-default"
                            : "bg-status-warning-bg text-status-warning border-status-warning/20"
                        }`}
                      >
                        {c.status}
                      </span>
                      {c.source_attribution && (
                        <>
                          <span>·</span>
                          <span className="truncate">
                            Adapted from {c.source_attribution}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  <span className="text-brand-forest font-medium text-sm shrink-0 flex items-center gap-1 group-hover:translate-x-0.5 transition-transform">
                    Open <span aria-hidden="true">→</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </main>
  );
}

