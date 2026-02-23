import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { BackgroundCanvas } from "./components/BackgroundCanvas";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Com Tower",
  description: "AWBW turn notifications",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased min-h-screen`}
      >
        <BackgroundCanvas />
        <div className="relative z-0 min-h-screen">{children}</div>
        <footer className="fixed bottom-2 left-0 right-0 z-0 flex justify-center gap-3 text-[10px] font-mono text-zinc-500">
          <a
            href="https://github.com/awbw-chart/com-tower"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-zinc-400 transition-colors"
          >
            GitHub
          </a>
          <span aria-hidden className="text-zinc-600">·</span>
          <a
            href="https://awbw.amarriner.com"
            target="_blank"
            rel="noopener noreferrer"
            className="hover:text-zinc-400 transition-colors"
          >
            AWBW
          </a>
        </footer>
      </body>
    </html>
  );
}
