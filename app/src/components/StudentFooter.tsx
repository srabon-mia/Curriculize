import Link from "next/link";

export function StudentFooter() {
  return (
    <footer className="border-t border-border-subtle bg-surface-card text-text-secondary py-10 px-6 transition-colors">
      <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-xs">
        <div className="flex flex-col sm:flex-row items-center gap-2 text-center sm:text-left">
          <span className="font-display font-semibold text-text-primary">
            Curriculum Generator
          </span>
          <span className="hidden sm:inline text-text-tertiary">·</span>
          <span className="text-text-tertiary">
            Human-curated, structured study guides from trusted educational resources
          </span>
        </div>
        <div className="flex items-center gap-5 font-medium">
          <Link
            href="/"
            className="hover:text-brand-forest transition"
          >
            Generator
          </Link>
          <Link
            href="/curriculum"
            className="hover:text-brand-forest transition"
          >
            Browse Guides
          </Link>
          <Link
            href="/admin"
            className="hover:text-text-primary text-text-tertiary transition"
          >
            Admin
          </Link>
        </div>
      </div>
    </footer>
  );
}
