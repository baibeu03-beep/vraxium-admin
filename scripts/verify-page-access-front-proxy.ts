// 프론트 프록시의 Referer → pageSlug 전달 검증(end-to-end HTTP).
// 프론트 dev 서버(기본 :3001)가 떠 있어야 한다.
//   - Referer 가 정상 org 페이지면 200, 불일치 org 페이지면 403, Referer 없으면 200(fail-open).
// 실행: npx tsx --env-file=.env.local scripts/verify-page-access-front-proxy.ts
import { supabaseAdmin } from "../lib/supabaseAdmin";
import type { OrganizationSlug } from "../lib/organizations";

const FRONT = process.env.FRONT_BASE_URL ?? "http://localhost:3001";
const ORG_TO_SLUG: Record<OrganizationSlug, string> = {
  oranke: "marketing",
  encre: "entertainment",
  phalanx: "planning",
};
const ALL: OrganizationSlug[] = ["oranke", "encre", "phalanx"];

let fail = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? "  ✓" : "  ✗ FAIL"} ${m}`); if (!c) fail++; };

async function userFor(org: OrganizationSlug): Promise<string | null> {
  const { data } = await supabaseAdmin.from("user_profiles").select("user_id").eq("organization_slug", org).limit(1);
  return data?.[0]?.user_id ?? null;
}

async function call(userId: string, refererPath: string | null): Promise<number> {
  const headers: Record<string, string> = {};
  if (refererPath) headers["referer"] = `${FRONT}${refererPath}`;
  const res = await fetch(`${FRONT}/api/cluster4/weekly-cards?userId=${userId}`, { headers });
  return res.status;
}

(async () => {
  for (const org of ALL) {
    const userId = await userFor(org);
    if (!userId) { console.log(`(skip ${org}: no user)`); continue; }
    const own = ORG_TO_SLUG[org];
    const other = ORG_TO_SLUG[ALL.find((o) => o !== org)!];
    console.log(`\n• ${org} user=${userId}`);
    const matchCode = await call(userId, `/cluster-4-${own}`);
    const mismatchCode = await call(userId, `/cluster-4-${other}`);
    const noRefCode = await call(userId, null);
    console.log(`    match(/cluster-4-${own})=${matchCode} | mismatch(/cluster-4-${other})=${mismatchCode} | no-referer=${noRefCode}`);
    ok(matchCode !== 403, `정상 페이지 Referer → 비403`);
    ok(mismatchCode === 403, `불일치 페이지 Referer → 403`);
    ok(noRefCode !== 403, `Referer 없음 → 비403(fail-open)`);
  }
  console.log(`\n${fail === 0 ? "✅ FRONT PROXY PASS" : `❌ ${fail} FAIL`}`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
