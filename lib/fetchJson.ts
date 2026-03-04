/**
 * Safely parses JSON from a fetch Response.
 * When APIs return HTML (e.g. login redirect), res.json() throws.
 * This helper detects that and returns a clear error.
 */
export async function safeParseJson<T = unknown>(res: Response): Promise<T> {
  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text();

  if (contentType.includes("text/html")) {
    throw new Error("Session may have expired. Please log in again.");
  }

  try {
    return text ? (JSON.parse(text) as T) : ({} as T);
  } catch {
    throw new Error(text || "Invalid response from server");
  }
}
