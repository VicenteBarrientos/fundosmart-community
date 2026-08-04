const LOCAL_PUBLIC_ORIGIN = "http://localhost:3000";

export function publicUrl(path = "/"): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim() || LOCAL_PUBLIC_ORIGIN;
  let origin: URL;
  try {
    origin = new URL(configured);
  } catch {
    throw new Error("NEXT_PUBLIC_APP_URL must be an absolute URL.");
  }
  if (origin.pathname !== "/" || origin.search || origin.hash) {
    throw new Error("NEXT_PUBLIC_APP_URL must be an origin without a path, query, or fragment.");
  }
  return new URL(path, origin).toString();
}
