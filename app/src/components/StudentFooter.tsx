import Link from "next/link";
import Image from "next/image";
import logo from "../../public/logo-cropped.png";

export function StudentFooter() {
  return (
    <footer className="border-t border-white/10 bg-brand-navy text-white">
      <div className="max-w-6xl mx-auto px-6 py-14 sm:py-16">
        {/* Brand and navigation */}
        <div className="grid grid-cols-1 gap-10 md:gap-12 sm:grid-cols-2">
          {/* Left Column: Brand */}
          <div className="flex flex-col gap-5">
            <Link
              href="/"
              className="flex w-fit items-center"
              aria-label="Curriculize home"
            >
              <Image
                src={logo}
                alt="Curriculize home"
                className="h-auto w-[168px] sm:w-[180px]"
                sizes="(max-width: 639px) 168px, 180px"
              />
            </Link>
            <p className="text-sm leading-relaxed text-white/75 max-w-xs">
              Structured study guides compiled with AI from verified, human-curated educational resources.
            </p>
            {/* GitHub icon below description */}
            <a
              href="https://github.com/srabon-mia/Curriculum-Generator"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center w-8 h-8 rounded-full border border-white/25 text-white/80 transition-colors hover:border-brand-aqua/60 hover:bg-white/10 hover:text-brand-aqua focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-aqua"
              aria-label="View on GitHub"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                width="18"
                height="18"
                aria-hidden="true"
                fill="currentColor"
              >
                <path d="M12 .5C5.65.5.5 5.65.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.34-1.3-1.7-1.3-1.7-1.06-.72.08-.71.08-.71 1.17.08 1.78 1.2 1.78 1.2 1.04 1.78 2.73 1.26 3.4.96.11-.74.41-1.26.74-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.39-5.25 5.68.42.36.79 1.08.79 2.18v3.23c0 .31.21.68.8.56A11.51 11.51 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5z" />
              </svg>
            </a>
          </div>

          {/* Right Column: Quick Links */}
          <div className="flex flex-col gap-4">
            <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-white/60">
              Quick Links
            </h2>
            <div className="space-y-2.5">
              <Link
                href="/about"
                className="flex items-center gap-2 text-sm font-medium text-white/75 transition hover:text-brand-aqua focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-aqua"
              >
                • About Us
              </Link>
              <Link
                href="/curriculum"
                className="flex items-center gap-2 text-sm font-medium text-white/75 transition hover:text-brand-aqua focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-aqua"
              >
                • Browse Curricula
              </Link>
              <Link
                href="/#generate"
                className="flex items-center gap-2 text-sm font-medium text-white/75 transition hover:text-brand-aqua focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-aqua"
              >
                • Build a Curriculum
              </Link>
            </div>
          </div>
        </div>

        {/* Bottom copyright row */}
        <div className="mt-12 pt-8 border-t border-white/15 flex flex-col sm:flex-row items-center justify-between gap-3">
          <p className="text-xs text-white/60">
            © {new Date().getFullYear()} Curriculize. All rights reserved.
          </p>
          <p className="text-xs text-white/60">
            Free to use · No subscriptions or paid tiers
          </p>
        </div>
      </div>
    </footer>
  );
}
