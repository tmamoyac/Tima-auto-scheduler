"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body>
        <div style={{ padding: "2rem", fontFamily: "sans-serif" }}>
          <h2 style={{ color: "#b91c1c", fontWeight: 600 }}>Something went wrong</h2>
          <p style={{ marginTop: "0.5rem", color: "#4b5563" }}>{error.message}</p>
          <button
            type="button"
            onClick={() => reset()}
            style={{
              marginTop: "1rem",
              padding: "0.5rem 0.75rem",
              background: "#e5e7eb",
              border: "none",
              borderRadius: "4px",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
