import Link from "next/link";

type CurriculumHeaderProps = {
  title: string;
  subject: string;
  source_type?: string | null;
  source_attribution?: string | null;
  source_url?: string | null;
};

function usableSourceUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Shared header using the published viewer's established layout and styling. */
export function CurriculumHeader({ title, subject, source_type, source_attribution, source_url }: CurriculumHeaderProps) {
  const sourceUrl = usableSourceUrl(source_url);

  return (
    <header className="border-b border-border-default bg-surface-card/95 backdrop-blur-sm px-6 py-3.5 sticky top-0 z-30 transition-colors">
      <div className="max-w-7xl mx-auto flex items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <Link
              href="/curriculum"
              className="text-xs font-medium text-text-secondary hover:text-brand-forest transition flex items-center gap-1"
            >
              <span>←</span>
              <span>Browse Guides</span>
            </Link>
            <span className="text-text-tertiary text-xs">/</span>
            <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-brand-forest bg-brand-aqua-tint px-2 py-0.5 rounded-full border border-brand-aqua/40">
              {subject}
            </span>
          </div>
          <h1 className="font-display text-lg sm:text-xl font-bold text-brand-navy leading-tight truncate">
            {title}
          </h1>
        </div>

        {source_attribution && (
          <div className="text-xs text-text-secondary hidden sm:block max-w-xs text-right shrink-0">
            <span className="text-text-tertiary">Adapted from </span>
            {sourceUrl ? (
              <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="font-medium text-brand-forest hover:underline underline-offset-2">
                {source_attribution} ↗
              </a>
            ) : (
              <span className="font-medium text-text-primary">{source_attribution}</span>
            )}
          </div>
        )}
        {!source_attribution && source_type === "ai_organized" && (
          <div className="text-xs text-text-secondary hidden sm:block max-w-xs text-right shrink-0">
            AI-organized structure · no human source verified
          </div>
        )}
      </div>
    </header>
  );
}
