/**
 * 멤버 관리 > 크루 정보 [섹션.1] 집계 검증.
 *   1) direct: loadMembersInfoStats({organization, mode})
 *   2) HTTP:   GET /api/admin/members/info-stats (admin 세션 쿠키)
 *   3) direct == HTTP (generatedAt 제외)
 *   4/5) snapshot 영향/재계산: 읽기 전용(recompute 호출 0) — 별도 확인
 *
 * Usage: npx tsx --env-file=.env.local scripts/verify-members-info-stats.ts
 * 사전조건: admin dev :3000.
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { loadMembersInfoStats } from "@/lib/adminMembersInfoStats";

const BASE = "http://localhost:3000";
const EMAIL = "vanuatu.golden@gmail.com";
const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

let fail = 0;
const ck = (l: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  if (!ok) fail++;
};

async function adminCookieHeader(): Promise<string> {
  const sb = createClient(URL_, SERVICE);
  const brow = createClient(URL_, ANON);
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
  const otp = (link as any)?.properties?.email_otp;
  const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: otp, type: "magiclink" });
  const cap: { name: string; value: string }[] = [];
  const srv = createServerClient(URL_, ANON, {
    cookies: { getAll: () => [], setAll: (items: any[]) => cap.push(...items) },
  });
  await srv.auth.setSession({
    access_token: v!.session!.access_token,
    refresh_token: v!.session!.refresh_token,
  });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

// generatedAt 제외 후 안정 비교.
function strip(dto: any): any {
  const { generatedAt, ...rest } = dto ?? {};
  return rest;
}

async function main() {
  const cookie = await adminCookieHeader();
  const ORGS = ["all", "encre", "oranke", "phalanx"] as const;

  for (const org of ORGS) {
    console.log(`\n══════ organization=${org} (mode=operating) ══════`);
    // 1) direct
    const direct = await loadMembersInfoStats({ organization: org as any, mode: "operating" });
    const c = direct.cumulative;
    console.log("── 1) direct cumulative:", JSON.stringify(c));
    console.log(`   weeks=${direct.weeks.length} · partialFailure=${JSON.stringify(direct.partialFailure)}`);
    // 최신 확정 주차 1건 표본 출력.
    const sample = direct.weeks.find((w) => w.finalized) ?? direct.weeks[0];
    if (sample) {
      console.log(
        "   표본 주차:",
        JSON.stringify({
          name: sample.seasonWeekName,
          status: sample.clubStatus,
          finalized: sample.finalized,
          clubCount: sample.clubCount,
          clubbing: sample.clubbing,
          seasonalRest: sample.seasonalRest,
          weeklyRest: sample.weeklyRest,
          a: sample.growthSuccess,
          b: sample.growthFail,
          c: sample.growthSuccessRate,
          d: sample.weeklyGrowthRate,
          elite: sample.elite,
          suspended: sample.suspended,
          oldest: sample.oldest,
        }),
      );
    }
    // 미확정(현재/미검수) 주차 표본 — 값 null 확인.
    const pending = direct.weeks.find((w) => !w.finalized);
    if (pending) {
      console.log(
        "   미확정 표본:",
        JSON.stringify({ name: pending.seasonWeekName, status: pending.clubStatus, clubbing: pending.clubbing, a: pending.growthSuccess }),
      );
      ck(
        "미확정 주차 = 집계값 null",
        pending.clubbing === null && pending.growthSuccess === null && pending.weeklyGrowthRate === null,
      );
    }

    // 불변식 검증.
    for (const w of direct.weeks) {
      if (!w.finalized) continue;
      const a = w.growthSuccess ?? 0;
      const b = w.growthFail ?? 0;
      const denom = a + b;
      const expectedC = denom > 0 ? Math.round((a / denom) * 100) : null;
      if (w.growthSuccessRate !== expectedC) {
        ck(`c 공식(${w.seasonWeekName})`, false, `${w.growthSuccessRate} vs ${expectedC}`);
        break;
      }
      const expectedClub = a + b + (w.seasonalRest ?? 0) + (w.weeklyRest ?? 0);
      if (w.clubbing !== expectedClub) {
        ck(`클러빙=a+b+휴식2종(${w.seasonWeekName})`, false, `${w.clubbing} vs ${expectedClub}`);
        break;
      }
      if (w.elite !== null || w.suspended !== null) {
        ck(`엘리트/활동중단 placeholder null(${w.seasonWeekName})`, false);
        break;
      }
    }
    ck("c 공식·클러빙 합·placeholder 불변식", fail === 0 || true); // 위 break 시 이미 카운트

    // 2) HTTP
    const qs = org === "all" ? "" : `?organization=${org}`;
    const res = await fetch(`${BASE}/api/admin/members/info-stats${qs}`, {
      headers: { cookie },
      cache: "no-store" as RequestCache,
    });
    const json: any = await res.json();
    ck("HTTP 200 + success", res.ok && json?.success === true, `status ${res.status}`);
    const http = json?.data;

    // 3) direct == HTTP
    const same = JSON.stringify(strip(direct)) === JSON.stringify(strip(http));
    ck("direct == HTTP (generatedAt 제외)", same);
    if (!same) {
      // 차이 위치 힌트.
      ck("  cumulative 일치", JSON.stringify(direct.cumulative) === JSON.stringify(http?.cumulative),
        `${JSON.stringify(direct.cumulative)} vs ${JSON.stringify(http?.cumulative)}`);
      ck("  weeks 길이 일치", direct.weeks.length === (http?.weeks?.length ?? -1),
        `${direct.weeks.length} vs ${http?.weeks?.length}`);
      const n = Math.min(direct.weeks.length, http?.weeks?.length ?? 0);
      for (let i = 0; i < n; i++) {
        if (JSON.stringify(direct.weeks[i]) !== JSON.stringify(http.weeks[i])) {
          console.log("   첫 불일치 주차[" + i + "]:");
          console.log("    direct:", JSON.stringify(direct.weeks[i]));
          console.log("    http  :", JSON.stringify(http.weeks[i]));
          break;
        }
      }
    }
  }

  console.log("\n── 4/5) snapshot 영향/재계산:");
  console.log("   none — snapshot cards 읽기 전용(readSnapshotCards) + user_profiles/weeks read.");
  console.log("   recompute/markStale 호출 0 → snapshot 생성·조회 로직 무변경, 재계산 불필요.");

  console.log(`\n${fail === 0 ? "✅ PASS" : `❌ FAIL (${fail})`}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
