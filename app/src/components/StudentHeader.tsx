"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import logo from "../../public/logo-cropped.png";

export function StudentHeader() {
  const pathname = usePathname();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Track mounted state to avoid hydration mismatch
  useEffect(() => {
    // Defer to avoid synchronous setState in effect
    requestAnimationFrame(() => {
      setMounted(true);
    });
  }, []);

  // Close menu on route change
  useEffect(() => {
    if (isMenuOpen) {
      // Defer to avoid synchronous setState in effect
      requestAnimationFrame(() => {
        setIsMenuOpen(false);
      });
    }
  }, [pathname]);

  // Handle escape key to close menu
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && isMenuOpen) {
        setIsMenuOpen(false);
        buttonRef.current?.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isMenuOpen]);

  // Trap focus within menu when open
  useEffect(() => {
    if (!isMenuOpen || !menuRef.current) return;

    const focusableElements = menuRef.current.querySelectorAll<HTMLElement>(
      'a[href], button, [tabindex]:not([tabindex="-1"])'
    );
    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    firstElement?.focus();

    function handleTab(e: KeyboardEvent) {
      if (e.key !== "Tab") return;

      if (e.shiftKey) {
        if (document.activeElement === firstElement) {
          e.preventDefault();
          lastElement?.focus();
        }
      } else {
        if (document.activeElement === lastElement) {
          e.preventDefault();
          firstElement?.focus();
        }
      }
    }

    menuRef.current.addEventListener("keydown", handleTab);
    return () => menuRef.current?.removeEventListener("keydown", handleTab);
  }, [isMenuOpen]);

  const toggleMenu = () => {
    setIsMenuOpen((prev) => !prev);
  };

  const closeMenu = () => {
    setIsMenuOpen(false);
  };

  const navLinks = [
    { href: "/", label: "Start learning", shortLabel: "Start", active: pathname === "/" },
    { href: "/curriculum", label: "Browse paths", shortLabel: "Browse", active: pathname.startsWith("/curriculum") },
    { href: "/about", label: "About Us", shortLabel: "About", active: pathname === "/about" },
  ];

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

        {/* Mobile Menu Button */}
        <button
          ref={buttonRef}
          type="button"
          onClick={toggleMenu}
          aria-expanded={isMenuOpen}
          aria-controls="mobile-navigation"
          aria-label={isMenuOpen ? "Close navigation menu" : "Open navigation menu"}
          className="md:hidden flex items-center justify-center p-2 rounded-md text-text-secondary hover:text-text-primary hover:bg-canvas-subtle transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-forest focus-visible:ring-offset-2"
        >
          {isMenuOpen ? (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              width="24"
              height="24"
              aria-hidden="true"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          ) : (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              width="24"
              height="24"
              aria-hidden="true"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 12h18M3 6h18M3 18h18" />
            </svg>
          )}
        </button>

        {/* Desktop Navigation */}
        <nav aria-label="Main navigation" className="hidden md:flex items-center gap-4">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={link.active ? "page" : undefined}
              className={`text-sm font-medium px-3 py-1.5 rounded-md transition ${
                link.active
                  ? "text-brand-forest bg-brand-aqua-tint/60"
                  : "text-text-secondary hover:text-text-primary hover:bg-canvas-subtle"
              }`}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        {/* Mobile Navigation Drawer */}
        {mounted && isMenuOpen && (
          <>
            {/* Backdrop */}
            <div
              className="fixed inset-0 bg-brand-navy/30 backdrop-blur-sm z-30 md:hidden"
              onClick={closeMenu}
              aria-hidden="true"
            />
            {/* Menu Panel */}
            <div
              ref={menuRef}
              id="mobile-navigation"
              role="navigation"
              aria-label="Main navigation"
              className="fixed inset-y-0 right-0 z-40 w-full max-w-sm bg-surface-card border-l border-border-default shadow-xl md:hidden animate-slide-in"
              style={{
                animationDuration: "150ms",
                animationTimingFunction: "ease-out",
              }}
            >
              <div className="flex flex-col h-full p-6 pt-20">
                <nav className="flex-1 space-y-1">
                  {navLinks.map((link) => (
                    <Link
                      key={link.href}
                      href={link.href}
                      onClick={closeMenu}
                      aria-current={link.active ? "page" : undefined}
                      className={`flex items-center px-3 py-3 rounded-lg text-base font-medium transition ${
                        link.active
                          ? "text-brand-forest bg-brand-aqua-tint/60"
                          : "text-text-primary hover:bg-canvas-subtle"
                      }`}
                    >
                      {link.label}
                    </Link>
                  ))}
                </nav>
                <div className="pt-6 border-t border-border-subtle">
                  <p className="text-xs text-text-tertiary">
                    Curriculize — Human-curated study guides
                  </p>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </header>
  );
}
