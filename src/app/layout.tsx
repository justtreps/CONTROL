import type { Metadata } from "next";
import { Inter, Oswald, Space_Mono } from "next/font/google";
import "./globals.css";
import { CustomCursor } from "@/components/CustomCursor";
import { BackgroundGrid } from "@/components/BackgroundGrid";
import { AppProviders } from "@/components/AppProviders";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const oswald = Oswald({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-oswald",
  display: "swap",
});

const spaceMono = Space_Mono({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-space-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "CONTROL",
  description: "Live quality scoring router for SMM services",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="fr"
      className={`${inter.variable} ${oswald.variable} ${spaceMono.variable}`}
    >
      <body className="min-h-screen antialiased">
        <BackgroundGrid />
        <div className="noise-overlay" aria-hidden="true" />
        <CustomCursor />
        <AppProviders>{children}</AppProviders>
      </body>
    </html>
  );
}
