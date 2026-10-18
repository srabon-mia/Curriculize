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
  title: "Curriculum Generator — Human-Curated Study Guides",
  description:
    "Generate structured, topic-by-topic study guides compiled from verified, human-curated educational web resources, or browse published curricula.",
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

