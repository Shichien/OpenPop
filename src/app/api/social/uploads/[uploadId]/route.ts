import { NextRequest } from "next/server";

import { removeUpload } from "@/lib/social-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(request: NextRequest, context: { params: Promise<{ uploadId: string }> }) {
  return removeUpload(request, (await context.params).uploadId);
}
