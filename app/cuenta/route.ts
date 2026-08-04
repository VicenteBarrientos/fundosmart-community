import {
  ACCOUNT_MODE_COOKIE,
  safeProductReturnPath,
} from "@/app/account-mode";
import { getAppUser, googleSignInPath } from "@/app/auth";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const returnTo = safeProductReturnPath(url.searchParams.get("returnTo"));
  const user = await getAppUser();

  if (!user) {
    const accountReturnTo = `/cuenta?modo=personal&returnTo=${encodeURIComponent(returnTo)}`;
    return new Response(null, {
      status: 303,
      headers: {
        "Cache-Control": "no-store",
        Location: new URL(googleSignInPath(accountReturnTo), url).toString(),
      },
    });
  }

  const secure = url.protocol === "https:" ? "; Secure" : "";

  return new Response(null, {
    status: 303,
    headers: {
      "Cache-Control": "no-store",
      Location: new URL(returnTo, url).toString(),
      "Set-Cookie": `${ACCOUNT_MODE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`,
    },
  });
}
