import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "TweetRadar — 24/7 X Monitoring with Telegram Alerts",
  description:
    "Watch any X/Twitter account 24/7 for posts, reposts, replies, likes and follows — with instant Telegram alert delivery.",
  keywords: ["Twitter monitor", "X API", "Telegram alerts", "social listening", "TweetRadar"],
  icons: {
    icon: "https://z-cdn.chatglm.cn/z-ai/static/logo.svg",
  },
  openGraph: {
    title: "TweetRadar",
    description: "24/7 X monitoring with instant Telegram alerts",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Pre-paint theme script: applies the persisted theme (default DARK) to
  // <html> before first paint — no light/dark flash on load.
  const themeInit = `try{var t=localStorage.getItem("tweetradar-theme");if(t==="light"){document.documentElement.classList.remove("dark")}else{document.documentElement.classList.add("dark")}}catch(e){}`;
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInit }} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
