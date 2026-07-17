/**
 * 크루 액트 요약 파리티 — 크루 페이지 == 관리자 "액트 체크 내역" 탭.
 * ─────────────────────────────────────────────────────────────────────
 *   1) 크루 페이지 요약(snapshot actLogs → 크루 어댑터 → 공통 빌더)
 *      == 관리자 탭 요약(HTTP .../acts 의 summary)   — canonical JSON 일치
 *   2) 취소 액트: 요약에서 제외 · 관리자 표(acts) 에는 "취소됨" 으로 존재
 *   3) 요약 ↔ 표 정합: 정규/변동 수, A/B/C 합계(취소 제외 행 기준)
 *   4) operating / mode=test / demoUserId 가 동일 요약(동일 per-user builder)
 *
 *   선행: npm run dev (:3000)
 *   npx tsx --env-file=.env.local scripts/verify-crew-act-summary-parity.ts
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import {
  buildCrewActSummary,
  resolveCrewActKind,
  type CrewActSummary,
  type CrewActSummaryRow,
} from "@/shared/crewActSummary";
import type { Cluster4ActLogDto, Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";
import type { CrewWeekActDetailDto } from "@/lib/adminCrewWeekActDetail";

const BASE = process.env.ADMIN_API_BASE_URL?.replace(/\/$/, "") || "http://localhost:3000";
const u = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const a = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const s = process.env.SUPABASE_SERVICE_ROLE_KEY!;

let passed = 0;
let failed = 0;
function check(n: string, ok: boolean, d?: unknown) {
  if (ok) passed++;
  else failed++;
  if (!ok) console.log(`❌ ${n}${d !== undefined ? " :: " + JSON.stringify(d) : ""}`);
}

async function adminCookie(): Promise<string> {
  const { data: adm } = await supabaseAdmin
    .from("admin_users")
    .select("email")
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(1);
  const email = (adm?.[0] as { email: string } | undefined)?.email;
  if (!email) throw new Error("활성 관리자 없음");
  const A = createClient(u, s);
  const N = createClient(u, a);
  const { data: l } = await A.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await N.auth.verifyOtp({
    email,
    token: (l as { properties: { email_otp: string } }).properties.email_otp,
    type: "magiclink",
  });
  const cap: { name: string; value: string }[] = [];
  const sv = createServerClient(u, a, {
    cookies: {
      getAll: () => [],
      setAll: (items: { name: string; value: string }[]) => cap.push(...items),
    },
  });
  const sess = (v as { session: { access_token: string; refresh_token: string } }).session;
  await sv.auth.setSession({ access_token: sess.access_token, refresh_token: sess.refresh_token });
  return cap.map((c) => `${c.name}=${c.value}`).join("; ");
}

/**
 * 크루 페이지(Cluster4CardContent) 어댑터 재현 — card.actLogs → 요약 행.
 *   ⚠ 어댑터는 vraxium 컴포넌트 안에 있어 import 할 수 없다. **판정 로직(resolveCrewActKind)** 은
 *     공통 SoT 를 그대로 쓰고, 나머지(result/source/point 전달)는 1:1 매핑이라 여기서 재현한다.
 */
function crewPageRows(actLogs: Cluster4ActLogDto[]): CrewActSummaryRow[] {
  return actLogs.map((x) => {
    const source: "regular" | "irregular" = x.source === "irregular" ? "irregular" : "regular";
    return {
      result: x.result === "checked" ? "checked" : "miss",
      source,
      kindKey: resolveCrewActKind(source, x.kind).key,
      pointA: x.pointA ?? 0,
      pointB: x.pointB ?? 0,
      pointC: x.pointC ?? 0,
    };
  });
}

async function fetchAdminActs(
  cookie: string,
  userId: string,
  weekId: string,
  query = "",
): Promise<{ status: number; data?: CrewWeekActDetailDto }> {
  const res = await fetch(`${BASE}/api/admin/members/${userId}/weeks/${weekId}/acts${query}`, {
    headers: { cookie },
    cache: "no-store",
  });
  const json = (await res.json()) as { success?: boolean; data?: CrewWeekActDetailDto };
  return { status: res.status, data: json?.data };
}

