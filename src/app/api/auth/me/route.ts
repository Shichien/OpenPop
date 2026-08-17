import { NextRequest } from "next/server";

import { currentUser, providerEnabled, PROVIDERS } from "@/lib/auth";
import { noStoreJson } from "@/lib/responses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return noStoreJson({
    user: await currentUser(request),
    providers: Object.fromEntries(PROVIDERS.map((provider) => [provider, {
      enabled: providerEnabled(provider),
      login_url: `/auth/${provider}`,
    }])),
  });
}
