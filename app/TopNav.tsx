"use client";

import { usePathname } from "next/navigation";

export function TopNav({ showSuperAdmin = false }: { showSuperAdmin?: boolean }) {
  const pathname = usePathname();
  if (
    pathname === "/login" ||
    pathname === "/setup-password" ||
    pathname?.startsWith("/auth/") ||
    pathname?.startsWith("/admin/scheduler")
  )
    return null;

  const isSuperPage = pathname === "/admin/super";

  return (
    <div className="w-full border-b border-gray-200 bg-white">
      <div className="w-full px-4 py-3 flex items-center justify-between gap-4">
        {isSuperPage ? (
          <a
            href="/admin/scheduler?tab=setup"
            className="inline-flex items-center gap-1.5 text-sm font-semibold text-gray-700 hover:text-gray-900 hover:underline"
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M15 19l-7-7 7-7"
              />
            </svg>
            Back to Setup
          </a>
        ) : (
          <div />
        )}
        <div className="flex items-center gap-4">
          {showSuperAdmin && !isSuperPage && (
            <a
              href="/admin/super"
              className="text-sm font-semibold text-gray-700 hover:text-gray-900 hover:underline"
            >
              Super Admin
            </a>
          )}
          <form action="/logout" method="post" className="inline">
            <button
              type="submit"
              className="text-sm font-semibold text-gray-700 hover:text-gray-900 hover:underline bg-transparent border-none cursor-pointer p-0"
            >
              Log out
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

