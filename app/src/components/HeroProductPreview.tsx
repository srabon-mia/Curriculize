export function HeroProductPreview() {
  return (
    <div className="relative w-full max-w-lg mx-auto lg:max-w-none">
      {/* Background ambient glow using soft brand tints */}
      <div
        aria-hidden="true"
        className="absolute -inset-1 rounded-3xl bg-gradient-to-tr from-brand-aqua/30 via-brand-forest/10 to-transparent blur-xl -z-10 opacity-70"
      />

      <div className="bg-surface-card rounded-2xl border border-border-default shadow-sm hover:shadow-md transition-shadow overflow-hidden">
        {/* Workspace Mock Header */}
        <div className="border-b border-border-subtle bg-canvas-subtle/70 px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-border-hover" />
            <span className="w-2.5 h-2.5 rounded-full bg-border-hover" />
            <span className="w-2.5 h-2.5 rounded-full bg-border-hover" />
            <span className="font-mono text-[11px] text-text-tertiary ml-2 hidden sm:inline">
              curriculum / chemistry-regents
            </span>
          </div>
          <span className="text-[11px] font-medium font-mono px-2 py-0.5 rounded bg-brand-aqua-tint text-brand-navy border border-brand-aqua/40">
            Official Syllabus
          </span>
        </div>

        {/* Workspace Content */}
        <div className="p-5 sm:p-6 space-y-4">
          {/* Level 1: Curriculum & Active Topic */}
          <div>
            <div className="flex items-center justify-between text-xs text-text-tertiary mb-1">
              <span className="font-mono uppercase tracking-wider text-[10px]">Topic 01 of 10</span>
              <span className="font-mono text-[10px] text-brand-forest font-semibold">Exam Weight: 10–12%</span>
            </div>
            <h3 className="font-display text-lg font-bold text-brand-navy">
              Atomic Concepts &amp; Structure
            </h3>
            <p className="text-xs text-text-secondary mt-0.5">
              Subatomic particles, electron configurations, and periodic properties.
            </p>
          </div>

          {/* Level 2: Major Understanding Card */}
          <div className="bg-canvas-subtle/50 rounded-xl border border-border-subtle p-3.5 space-y-3">
            <div className="flex items-start gap-2.5">
              <span className="shrink-0 font-mono text-[11px] font-bold text-brand-forest bg-white px-2 py-0.5 rounded border border-border-default shadow-2xs">
                MU 3.1a
              </span>
              <p className="text-xs text-text-primary leading-relaxed font-medium">
                The modern model of the atom has evolved over time through experimental evidence by Thomson, Rutherford, and Bohr.
              </p>
            </div>

            {/* Level 3: Curated Resources List */}
            <div className="pt-2 border-t border-border-subtle/80 space-y-2">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
                Curated Resources
              </div>

              {/* Resource 1: Video */}
              <div className="flex items-center justify-between gap-2 p-2 rounded-lg bg-surface-card border border-border-subtle text-xs hover:border-brand-forest/30 transition-colors">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="shrink-0 text-[10px] font-medium px-2 py-0.5 rounded-full bg-[#EBF5FB] text-[#1E5B94] border border-[#D4E6F1]">
                    Video
                  </span>
                  <span className="text-text-primary font-medium truncate text-xs">
                    History of Atomic Chemistry
                  </span>
                </div>
                <span className="shrink-0 font-mono text-[10px] text-text-tertiary">
                  youtube.com
                </span>
              </div>

              {/* Resource 2: Textbook Reading */}
              <div className="flex items-center justify-between gap-2 p-2 rounded-lg bg-surface-card border border-border-subtle text-xs hover:border-brand-forest/30 transition-colors">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="shrink-0 text-[10px] font-medium px-2 py-0.5 rounded-full bg-canvas-subtle text-text-secondary border border-border-default">
                    Reading
                  </span>
                  <span className="text-text-primary font-medium truncate text-xs">
                    OpenStax: The Structure of the Atom
                  </span>
                </div>
                <span className="shrink-0 font-mono text-[10px] text-text-tertiary">
                  openstax.org
                </span>
              </div>

              {/* Resource 3: Practice Problem Set */}
              <div className="flex items-center justify-between gap-2 p-2 rounded-lg bg-surface-card border border-border-subtle text-xs hover:border-brand-forest/30 transition-colors">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="shrink-0 text-[10px] font-medium px-2 py-0.5 rounded-full bg-[#EAF7ED] text-[#166534] border border-[#CEEBD3]">
                    Practice
                  </span>
                  <span className="text-text-primary font-medium truncate text-xs">
                    Atomic Models Problem Set &amp; Key
                  </span>
                </div>
                <span className="shrink-0 font-mono text-[10px] text-text-tertiary">
                  nysed.gov
                </span>
              </div>
            </div>
          </div>

          {/* Subsequent Topic Peek */}
          <div className="flex items-center justify-between px-3 py-2 rounded-lg border border-border-subtle bg-canvas-subtle/30 text-xs text-text-tertiary">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[10px]">Topic 02</span>
              <span className="font-medium text-text-secondary">Periodic Table &amp; Periodic Trends</span>
            </div>
            <span className="font-mono text-[10px]">4 concepts</span>
          </div>
        </div>
      </div>
    </div>
  );
}
