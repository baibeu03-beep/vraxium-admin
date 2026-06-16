import type { NextRequest } from "next/server";
import { resolveDemoProfileUserId } from "@/lib/demoMode";
import {
  readScopeMode,
  resolveUserScope,
  type ScopeMode,
  type UserScope,
} from "@/lib/userScope";
import { isOrganizationSlug, type OrganizationSlug } from "@/lib/organizations";

export type RequestScope = {
  org: OrganizationSlug | null;
  mode: ScopeMode;
  demoUserId: string | null;
  targetUserId: string | null;
  userScope: UserScope;
};

export async function resolveRequestScope(
  request: NextRequest,
  opts: {
    orgParam?: "organization" | "org";
    targetUserIdParam?: string;
    defaultTargetUserId?: string | null;
  } = {},
): Promise<RequestScope> {
  const params = request.nextUrl.searchParams;
  const orgParam = opts.orgParam ?? "organization";
  const orgRaw = params.get(orgParam)?.trim() || params.get("org")?.trim() || null;
  const org = isOrganizationSlug(orgRaw) ? orgRaw : null;

  const demoUserId = await resolveDemoProfileUserId(request);
  const mode = demoUserId ? "test" : readScopeMode(params);
  const requestedTarget =
    params.get(opts.targetUserIdParam ?? "userId")?.trim() ||
    opts.defaultTargetUserId ||
    null;
  const targetUserId = requestedTarget || demoUserId || null;
  const userScope = await resolveUserScope(mode, org);

  return {
    org,
    mode,
    demoUserId,
    targetUserId,
    userScope,
  };
}

