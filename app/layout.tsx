import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Toaster } from "sonner";
import "./globals.css";

/**
 * Real webfonts loaded at build time via next/font (self-hosted, no layout
 * shift). The CSS variables below are the ones the design system in
 * globals.css references for --font-sans / --font-mono. If font fetching is
 * unavailable, next/font emits a fallback adjusted to the system stack, so the
 * UI stays legible either way.
 */
const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-jetbrains-mono",
});

export const metadata: Metadata = {
  title: "AI Automation Tester",
  description:
    "Register applications and repositories, queue end-to-end or exploratory runs, and let the AI worker open pull requests with generated Playwright tests.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body>
        {children}
        <Toaster richColors position="top-right" theme="dark" />
      </body>
    </html>
  );
}
