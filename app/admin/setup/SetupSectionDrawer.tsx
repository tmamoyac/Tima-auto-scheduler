"use client";

import { useState } from "react";

export function SetupSectionDrawer({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border border-gray-200 rounded-lg bg-white shadow-sm overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-2 px-4 py-3 text-left font-semibold text-gray-800 hover:bg-gray-50 transition-colors"
        aria-expanded={open}
      >
        <span>{title}</span>
        <span
          className={`text-gray-500 transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden
        >
          ▼
        </span>
      </button>
      {open && <div className="px-4 pb-4 pt-0 border-t border-gray-100">{children}</div>}
    </div>
  );
}
