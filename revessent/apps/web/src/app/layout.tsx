import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Revessent — Never lose another member to a failed card",
    template: "%s · Revessent"
  },
  description:
    "Revessent is revenue intelligence for subscription businesses — it detects failed payments, retries at the best moment, and acts on churn and upgrade signals before they become outcomes.",
  // Phase 2 foundation: not a production marketing site yet — noindex until launch.
  robots: { index: false, follow: false }
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f1e8d4" },
    { media: "(prefers-color-scheme: dark)", color: "#161512" }
  ]
};

/** Appearance only (Phase 2 §8): theme is the sole localStorage entry. */
const themeScript = `(function(){try{var t=localStorage.getItem("rv.theme");if(t==="dark"||t==="amoled"){document.documentElement.setAttribute("data-theme",t)}}catch(e){}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-dvh">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
