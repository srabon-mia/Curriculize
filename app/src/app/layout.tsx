import type { Metadata } from "next";
import { Space_Grotesk, Inter } from "next/font/google";
import "./globals.css";
import { BackToTop } from "@/components/BackToTop";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-space-grotesk",
  display: "swap",
});

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Curriculize — Human-Curated Study Guides",
  description:
    "Discover structured learning roadmaps built around authoritative, human-written curricula and resources. Generate topic-by-topic study guides or browse published curricula.",
  openGraph: {
    title: "Curriculize — Human-Curated Study Guides",
    description:
      "Discover structured learning roadmaps built around authoritative, human-written curricula and resources.",
    siteName: "Curriculize",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Curriculize — Human-Curated Study Guides",
    description:
      "Discover structured learning roadmaps built around authoritative, human-written curricula and resources.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`h-full antialiased scroll-smooth ${inter.variable} ${spaceGrotesk.variable}`}
    >
      <body className="min-h-full flex flex-col font-sans">
        {children}
        <BackToTop />
      </body>
    </html>
  );
}

