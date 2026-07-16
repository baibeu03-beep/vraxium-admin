// 검증(READ-ONLY): 우회 경로가 이제 호출하는 "공통 정합 함수"가 현재 원장/판정과 이미 일치하는지 확인.
//   → 일치(델타 0)면, 우회 문(target CRUD·검수완료·경험개설)이 그 함수를 호출해도 정본과 동일 결과.
//
// 1) reconcileLineAwardsForWeek(dryRun=true): 최근 공표 주차 전원의 라인 A/B 지급을 카드 enhancementStatus
//    SoT 로 재도출했을 때 paid/revoked 델타. 0 = 원장이 이미 정본. (우회 reconcile 시 무변화 보장)
// 2) predictWeekStatusForUser vs 저장 uws: 표본(공표 주차 코호트) 재판정 불일치. 0 = uws 정합.
// ⚠ 아무 것도 쓰지 않는다. resyncGradeStatsBatch(실유저 grade write)를 트리거하지 않는다(R3 분리 준수).
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { reconcileLineAwardsForWeek } from "@/lib/lineResultAwardReconcile";
import { predictWeekStatusForUser } from "@/lib/crewWeekGrowthRejudge";
import { isOrganizationSlug, type OrganizationSlug } from "@/lib/organizations";

const now = Date.now();

async function main() {
  console.log("\n═══ 우회 경로 수렴 검증 (READ-ONLY · dryRun) ═══\n");

  // 최근 공표된 주차(라인 결과 확정 대상).
  const { data: weeks } = await supabaseAdmin
    .from("weeks")
    .select("id,start_date,result_published_at")
    .not("result_published_at", "is", null)
    .order("start_date", { ascending: false })
    .limit(20);
  const wk = ((weeks ?? []) as Array<{ id: string; start_date: string | null; result_published_at: string | null }>)
    .filter((w) => w.start_date);
  console.log(`대상 공표 주차: ${wk.length}\n`);

  // ── 1) 라인 A/B 지급 정합 dryRun ──────────────────────────────────────
  const POLICY_FROM = "2026-06-01"; // 라인 A/B 성공지급 정책/시스템 도입 경계(추정) — 이후=현행 운영.
  let totalPaid = 0;
  let totalRevoked = 0;
  let totalLines = 0;
  let recentPaid = 0;
  let recentRevoked = 0;
  const perWeek: Array<{ week: string; lines: number; paid: number; revoked: number }> = [];
  for (const w of wk) {
    const r = await reconcileLineAwardsForWeek({
      weekId: w.id,
      weekStartDate: w.start_date as string,
      actor: null,
      dryRun: true,
    });
    totalPaid += r.paid;
    totalRevoked += r.revoked;
    totalLines += r.reconciledLines;
    const start = w.start_date as string;
    if (start >= POLICY_FROM) {
      recentPaid += r.paid;
      recentRevoked += r.revoked;
    }
    perWeek.push({ week: start, lines: r.reconciledLines, paid: r.paid, revoked: r.revoked });
  }
  perWeek.sort((a, b) => (a.week < b.week ? 1 : -1)); // 최근 먼저
  console.log("① 라인 A/B 지급 정합 (dryRun) — 카드 SoT vs 원장 (주차별, 최근 먼저)");
  console.log(`   검사한 (user,line) reconcile: ${totalLines}`);
  for (const p of perWeek) {
    const mark = p.week >= POLICY_FROM ? "  [현행]" : "";
    console.log(`     ${p.week}${mark}  lines=${p.lines} paid=${p.paid} revoked=${p.revoked}`);
  }
  console.log(`\n   ▶ 현행(>=${POLICY_FROM}) 델타: paid=${recentPaid} revoked=${recentRevoked}  ← 우회 수정 영향권(0 이어야 안전)`);
  console.log(`   ▶ 역사(<${POLICY_FROM}) 델타: paid=${totalPaid - recentPaid} revoked=${totalRevoked - recentRevoked}  ← 정책 도입 前 · 별도 백필 판단(범위 밖)`);
  console.log(`   ※ paid 카운터는 config(a/b>0) 확인 前 증가 → 과대집계. 실지급은 config 있는 라인만.`);

  // ── 2) uws vs predict 표본(공표 주차 코호트) ─────────────────────────
  console.log("\n② uws.status vs predict — 공표 주차 코호트 표본");
  const { data: profs } = await supabaseAdmin.from("user_profiles").select("user_id, organization_slug");
  const orgByUser = new Map<string, OrganizationSlug | null>();
  for (const p of (profs ?? []) as Array<{ user_id: string; organization_slug: string | null }>)
    orgByUser.set(p.user_id, p.organization_slug && isOrganizationSlug(p.organization_slug) ? (p.organization_slug as OrganizationSlug) : null);

  let checked = 0;
  let mism = 0;
  const samples: string[] = [];
  for (const w of wk.slice(0, 6)) {
    const { data: uws } = await supabaseAdmin
      .from("user_week_statuses")
      .select("user_id,status")
      .eq("week_start_date", w.start_date as string)
      .in("status", ["success", "fail"]);
    for (const row of (uws ?? []) as Array<{ user_id: string; status: string }>) {
      checked++;
      const pred = await predictWeekStatusForUser({
        userId: row.user_id,
        weekId: w.id,
        organizationSlug: orgByUser.get(row.user_id) ?? null,
        now,
      });
      if (pred.skipped || !pred.targetStatus) continue;
      if (pred.targetStatus !== row.status) {
        mism++;
        if (samples.length < 10)
          samples.push(`     ${row.user_id.slice(0, 8)}  ${w.start_date}  uws=${row.status}→predict=${pred.targetStatus}`);
      }
    }
  }
  console.log(`   검사: ${checked} · 불일치: ${mism}`);
  if (samples.length) console.log(samples.join("\n"));
  else console.log("   ✅ 표본 불일치 0 — uws 가 판정기와 정합.");

  console.log("\n═══ 결론 ═══");
  const currentSafe = recentPaid + recentRevoked === 0 && mism === 0;
  console.log(
    currentSafe
      ? "✅ 현행 주차: 원장·uws 가 정본 함수 결과와 일치 → 우회 경로가 동일 함수를 호출해도 정본과 동일 결과(무변화). 안전."
      : "⚠ 현행 주차에 델타 존재 — 우회/정본 재계산 시 값이 바뀔 대상. 확인 필요.",
  );
  const histPaid = totalPaid - recentPaid;
  if (histPaid > 0)
    console.log(
      `※ 역사(정책 前) success-무award ${histPaid}건(과대집계) — 우회/정본 어느 문이든 그 주차를 재계산하면 config 있는 라인만 소급 지급됨. 별도 백필 정책 판단 대상(이번 범위 밖).`,
    );
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
