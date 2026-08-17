import { practiceBuildsPayload } from "@/lib/builds";
import { noStoreJson } from "@/lib/responses";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  return noStoreJson(practiceBuildsPayload());
}
