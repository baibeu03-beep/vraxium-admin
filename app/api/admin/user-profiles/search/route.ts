import { NextRequest, NextResponse } from "next/server";
import {
  ADMIN_READ_ROLES,
  requireAdmin,
  toAdminErrorResponse,
} from "@/lib/adminAuth";
import { searchUserProfiles } from "@/lib/adminApplicantData";
import { parseScopeMode } from "@/lib/userScopeShared";

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const query = request.nextUrl.searchParams.get("q")?.trim();
  if (!query) {
    return NextResponse.json({ users: [] });
  }

  try {
    const users = await searchUserProfiles(
      query,
      parseScopeMode(request.nextUrl.searchParams.get("mode")),
    );
    return NextResponse.json({ users });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to search user profiles",
      },
      { status: 500 },
    );
  }
}