async function main() {
  try {
    const h = await fetch(`${BASE}/api/health`);
    if (!h.ok) throw new Error("no health");
  } catch {
    console.log(`❌ dev server 미기동(${BASE}). npm run dev 후 재실행.`);
    process.exit(2);
  }
  const cookie = await adminCookie();

  // 액트 원장 보유 사용자(취소 보유 사용자 우선 포함).
  const { data: aw } = await supabaseAdmin
    .from("process_point_awards")
    .select("user_id,source,cancelled_at")
    .in("source", ["regular", "irregular"]);
  const rows = (aw ?? []) as Array<{ user_id: string; cancelled_at: string | null }>;
  const cancelUsers = [...new Set(rows.filter((r) => r.cancelled_at).map((r) => r.user_id))];
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.user_id, (counts.get(r.user_id) ?? 0) + 1);
  const busiest = [...counts.entries()].sort((x, y) => y[1] - x[1]).map(([id]) => id);
  const users = [...new Set([...cancelUsers, ...busiest])].slice(0, 8);

  const { data: markers } = await supabaseAdmin.from("test_user_markers").select("user_id");
  const testIds = new Set(
    ((markers ?? []) as { user_id: string | null }[]).map((r) => r.user_id).filter(Boolean),
  );

  console.log(`▶ 대상 ${users.length}명 (취소 보유 ${cancelUsers.length}명 포함)\n`);

  for (const uid of users) {
    const snap = await readWeeklyCardsSnapshot(uid);
    if (snap.status !== "hit" && snap.status !== "stale") continue;
    const cards = snap.cards as Cluster4WeeklyCardDto[];
    const withActs = cards.filter((c) => (c.actLogs?.length ?? 0) > 0 && c.weekId);
    if (withActs.length === 0) continue;

    for (const card of withActs.slice(0, 3)) {
      const tag = `${uid.slice(0, 8)}/${card.weekLabel ?? card.startDate}`;

      // (1) 크루 페이지 요약 = snapshot actLogs(취소 미포함) → 공통 빌더
      const crewSummary: CrewActSummary = buildCrewActSummary(crewPageRows(card.actLogs ?? []));

      // 관리자 탭 요약(HTTP)
      const admin = await fetchAdminActs(cookie, uid, card.weekId!);
      if (admin.status !== 200 || !admin.data) {
        check(`${tag} 관리자 acts HTTP 200`, false, { status: admin.status });
        continue;
      }
      const adminSummary = admin.data.summary;

      check(
        `${tag} 크루 페이지 요약 == 관리자 탭 요약(canonical JSON)`,
        JSON.stringify(crewSummary) === JSON.stringify(adminSummary),
        { crew: crewSummary, admin: adminSummary },
      );

      // (2) 취소 액트: 표엔 존재 · 요약엔 미포함
      const cancelledRows = admin.data.acts.filter((r) => r.cancelled);
      if (cancelledRows.length > 0) {
        check(`${tag} 취소 행이 관리자 표에 존재`, true);
        check(
          `${tag} 요약 total == 표의 미취소 행 수(취소 제외)`,
          adminSummary.total === admin.data.acts.filter((r) => !r.cancelled).length,
          { total: adminSummary.total, notCancelled: admin.data.acts.filter((r) => !r.cancelled).length, cancelled: cancelledRows.length },
        );
      }

      // (3) 요약 ↔ 표 정합(취소 제외 행 기준)
      const live = admin.data.acts.filter((r) => !r.cancelled);
      check(`${tag} 정규 수 일치`, adminSummary.regularActCount === live.filter((r) => r.actKindLabel === "정규").length, {
        s: adminSummary.regularActCount,
        rows: live.filter((r) => r.actKindLabel === "정규").length,
      });
      check(`${tag} 변동 수 일치`, adminSummary.variableActCount === live.filter((r) => r.actKindLabel === "변동").length, {
        s: adminSummary.variableActCount,
        rows: live.filter((r) => r.actKindLabel === "변동").length,
      });
      const sumA = live.reduce((n, r) => n + r.pointA, 0);
      const sumB = live.reduce((n, r) => n + r.pointB, 0);
      const sumC = live.reduce((n, r) => n + Math.abs(r.pointC), 0);
      check(`${tag} A 합계 일치`, adminSummary.points.pointA.earned === sumA, { s: adminSummary.points.pointA.earned, rows: sumA });
      check(`${tag} B 합계 일치`, adminSummary.points.pointB.earned === sumB, { s: adminSummary.points.pointB.earned, rows: sumB });
      check(`${tag} C 합계 일치`, adminSummary.points.pointC.earned === sumC, { s: adminSummary.points.pointC.earned, rows: sumC });
      check(`${tag} 불변식 total == success + fail`, adminSummary.total === adminSummary.success + adminSummary.fail, adminSummary);
      const expRate = adminSummary.total > 0 ? Math.round((adminSummary.success / adminSummary.total) * 100) : 0;
      check(`${tag} 활동 완료율 산식`, adminSummary.rate === expRate, { rate: adminSummary.rate, expRate });

      // (4) operating / mode=test / demoUserId 동일 요약
      const t = await fetchAdminActs(cookie, uid, card.weekId!, "?mode=test");
      if (t.status === 200 && t.data) {
        check(`${tag} operating == mode=test 요약`, JSON.stringify(t.data.summary) === JSON.stringify(adminSummary), {
          test: t.data.summary,
          op: adminSummary,
        });
      }
      if (testIds.has(uid)) {
        const d = await fetchAdminActs(cookie, uid, card.weekId!, `?demoUserId=${uid}`);
        if (d.status === 200 && d.data) {
          check(`${tag} operating == demoUserId 요약`, JSON.stringify(d.data.summary) === JSON.stringify(adminSummary), {
            demo: d.data.summary,
            op: adminSummary,
          });
        }
      }
    }
  }

  console.log(`\n═══ 결과: PASS ${passed} · FAIL ${failed} ═══`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
