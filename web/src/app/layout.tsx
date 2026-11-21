import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { Backdrop } from "@/components/backdrop/Backdrop";
import { Motion, MOTION_BOOT } from "@/components/backdrop/Motion";
import { site } from "@/lib/site";
import { InstallWorker } from "@/components/InstallWorker";
import "./globals.css";
import "./identity.css";
import "./round5.css";
import "./round6.css";
import "./round7.css";
import "./round8.css";

import "./craft.css";
import "./engraved.css";
import "./dotted.css"; // the dotted layer loads last
// Self-hosted faces (the content security policy allows no third-party font hosts).
const display = localFont({
  src: [
    { path: "../fonts/display-roman.woff2", style: "normal", weight: "300 700" },
    { path: "../fonts/display-italic.woff2", style: "italic", weight: "300 700" },
  ],
  variable: "--face-display",
  display: "swap",
  fallback: ["Garamond", "Georgia", "serif"],
});
const sans = localFont({
  src: [
    { path: "../fonts/sans-roman.woff2", style: "normal", weight: "400 700" },
    { path: "../fonts/sans-italic.woff2", style: "italic", weight: "400 700" },
  ],
  variable: "--face-sans",
  display: "swap",
  fallback: ["system-ui", "Helvetica Neue", "Arial", "sans-serif"],
});
const mono = localFont({
  src: [
    { path: "../fonts/mono-400.woff2", style: "normal", weight: "400" },
    { path: "../fonts/mono-500.woff2", style: "normal", weight: "500" },
  ],
  variable: "--face-mono",
  display: "swap",
  fallback: ["ui-monospace", "Menlo", "Consolas", "monospace"],
});

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000"),
  title: { default: `${site.name}: ${site.tagline}`, template: `%s | ${site.name}` },
  description: site.description,
  applicationName: site.name,
  openGraph: { title: site.name, description: site.description, siteName: site.name, type: "website" },
  twitter: { card: "summary_large_image", title: site.name, description: site.description },
  robots: { index: true, follow: true },
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: site.name, statusBarStyle: "black-translucent" },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "48x48" },
      { url: "/icon.png", type: "image/png", sizes: "512x512" },
    ],
    apple: "/icons/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  themeColor: "#040404",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: MOTION_BOOT }} />
      </head>
      <body>
        <Backdrop />
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <Header />
        <main id="main" className="site-main">
          {children}
        </main>
        <Footer />
        <Motion />
        <InstallWorker />
      </body>
    </html>
  );
}
