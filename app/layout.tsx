import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { TopNav } from "./TopNav";
import { AuthCallbackRedirect } from "./AuthCallbackRedirect";
import { TokenHydration } from "./TokenHydration";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { hasSuperAdminAccess } from "@/lib/auth/superAdmin";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-geist-sans",
  weight: "100 900",
});
const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-geist-mono",
  weight: "100 900",
});

export const metadata: Metadata = {
  title: "Tima – Smarter Scheduling for Residency Programs",
  description: "Tima helps residency programs manage schedules, rotations, and vacation requests.",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  let showSuperAdmin = false;
  try {
    const supabase = createSupabaseServerClient();
    showSuperAdmin = await hasSuperAdminAccess(supabase);
  } catch {
    showSuperAdmin = false;
  }

  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <AuthCallbackRedirect />
        <TokenHydration />
        <TopNav showSuperAdmin={showSuperAdmin} />
        {children}
      </body>
    </html>
  );
}
