import Link from "next/link";

type PreviewCurriculum = {
  id: string;
  title: string;
  subject: string;
  topics: {
    title: string;
    understandings: string[];
    resources: { title: string; source_domain: string | null }[];
  }[];
};

export function HeroProductPreview({
  curriculum,
}: {
  curriculum: PreviewCurriculum | null;
}) {
  const firstTopic = curriculum?.topics[0];
  const resources = firstTopic?.resources.slice(0, 2) ?? [];

  return (
    <div className="relative mx-auto w-full max-w-lg lg:max-w-none">
      <div className="overflow-hidden rounded-2xl border border-border-default bg-surface-card shadow-lg shadow-brand-navy/5">
        <div className="flex items-center justify-between gap-3 border-b border-border-subtle bg-canvas-subtle/70 px-5 py-4">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-forest">
              {curriculum ? curriculum.subject || "Published curriculum" : "A clearer way to learn"}
            </p>
            <h2 className="mt-1 truncate font-display text-base font-semibold text-brand-navy">
              {curriculum?.title ?? "A subject, organized"}
            </h2>
          </div>
          <span aria-hidden="true" className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-aqua-tint text-brand-forest">
            <svg viewBox="0 0 24 24" fill="none" className="h-5 w-5" stroke="currentColor" strokeWidth="1.7">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5v-16ZM4 5.5V20m4-12h8m-8 4h5" />
            </svg>
          </span>
        </div>

        <div className="space-y-4 p-5 sm:p-6">
          {firstTopic ? (
            <>
              <div className="flex items-center gap-3">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-aqua-tint font-mono text-xs font-semibold text-brand-forest">01</span>
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-wider text-text-tertiary">Start with a topic</p>
                  <p className="truncate font-display text-sm font-semibold text-brand-navy">{firstTopic.title}</p>
                </div>
              </div>

              <div className="ml-4 space-y-3 border-l border-brand-aqua pl-7">
                {firstTopic.understandings.length > 0 ? firstTopic.understandings.map((understanding, index) => (
                  <div key={`${index}-${understanding}`} className="rounded-lg border border-border-subtle bg-canvas-default px-3.5 py-3">
                    <p className="text-xs font-semibold uppercase tracking-wider text-text-tertiary">Key idea {index + 1}</p>
                    <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-text-primary">{understanding}</p>
                  </div>
                )) : (
                  <p className="text-xs text-text-secondary">Explore the ideas that make up this topic.</p>
                )}

                {resources.length > 0 && (
                  <div className="space-y-2 pt-1">
                    <p className="text-xs font-semibold uppercase tracking-wider text-text-tertiary">Related resources</p>
                    {resources.map((resource, index) => (
                      <div key={`${index}-${resource.title}`} className="flex min-w-0 items-center gap-2 rounded-lg bg-brand-aqua-tint/50 px-3 py-2">
                        <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand-forest" />
                        <span className="truncate text-xs font-medium text-text-primary">{resource.title}</span>
                        {resource.source_domain && <span className="hidden shrink-0 text-xs text-text-tertiary sm:inline">{resource.source_domain}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <Link href={`/curriculum/${curriculum.id}`} className="inline-flex text-xs font-semibold text-brand-forest hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-forest focus-visible:ring-offset-2">
                Explore this curriculum <span aria-hidden="true" className="ml-1">→</span>
              </Link>
            </>
          ) : (
            <>
              <div className="flex items-center gap-3 rounded-lg border border-border-subtle bg-canvas-default p-3.5">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-aqua-tint font-mono text-xs font-semibold text-brand-forest">01</span>
                <div><p className="font-display text-sm font-semibold text-brand-navy">Choose a topic</p><p className="text-xs text-text-secondary">Start with what you want to understand.</p></div>
              </div>
              <div className="ml-4 h-5 border-l border-brand-aqua" />
              <div className="flex items-center gap-3 rounded-lg border border-border-subtle bg-canvas-default p-3.5">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-aqua-tint font-mono text-xs font-semibold text-brand-forest">02</span>
                <div><p className="font-display text-sm font-semibold text-brand-navy">See how ideas connect</p><p className="text-xs text-text-secondary">Move through topics and their key understandings.</p></div>
              </div>
              <div className="ml-4 h-5 border-l border-brand-aqua" />
              <div className="flex items-center gap-3 rounded-lg border border-border-subtle bg-canvas-default p-3.5">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand-aqua-tint font-mono text-xs font-semibold text-brand-forest">03</span>
                <div><p className="font-display text-sm font-semibold text-brand-navy">Explore related resources</p><p className="text-xs text-text-secondary">Find available learning material in context.</p></div>
              </div>
            </>
          )}
        </div>
        <div className="border-t border-border-subtle px-5 py-3 text-[11px] text-text-tertiary sm:px-6">
          {curriculum ? "A preview from a published curriculum" : "A simple view of the learning structure"}
        </div>
      </div>
    </div>
  );
}
