import { replay } from "@/lib/social-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ runId: string }> }) {
  return replay((await context.params).runId);
}
