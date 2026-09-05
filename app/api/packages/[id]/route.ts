import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { apiErrorResponse, requireApiUser, requireSameOrigin } from "@/lib/auth/api";
import { isSafeId } from "@/lib/auth/validation";
import { AppError } from "@/lib/observability/errors";
import { getOwnedPackage, toPackage } from "@/lib/db/repositories/packages";
import { deleteOwnedPackage } from "@/lib/packages/service";
import { recordAuditEvent } from "@/lib/db/repositories/audit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const user = requireApiUser(request);
    const { id } = await context.params;
    if (!isSafeId(id)) throw new AppError("NOT_FOUND", { message: "Package not found." });
    const row = getOwnedPackage(user.id, id);
    if (!row) throw new AppError("NOT_FOUND", { message: "Package not found." });
    return NextResponse.json({ package: toPackage(row) });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    requireSameOrigin(request);
    const user = requireApiUser(request);
    const { id } = await context.params;
    if (!isSafeId(id)) throw new AppError("NOT_FOUND", { message: "Package not found." });
    const deleted = await deleteOwnedPackage(user.id, id);
    if (!deleted) throw new AppError("NOT_FOUND", { message: "Package not found." });
    recordAuditEvent({ userId: user.id, type: "package_delete", detail: "Stored extension package deleted." });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error, request);
  }
}
