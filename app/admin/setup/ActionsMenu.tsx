"use client";

import { useEffect, useRef, useState } from "react";

export type ActionItem = {
  label: string;
  onClick: () => void;
  variant?: "default" | "danger";
};

export function ActionsMenu({
  items,
  onClose,
}: {
  items: ActionItem[];
  onClose?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
        onClose?.();
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open, onClose]);

  const handleItemClick = (item: ActionItem) => {
    item.onClick();
    setOpen(false);
  };

  return (
    <div className="relative" ref={menuRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="p-1 rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        aria-label="Actions"
      >
        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
          <path d="M10 6a2 2 0 110-4 2 2 0 010 4zM10 12a2 2 0 110-4 2 2 0 010 4zM10 18a2 2 0 110-4 2 2 0 010 4z" />
        </svg>
      </button>
      {open && (
        <div
          className="absolute right-0 mt-1 w-40 rounded-lg bg-white shadow-lg ring-1 ring-black ring-opacity-5 z-10 py-1"
          role="menu"
        >
          {items.map((item, i) => (
            <button
              key={i}
              type="button"
              onClick={() => handleItemClick(item)}
              className={`block w-full text-left px-4 py-2 text-sm ${
                item.variant === "danger"
                  ? "text-red-700 hover:bg-red-50"
                  : "text-gray-700 hover:bg-gray-50"
              }`}
              role="menuitem"
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
