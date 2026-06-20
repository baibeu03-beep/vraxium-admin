// 분기형 페이지 slug ↔ 실제 org 접근 게이트 검증.
//
// 검증 항목(요구사항):
//   1) direct function 결과(assertPageAccessBySlug)
//   2) 실제 HTTP API 응답(weekly-cards / stats-cards / resume)
//   3) direct == HTTP (block 여부 일치)
//   4) snapshot 영향 여부(게이트가 snapshot 을 건드리지 않음)
//   5) snapshot 재계산 필요 여부(403 경로는 write 없음)
//   6) (브라우저는 별도 — 본 스크립트는 direct+HTTP 동치만)
//
// 실행: npx tsx --env-file=.env.local scripts/verify-page-access-by-slug.ts
// 사전: dev 서버(:3000) 가 신규 코드로 떠 있어야 함.

import {
  assertPageAccessBySlug,
  PageAccessError,
} from "../lib/pageAccess";
import { pageSlugToOrganization } from "../lib/organizations";
import type { OrganizationSlug } from "../lib/organizations";
import { supabaseAdmin } from "../lib/supabaseAdmin";

const BASE = process.env.VERIFY_BASE_URL ?? "http://localhost:3000";
const INTERNAL = process.env.INTERNAL_API_KEY;

const ORG_TO_SLUG: Record<OrganizationSlug, string> = {
  oranke: "marketing",
  encre: "entertainment",
  phalanx: "planning",
};
const ALL_ORGS: OrganizationSlug[] = ["oranke", "encre", "phalanx"];

type Case = {
  label: string;
  userId: string;
  userOrg: OrganizationSlug;
  slug: string | undefined;
  mode?: string;
  expectBlocked: boolean; // 기대값(정책): 인식된 불일치 slug → 차단, 그 외 통과
};

let failures = 0;
const ok = (c: boolean, msg: string) => {
  console.log(`${c ? "  ✓" : "  ✗ FAIL"} ${msg}`);
  if (!c) failures++;
};

async function pickUserForOrg(org: OrganizationSlug): Promise<string | null> {
  // snapshot row 가 있는 유저를 우선(HTTP 200 경로가 의미 있도록). 없으면 아무나.
  const { data: snapUsers } = await supabaseAdmin
    .from("cluster4_weekly_card_snapshots")
    .select("user_id")
    .limit(500);
  const snapSet = new Set((snapUsers ?? []).map((r: { user_id: string }) => r.user_id));
  const { data } = await supabaseAdmin
    .from("user_profiles")
    .select("user_id, organization_slug")
    .eq("organization_slug", org)
    .limit(200);
  const rows = (data ?? []) as { user_id: string }[];
  const withSnap = rows.find((r) => snapSet.has(r.user_id));
  return (withSnap ?? rows[0])?.user_id ?? null;
}

async function snapshotComputedAt(userId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("cluster4_weekly_card_snapshots")
    .select("computed_at")
    .eq("user_id", userId)
    .maybeSingle();
  return (data as { computed_at: string } | null)?.computed_at ?? null;
}

async function directBlocked(c: Case): Promise<{ blocked: boolean; status: number | null }> {
  try {
    await assertPageAccessBySlug({
      userId: c.userId,
      mode: c.mode,
      pageType: "cluster4",
      requestedSlug: c.slug,
    });
    return { blocked: false, status: null };
  } catch (e) {
    if (e instanceof PageAccessError) return { blocked: true, status: e.status };
    throw e;
  }
}

async function httpStatus(path: string, c: Case): Promise<number> {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set("userId", c.userId);
  if (c.slug) url.searchParams.set("pageSlug", c.slug);
  if (c.mode) url.searchParams.set("mode", c.mode);
  // weekly-cards 외 라우트는 weekId/partType 불필요(검증 대상은 게이트 이전 단계).
  const res = await fetch(url.toString(), {
    headers: { "x-internal-api-key": INTERNAL ?? "" },
  });
  return res.status;
}

