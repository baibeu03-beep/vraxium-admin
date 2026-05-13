import { NextRequest } from "next/server";
import { ADMIN_READ_ROLES, requireAdmin, toAdminErrorResponse } from "@/lib/adminAuth";
import { listMembers } from "@/lib/adminMembersData";
import {
  isMemberSortColumn,
  ORG_NONE_SENTINEL,
  type MemberSortDir,
  type PresenceFilter,
} from "@/lib/adminMembersTypes";
import { isOrganizationSlug } from "@/lib/organizations";

function parseIntParam(
  raw: string | null,
  fallback: number,
  { min, max }: { min: number; max: number },
) {
  if (raw == null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function parsePresence(raw: string | null): PresenceFilter | null {
  if (raw === "has" || raw === "missing") return raw;
  return null;
}

// sort=display_name.asc, sort=created_at.desc 형식.
function parseSort(raw: string | null): {
  sortBy: ReturnType<typeof isMemberSortColumn> extends true ? string : string | null;
  sortDir: MemberSortDir | null;
  error?: string;
} {
  if (!raw) return { sortBy: null, sortDir: null };
  const trimmed = raw.trim();
  if (!trimmed) return { sortBy: null, sortDir: null };
  const [column, dir] = trimmed.split(".");
  if (!column || !isMemberSortColumn(column)) {
    return { sortBy: null, sortDir: null, error: `Unknown sort column: ${column}` };
  }
  const sortDir: MemberSortDir = dir === "asc" ? "asc" : "desc";
  return { sortBy: column, sortDir };
}

export async function GET(request: NextRequest) {
  try {
    await requireAdmin(ADMIN_READ_ROLES);
  } catch (error) {
    const response = toAdminErrorResponse(error);
    if (response) return response;
    throw error;
  }

  const params = request.nextUrl.searchParams;
  const q = params.get("q")?.trim() || null;

  const orgParam = params.get("organization")?.trim() || null;
  let organization: string | null = null;
  if (orgParam) {
    if (orgParam === ORG_NONE_SENTINEL || isOrganizationSlug(orgParam)) {
      organization = orgParam;
    } else {
      return Response.json(
        { success: false, error: `Unknown organization: ${orgParam}` },
        { status: 400 },
      );
    }
  }

  const status = params.get("status")?.trim() || null;
  const growthStatus = params.get("growth_status")?.trim() || null;
  const authEmailPresence = parsePresence(params.get("auth_email"));
  const contactEmailPresence = parsePresence(params.get("contact_email"));

  const sort = parseSort(params.get("sort"));
  if (sort.error) {
    return Response.json(
      { success: false, error: sort.error },
      { status: 400 },
    );
  }

  const limit = parseIntParam(params.get("limit"), 100, { min: 1, max: 500 });
  const offset = parseIntParam(params.get("offset"), 0, { min: 0, max: 100000 });

  try {
    const data = await listMembers({
      query: q,
      organization,
      status,
      growthStatus,
      authEmailPresence,
      contactEmailPresence,
      sortBy: isMemberSortColumn(sort.sortBy ?? "") ? (sort.sortBy as never) : null,
      sortDir: sort.sortDir,
      limit,
      offset,
    });
    return Response.json({ success: true, data });
  } catch (error) {
    console.error("[admin/members GET]", error);
    return Response.json(
      {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to load members",
      },
      { status: 500 },
    );
  }
}
