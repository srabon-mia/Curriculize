"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function StudentHeader() {
  const pathname = usePathname();

  return (
    <header className="border-b border-border-subtle bg-surface-card/95 backdrop-blur-sm sticky top-0 z-40 transition-colors">
      <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between">
        {/* Brand */}
        <Link
          href="/"
          className="flex items-center gap-2.5 text-text-primary hover:text-brand-forest transition group"
        >
          <span className="w-8 h-8 rounded-lg bg-brand-forest flex items-center justify-center text-white font-display font-bold text-sm shadow-sm group-hover:bg-brand-forest-hover transition">
            C
          </span>
          <span className="font-display font-semibold text-base sm:text-lg tracking-tight text-brand-navy">
            Curriculum Generator
          </span>
        </Link>

        {/* Navigation Links */}
        <nav className="flex items-center gap-2 sm:gap-4">
          <Link
            href="/"
            className={`text-sm font-medium px-3 py-1.5 rounded-md transition ${
              pathname === "/"
                ? "text-brand-forest bg-brand-aqua-tint/60"
                : "text-text-secondary hover:text-text-primary hover:bg-canvas-subtle"
            }`}
          >
            Generator
          </Link>
          <Link
            href="/curriculum"
            className={`text-sm font-medium px-3 py-1.5 rounded-md transition ${
              pathname.startsWith("/curriculum")
                ? "text-brand-forest bg-brand-aqua-tint/60"
                : "text-text-secondary hover:text-text-primary hover:bg-canvas-subtle"
            }`}
          >
            Browse
          </Link>
          <Link
            href="/admin"
            className="text-xs sm:text-sm font-medium px-3 py-1.5 rounded-md border border-border-default text-text-secondary hover:text-text-primary hover:border-border-hover transition ml-1"
          >
            Admin
          </Link>
        </nav>
      </div>
    </header>
  );
}
