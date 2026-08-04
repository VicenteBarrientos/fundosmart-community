import type { AppUser } from "@/app/auth";
import { DEMO_EMAIL } from "@/src/modules/demo/data/demo-data.mjs";
import { cookies } from "next/headers";

export const ACCOUNT_MODE_COOKIE = "fundosmart_account_mode";
export const ACCOUNT_MODE_DEMO = "demo";
export const ACTIVE_ORGANIZATION_COOKIE = "fundosmart_active_organization";

export async function resolveAccountUser(user: AppUser | null): Promise<AppUser | null> {
  const accountMode = (await cookies()).get(ACCOUNT_MODE_COOKIE)?.value;
  if (accountMode !== ACCOUNT_MODE_DEMO) return user;

  return {
    subject: "demo",
    displayName: "Usuario Demo",
    email: DEMO_EMAIL,
    fullName: "Usuario Demo",
  };
}

export function safeProductReturnPath(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/app";

  try {
    const url = new URL(value, "https://fundosmart.local");
    if (url.origin !== "https://fundosmart.local") return "/app";
    if (url.pathname !== "/app" && !url.pathname.startsWith("/app/")) return "/app";
    if (url.pathname === "/app/cuenta") return "/app";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/app";
  }
}
