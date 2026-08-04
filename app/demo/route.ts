import {
  ACCOUNT_MODE_COOKIE,
  ACCOUNT_MODE_DEMO,
  safeProductReturnPath,
} from "@/app/account-mode";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const returnTo = safeProductReturnPath(url.searchParams.get("returnTo"));
  const secure = url.protocol === "https:" ? "; Secure" : "";

  return new Response(null, {
    status: 303,
    headers: {
      "Cache-Control": "no-store",
      Location: new URL(returnTo, url).toString(),
      "Set-Cookie": `${ACCOUNT_MODE_COOKIE}=${ACCOUNT_MODE_DEMO}; Path=/; Max-Age=604800; HttpOnly; SameSite=Lax${secure}`,
    },
  });
}
