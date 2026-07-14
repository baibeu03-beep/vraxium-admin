// 관리자별 허용 조직 SoT 검증 (직접 DB — dev 서버 불필요).
//   실제 admin_users × user_profiles.organization_slug 로 resolveAdminOrgAccess 결과가
//   정책(owner/공통=전체 · slug=단일 · 미인식=없음)과 일치하는지 확인한다.
//   또 assertAdminOrgAccess / guardAdminOrgAccess / isRowOrgAllowed 분기를 단위 검증한다.
//
// 실행: npm exec tsx -- --env-file=.env.local scripts/verify-admin-org-access.ts

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  resolveAdminOrgAccess,
  assertAdminOrgAccess,
  guardAdminOrgAccess,
  isRowOrgAllowed,
  type AdminOrgAccess,
} from "@/lib/adminOrgAccess";
import { AdminAuthError, type AdminContext } from "@/lib/adminAuth";
import { ORGANIZATIONS, type OrganizationSlug } from "@/lib/organizations";

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${label}`);
  }
}

function expectedFor(
  role: string,
  slug: string | null,
): AdminOrgAccess {
  if (role === "owner") return { allowedOrgs: [...ORGANIZATIONS], isAllOrgs: true };
  const s = (slug ?? "").trim();
  if (s === "") return { allowedOrgs: [...ORGANIZATIONS], isAllOrgs: true };
  if ((ORGANIZATIONS as readonly string[]).includes(s))
    return { allowedOrgs: [s as OrganizationSlug], isAllOrgs: false };
  return { allowedOrgs: [], isAllOrgs: false };
}

function sameAccess(a: AdminOrgAccess, b: AdminOrgAccess): boolean {
  return (
    a.isAllOrgs === b.isAllOrgs &&
    a.allowedOrgs.length === b.allowedOrgs.length &&
    a.allowedOrgs.every((o, i) => o === b.allowedOrgs[i])
  );
}

async function main() {
  console.log("── 실제 admin_users × user_profiles.organization_slug 검증 ──");
  const { data: admins, error } = await supabaseAdmin
    .from("admin_users")
    .select("id,email,role,is_active");
  if (error) throw new Error(error.message);

  const rows = (admins ?? []) as Array<{
    id: string;
    email: string | null;
    role: string | null;
    is_active: boolean | null;
  }>;
  console.log(`  admin_users: ${rows.length}건`);

  for (const r of rows.filter((x) => x.is_active && x.role)) {
    const { data: prof } = await supabaseAdmin
      .from("user_profiles")
      .select("organization_slug")
      .eq("user_id", r.id)
      .maybeSingle();
    const slug = (prof?.organization_slug ?? null) as string | null;

    const admin: AdminContext = {
      userId: r.id,
      email: r.email,
      role: r.role as AdminContext["role"],
      isActive: true,
    };
    const got = await resolveAdminOrgAccess(admin);
    const want = expectedFor(r.role as string, slug);
    ok(
      sameAccess(got, want),
      `${r.email ?? r.id} (role=${r.role}, org=${slug ?? "∅"}) → [${got.allowedOrgs.join(",")}] isAll=${got.isAllOrgs}`,
    );

    // assertAdminOrgAccess: 허용 org 통과, 비허용 org 403.
    if (!got.isAllOrgs && got.allowedOrgs.length > 0) {
      const allowed = got.allowedOrgs[0];
      const denied = ORGANIZATIONS.find((o) => !got.allowedOrgs.includes(o))!;
      let passed = false;
      try {
        await assertAdminOrgAccess(admin, allowed);
        passed = true;
      } catch {
        passed = false;
      }
      ok(passed, `    assert 허용 org(${allowed}) 통과`);

      let threw403 = false;
      try {
        await assertAdminOrgAccess(admin, denied);
      } catch (e) {
        threw403 = e instanceof AdminAuthError && e.status === 403;
      }
      ok(threw403, `    assert 비허용 org(${denied}) → 403`);

      const guardDenied = await guardAdminOrgAccess(admin, denied);
      ok(
        guardDenied instanceof Response && guardDenied.status === 403,
        `    guard 비허용 org(${denied}) → 403 Response`,
      );
      const guardAllowed = await guardAdminOrgAccess(admin, allowed);
      ok(guardAllowed === null, `    guard 허용 org(${allowed}) → null(통과)`);
    }
  }

  // 현재 admin_users 는 전부 owner(전체 허용)라, 단일 조직 경로를 실제 DB 로 검증하기 위해
  //   organization_slug 가 특정 org 인 실제 user_profiles 를 비-owner 관리자로 가정해 resolve 한다.
  console.log(
    "\n── 단일 조직 경로(실제 user_profiles.organization_slug 를 role=admin 으로 가정) ──",
  );
  for (const org of ORGANIZATIONS) {
    const { data: u } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id")
      .eq("organization_slug", org)
      .limit(1)
      .maybeSingle();
    if (!u?.user_id) {
      console.log(`  (org=${org}: 표본 user_profiles 없음 — 건너뜀)`);
      continue;
    }
    const admin: AdminContext = {
      userId: u.user_id,
      email: null,
      role: "admin",
      isActive: true,
    };
    const got = await resolveAdminOrgAccess(admin);
    ok(
      got.isAllOrgs === false &&
        got.allowedOrgs.length === 1 &&
        got.allowedOrgs[0] === org,
      `org=${org} 소속 사용자를 admin 으로 → 허용 [${got.allowedOrgs.join(",")}] isAll=${got.isAllOrgs}`,
    );
    const other = ORGANIZATIONS.find((o) => o !== org)!;
    let threw = false;
    try {
      await assertAdminOrgAccess(admin, other);
    } catch (e) {
      threw = e instanceof AdminAuthError && e.status === 403;
    }
    ok(threw, `  org=${org} admin → 타 org(${other}) assert 403`);
  }

  // 미인식 organization_slug(예: "common" 은 조직 slug 가 아님)를 가진 사용자 → 없음(fail-closed).
  {
    const { data: u } = await supabaseAdmin
      .from("user_profiles")
      .select("user_id,organization_slug")
      .not("organization_slug", "is", null)
      .not("organization_slug", "in", `(${ORGANIZATIONS.join(",")})`)
      .limit(1)
      .maybeSingle();
    if (u?.user_id) {
      const admin: AdminContext = {
        userId: u.user_id,
        email: null,
        role: "admin",
        isActive: true,
      };
      const got = await resolveAdminOrgAccess(admin);
      ok(
        got.allowedOrgs.length === 0 && got.isAllOrgs === false,
        `미인식 org("${u.organization_slug}") admin → 허용 없음(fail-closed)`,
      );
    } else {
      console.log("  (미인식 organization_slug 표본 없음 — 건너뜀)");
    }
  }

  console.log("\n── isRowOrgAllowed 단위(공통/미지정/타org 차단) ──");
  const single: AdminOrgAccess = { allowedOrgs: ["encre"], isAllOrgs: false };
  const all: AdminOrgAccess = { allowedOrgs: [...ORGANIZATIONS], isAllOrgs: true };
  ok(isRowOrgAllowed(single, "encre") === true, "single: 자기 org 허용");
  ok(isRowOrgAllowed(single, "oranke") === false, "single: 타 org 차단");
  ok(isRowOrgAllowed(single, "common") === false, "single: 공통(common) 차단");
  ok(isRowOrgAllowed(single, null) === false, "single: 미지정(null) 차단");
  ok(isRowOrgAllowed(all, "common") === true, "all: 공통 허용");
  ok(isRowOrgAllowed(all, null) === true, "all: 미지정 허용");
  ok(isRowOrgAllowed(all, "phalanx") === true, "all: 임의 org 허용");

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
