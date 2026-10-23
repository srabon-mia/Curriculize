"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function StudentHeader() {
  const pathname = usePathname();

  return (
    <header className="border-b border-border-subtle bg-surface-card/95 backdrop-blur-sm sticky top-0 z-40 transition-colors">
      <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
        {/* Brand */}
        <Link
          href="/"
          className="flex items-center gap-2.5 text-text-primary hover:text-brand-forest transition group"
        >
          <span className="w-8 h-8 rounded-lg bg-brand-forest flex items-center justify-center text-white font-display font-bold text-sm shadow-sm group-hover:bg-brand-forest-hover transition">
            C
          </span>
          <span className="hidden font-display font-semibold text-base tracking-tight text-brand-navy sm:inline sm:text-lg">
            Curriculize
          </span>
        </Link>

        {/* Navigation Links */}
        <nav aria-label="Main navigation" className="flex items-center gap-1 sm:gap-4">
          <Link
            href="/"
            className={`text-xs sm:text-sm font-medium px-2 sm:px-3 py-1.5 rounded-md transition ${
              pathname === "/"
                ? "text-brand-forest bg-brand-aqua-tint/60"
                : "text-text-secondary hover:text-text-primary hover:bg-canvas-subtle"
            }`}
          >
            <span className="sm:hidden">Start</span><span className="hidden sm:inline">Start learning</span>
          </Link>
          <Link
            href="/curriculum"
            className={`text-xs sm:text-sm font-medium px-2 sm:px-3 py-1.5 rounded-md transition ${
              pathname.startsWith("/curriculum")
                ? "text-brand-forest bg-brand-aqua-tint/60"
                : "text-text-secondary hover:text-text-primary hover:bg-canvas-subtle"
            }`}
          >
            <span className="sm:hidden">Browse</span><span className="hidden sm:inline">Browse paths</span>
          </Link>
          <Link
            href="/about"
            aria-current={pathname === "/about" ? "page" : undefined}
            className={`text-xs sm:text-sm font-medium px-2 sm:px-3 py-1.5 rounded-md transition ${
              pathname === "/about"
                ? "text-brand-forest bg-brand-aqua-tint/60"
                : "text-text-secondary hover:text-text-primary hover:bg-canvas-subtle"
            }`}
          >
            About Us
          </Link>
        </nav>
      </div>
    </header>
  );
}
