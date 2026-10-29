"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import logo from "../../public/logo-cropped.png";

const subscribeToNothing = () => () => {};
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

export function StudentHeader() {
  const pathname = usePathname();
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const hasMounted = useSyncExternalStore(
    subscribeToNothing,
    getClientSnapshot,
    getServerSnapshot
  );
  const menuRef = useRef<HTMLDivElement>(null);
  const portalRootRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuWasOpenRef = useRef(false);
  const previousPathnameRef = useRef(pathname);

  useEffect(() => {
    if (!isMenuOpen) {
      if (menuWasOpenRef.current) {
        const frame = requestAnimationFrame(() => {
          const trigger = menuButtonRef.current;
          if (trigger?.getClientRects().length) {
            trigger.focus();
          } else {
            document.querySelector<HTMLElement>('nav[aria-label="Main navigation"] a[href]')?.focus();
          }
          menuWasOpenRef.current = false;
        });
        return () => cancelAnimationFrame(frame);
      }
      return;
    }

    menuWasOpenRef.current = true;
    const menu = menuRef.current;
    if (!menu || !hasMounted) return;

    const getFocusableElements = () =>
      Array.from(
        menu.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((element) => element.getClientRects().length > 0);

    getFocusableElements()[0]?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setIsMenuOpen(false);
        return;
      }

      if (event.key !== "Tab") return;

      const focusableElements = getFocusableElements();
      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];

      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement?.focus();
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement?.focus();
      }
    }

    function handleFocusIn(event: FocusEvent) {
      if (event.target instanceof Node && !menu.contains(event.target)) {
        getFocusableElements()[0]?.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("focusin", handleFocusIn);
    const desktopQuery = window.matchMedia("(min-width: 48rem)");
    const closeOnDesktop = (event: MediaQueryListEvent) => {
      if (event.matches) setIsMenuOpen(false);
    };
    desktopQuery.addEventListener("change", closeOnDesktop);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("focusin", handleFocusIn);
      desktopQuery.removeEventListener("change", closeOnDesktop);
    };
  }, [hasMounted, isMenuOpen]);

  useEffect(() => {
    if (!isMenuOpen || !portalRootRef.current) return;

    const previousInertStates = new Map<HTMLElement, { hadAttribute: boolean; value: string | null }>();

    for (const sibling of Array.from(document.body.children)) {
      if (!(sibling instanceof HTMLElement) || sibling === portalRootRef.current) continue;

      previousInertStates.set(sibling, {
        hadAttribute: sibling.hasAttribute("inert"),
        value: sibling.getAttribute("inert"),
      });
      sibling.inert = true;
    }

    return () => {
      for (const [element, previousState] of previousInertStates) {
        if (previousState.hadAttribute) {
          element.setAttribute("inert", previousState.value ?? "");
        } else {
          element.removeAttribute("inert");
        }
      }
    };
  }, [hasMounted, isMenuOpen]);

  useEffect(() => {
    if (previousPathnameRef.current === pathname) return;
    previousPathnameRef.current = pathname;
    if (!menuWasOpenRef.current) return;

    const frame = requestAnimationFrame(() => setIsMenuOpen(false));
    return () => cancelAnimationFrame(frame);
  }, [pathname]);

  const closeMenu = () => setIsMenuOpen(false);
  const navLinks = [
    { href: "/", label: "Start learning", active: pathname === "/" },
    {
      href: "/curriculum",
      label: "Browse paths",
      active: pathname.startsWith("/curriculum"),
    },
    { href: "/about", label: "About Us", active: pathname === "/about" },
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
          ref={menuButtonRef}
          type="button"
          onClick={() => setIsMenuOpen((open) => !open)}
          aria-expanded={isMenuOpen}
          aria-controls={hasMounted ? "mobile-navigation" : undefined}
          aria-label={isMenuOpen ? "Close navigation menu" : "Open navigation menu"}
          className="md:hidden flex items-center justify-center p-2 rounded-md text-text-secondary hover:text-text-primary hover:bg-canvas-subtle transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-forest focus-visible:ring-offset-2"
        >
          {isMenuOpen ? (
            <svg aria-hidden="true" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          ) : (
            <svg aria-hidden="true" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12h18M3 6h18M3 18h18" />
            </svg>
          )}
        </button>

        {/* Desktop Navigation */}
        <nav aria-label="Main navigation" className="hidden md:flex items-center gap-1 sm:gap-4">
          {navLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              aria-current={link.active ? "page" : undefined}
              className={`text-xs sm:text-sm font-medium px-2 sm:px-3 py-1.5 rounded-md transition ${
                link.active
                  ? "text-brand-forest bg-brand-aqua-tint/60"
                  : "text-text-secondary hover:text-text-primary hover:bg-canvas-subtle"
              }`}
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>

      {hasMounted &&
        createPortal(
          <div
            ref={portalRootRef}
            className={isMenuOpen ? "fixed inset-0 z-50" : "hidden"}
            hidden={!isMenuOpen}
          >
            {isMenuOpen && (
              <div
                className="absolute inset-0 z-0 bg-brand-navy/30 backdrop-blur-sm md:hidden"
                onClick={closeMenu}
                aria-hidden="true"
              />
            )}
            <div
              ref={menuRef}
              id="mobile-navigation"
              role="dialog"
              aria-modal={isMenuOpen}
              aria-label="Main navigation"
              hidden={!isMenuOpen}
              inert={!isMenuOpen}
              className={`absolute inset-y-0 right-0 z-10 w-full max-w-sm overflow-y-auto border-l border-border-default bg-surface-card shadow-xl md:hidden ${isMenuOpen ? "animate-slide-in" : "hidden"}`}
              style={{
                animationDuration: "150ms",
                animationTimingFunction: "ease-out",
              }}
            >
              <div className="flex min-h-full flex-col p-6 pt-20">
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={closeMenu}
                    aria-label="Close navigation menu"
                    className="flex h-11 w-11 items-center justify-center rounded-md text-text-secondary hover:bg-canvas-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-forest focus-visible:ring-offset-2"
                  >
                    <svg aria-hidden="true" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                </div>
                <nav aria-label="Main navigation" className="flex-1 space-y-1">
                  {navLinks.map((link) => (
                    <Link
                      key={link.href}
                      href={link.href}
                      onClick={closeMenu}
                      aria-current={link.active ? "page" : undefined}
                      className={`flex items-center rounded-lg px-3 py-3 text-base font-medium transition ${
                        link.active
                          ? "text-brand-forest bg-brand-aqua-tint/60"
                          : "text-text-primary hover:bg-canvas-subtle"
                      }`}
                    >
                      {link.label}
                    </Link>
                  ))}
                </nav>
                <div className="border-t border-border-subtle pt-6">
                  <p className="text-xs text-text-tertiary">
                    Curriculize — Human-curated study guides
                  </p>
                </div>
              </div>
            </div>
          </div>,
          document.body
        )}
    </header>
  );
}
