"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import logo from "../../public/logo-cropped.png";

export function StudentHeader() {
  const pathname = usePathname();

  return (
    <header className="border-b border-border-subtle bg-surface-card/95 backdrop-blur-sm sticky top-0 z-40 transition-colors">
      <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
        {/* Brand */}
        <Link
          href="/"
          className="flex shrink-0 items-center"
          aria-label="Curriculize home"
        >
          <Image
            src={logo}
            alt="Curriculize home"
            priority
            className="h-auto w-[96px] sm:w-[150px]"
            sizes="(max-width: 639px) 96px, 150px"
          />
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