async function main() {
  if (!INTERNAL) {
    console.error("INTERNAL_API_KEY 없음 — .env.local 확인");
    process.exit(2);
  }

  // 0) slug→org 매핑 단위 점검
  console.log("\n[0] slug→org 매핑(역방향 SoT)");
  ok(pageSlugToOrganization("entertainment").org === "encre", "entertainment → encre");
  ok(pageSlugToOrganization("-ec").org === "encre", "legacy -ec → encre");
  ok(pageSlugToOrganization("marketing").org === "oranke", "marketing → oranke");
  ok(pageSlugToOrganization("planning").org === "phalanx", "planning → phalanx");
  ok(pageSlugToOrganization("garbage").recognized === false, "garbage → 미인식");

  // 1) org 별 대표 유저
  const userByOrg: Partial<Record<OrganizationSlug, string>> = {};
  for (const org of ALL_ORGS) {
    const u = await pickUserForOrg(org);
    if (u) userByOrg[org] = u;
    console.log(`[users] ${org}: ${u ?? "(없음)"}`);
  }

  // 2) 케이스 매트릭스 구성
  const cases: Case[] = [];
  for (const org of ALL_ORGS) {
    const userId = userByOrg[org];
    if (!userId) continue;
    const ownSlug = ORG_TO_SLUG[org];
    const otherOrg = ALL_ORGS.find((o) => o !== org)!;
    const otherSlug = ORG_TO_SLUG[otherOrg];
    cases.push({ label: `${org} + 정상 slug(${ownSlug})`, userId, userOrg: org, slug: ownSlug, expectBlocked: false });
    cases.push({ label: `${org} + 잘못된 slug(${otherSlug})`, userId, userOrg: org, slug: otherSlug, expectBlocked: true });
    cases.push({ label: `${org} + slug 없음(구버전)`, userId, userOrg: org, slug: undefined, expectBlocked: false });
    cases.push({ label: `${org} + 잘못된 slug + mode=test`, userId, userOrg: org, slug: otherSlug, mode: "test", expectBlocked: true });
    cases.push({ label: `${org} + 정상 slug + mode=test`, userId, userOrg: org, slug: ownSlug, mode: "test", expectBlocked: false });
  }

  // 3) direct vs HTTP 동치 + 기대값
  console.log("\n[1-3] direct vs HTTP (weekly-cards)");
  const snapBefore = new Map<string, string | null>();
  for (const userId of Object.values(userByOrg)) {
    if (userId) snapBefore.set(userId, await snapshotComputedAt(userId));
  }

  for (const c of cases) {
    const d = await directBlocked(c);
    const httpCode = await httpStatus("/api/cluster4/weekly-cards", c);
    const httpBlocked = httpCode === 403;
    console.log(
      `\n• ${c.label}\n    direct.blocked=${d.blocked}(status=${d.status}) | http=${httpCode}`,
    );
    ok(d.blocked === c.expectBlocked, `direct 기대값 일치(expect blocked=${c.expectBlocked})`);
    ok(httpBlocked === c.expectBlocked, `HTTP 기대값 일치(expect 403=${c.expectBlocked})`);
    ok(d.blocked === httpBlocked, `direct == HTTP (block 여부 동치)`);
  }

  // 4) 다른 분기형 페이지(cluster3 stats-cards, cluster1 resume) 동일 적용
  console.log("\n[4] 다른 분기형 페이지(cluster3/cluster1) 불일치 차단");
  for (const org of ALL_ORGS) {
    const userId = userByOrg[org];
    if (!userId) continue;
    const otherSlug = ORG_TO_SLUG[ALL_ORGS.find((o) => o !== org)!];
    const ownSlug = ORG_TO_SLUG[org];
    const mm: Case = { label: "", userId, userOrg: org, slug: otherSlug, expectBlocked: true };
    const mt: Case = { label: "", userId, userOrg: org, slug: ownSlug, expectBlocked: false };
    const s3mm = await httpStatus("/api/cluster3/stats-cards", mm);
    const s3mt = await httpStatus("/api/cluster3/stats-cards", mt);
    const c1mm = await httpStatus("/api/cluster1/resume", mm);
    const c1mt = await httpStatus("/api/cluster1/resume", mt);
    console.log(`  ${org}: stats-cards mismatch=${s3mm} match=${s3mt} | resume mismatch=${c1mm} match=${c1mt}`);
    ok(s3mm === 403, `cluster3 stats-cards 불일치 → 403 (${org})`);
    ok(s3mt !== 403, `cluster3 stats-cards 정상 → 비403 (${org})`);
    ok(c1mm === 403, `cluster1 resume 불일치 → 403 (${org})`);
    ok(c1mt !== 403, `cluster1 resume 정상 → 비403 (${org})`);
  }

  // 5) snapshot 영향: 게이트는 snapshot 을 write 하지 않는다(403 경로는 조회 전 차단).
  console.log("\n[5] snapshot 영향 여부");
  for (const [userId, before] of snapBefore) {
    const after = await snapshotComputedAt(userId);
    // 정상 경로(loadWeeklyCards)는 stale 시 lazy recompute 가능 — 게이트 자체의 영향은 아님.
    // 핵심 보장: 403 차단은 snapshot 미접촉. 여기서는 computed_at 변화 유무만 보고.
    console.log(`  ${userId}: before=${before ?? "-"} after=${after ?? "-"} ${before === after ? "(불변)" : "(변경: lazy recompute, 게이트 무관)"}`);
  }

  console.log(`\n${failures === 0 ? "✅ ALL PASS" : `❌ ${failures} FAIL`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
