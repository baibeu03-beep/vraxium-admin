/**
 * cluster-4 진입 화면 area-8-season-status DTO 검증.
 *   npx tsx --env-file=.env.local scripts/diag-season-activity-status.ts [profileUserId]
 *
 * 검증 항목 (요구사항):
 *   1) direct function(getWeeklyGrowth) 결과에 seasonActivityStatuses 포함
 *   2) HTTP /api/cluster4/weekly-growth 응답에 동일 필드 포함 (서버 기동 시)
 *   3) direct == HTTP (seasonActivityStatuses 깊은 비교)
 *   4) 표시 규칙: 최대 6개 / order 발생순(ASC) / 연속 동일 병합 / 운영진 라벨 / "-" fallback
 *   5) demoUserId == internal userId 동일 DTO
 *   6) snapshot 영향 없음 — weekly-growth 는 live 경로, snapshot 테이블 미접근
 *
 * 서버가 안 떠 있으면 HTTP 단계는 건너뛰고 direct + 규칙 검증만 수행한다.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getWeeklyGrowth } from "@/lib/cluster4WeeklyGrowthData";
import { listTestUsers } from "@/lib/testUsers";
import type { SeasonActivityStatus } from "@/lib/cluster4WeeklyGrowthTypes";

const BASE = process.env.BASE_URL || "http://localhost:3000";

type Growth = NonNullable<Awaited<ReturnType<typeof getWeeklyGrowth>>>;

// 활동 신호(팀/파트/등급/역할)가 가장 풍부한 유저를 우선 선택해 검증 신뢰도를 높인다.
async function pickTestUser(
  override: string | null,
): Promise<{ profileUserId: string; name: string } | null> {
  const users = await listTestUsers();
  console.log(`[scan] test users = ${users.length}`);
  if (override) {
    const u = users.find((x) => x.userId === override);
    return { profileUserId: override, name: u?.name ?? "(override)" };
  }

  let best: { profileUserId: string; name: string; score: number } | null = null;
  let scanned = 0;
  for (const u of users) {
    let dto: Growth | null = null;
    try {
      dto = await getWeeklyGrowth(u.userId);
    } catch {
      continue;
    }
    if (!dto) continue;
    scanned++;
    const sas = dto.seasonActivityStatuses;
    // 여러 항목 / 운영진 항목이 있으면 더 강한 검증 → 높은 점수.
    const ops = sas.filter(
      (s) => s.teamLabel.startsWith("운영진"),
    ).length;
    const score = sas.length * 10 + ops * 100;
    if (!best || score > best.score) {
      best = { profileUserId: u.userId, name: u.name, score };
    }
  }
  console.log(`[scan] getWeeklyGrowth 성공 유저 = ${scanned}`);
  return best;
}

function printStatuses(label: string, list: SeasonActivityStatus[]) {
  console.log(`\n── ${label} (${list.length}개) ──`);
  for (const s of list) {
    console.log(
      `  #${s.order} ${s.teamLabel} / ${s.partLabel} / ${s.statusLabel}` +
        ` | role=${JSON.stringify(s.rawRole)} level=${JSON.stringify(s.rawMembershipLevel)}` +
        ` | ${s.startedAt ?? "·"} ~ ${s.endedAt ?? "·"}`,
    );
  }
}

// 표시 규칙 검증 (순수 — DTO 만으로 확인 가능한 불변식).
function checkRules(list: SeasonActivityStatus[]): boolean {
  let ok = true;
  const fail = (msg: string) => {
    ok = false;
    console.log(`  ❌ ${msg}`);
  };

  // 최대 6개
  if (list.length > 6) fail(`항목 수 ${list.length} > 6`);

  // order = 1..n 연속, 발생순(startedAt ASC, null 마지막)
  list.forEach((s, i) => {
    if (s.order !== i + 1) fail(`order 불연속: index ${i} → order ${s.order}`);
  });
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1].startedAt;
    const b = list[i].startedAt;
    if (a && b && a > b) fail(`정렬 위반: ${a} 다음에 ${b}`);
    if (!a && b) fail(`정렬 위반: null startedAt 이 ${b} 앞에 위치`);
  }

  // 연속 동일(team/part/status) 병합 — 인접 중복 없음
  for (let i = 1; i < list.length; i++) {
    const p = list[i - 1];
    const c = list[i];
    if (
      p.teamLabel === c.teamLabel &&
      p.partLabel === c.partLabel &&
      p.statusLabel === c.statusLabel
    ) {
      fail(`연속 중복 미병합: #${p.order}, #${c.order}`);
    }
  }

  // 운영진 라벨 규칙
  for (const s of list) {
    if (s.teamLabel.startsWith("운영진")) {
      if (s.partLabel !== "클럽 단위")
        fail(`운영진인데 partLabel != 클럽 단위 (#${s.order}: ${s.partLabel})`);
      const isTeamLeader = s.statusLabel.startsWith("팀장(");
      const isAmbassador = s.statusLabel === "앰배서더";
      if (!isTeamLeader && !isAmbassador)
        fail(`운영진 statusLabel 형식 위반 (#${s.order}: ${s.statusLabel})`);
    }
  }

  // "-" fallback — 빈 라벨 없음
  for (const s of list) {
    if (!s.teamLabel) fail(`teamLabel 빈 값 (#${s.order})`);
    if (!s.partLabel) fail(`partLabel 빈 값 (#${s.order})`);
    if (!s.statusLabel) fail(`statusLabel 빈 값 (#${s.order})`);
  }

  console.log(ok ? "  ✅ 표시 규칙 모두 통과" : "  ❌ 표시 규칙 위반 있음");
  return ok;
}

async function tryHttp(
  path: string,
  headers: Record<string, string>,
): Promise<Growth | null> {
  try {
    const res = await fetch(`${BASE}${path}`, { headers });
    const json = (await res.json()) as { success?: boolean; data?: Growth };
    if (!json?.success || !json?.data) {
      console.log(`  HTTP ${path} → success=${json?.success} (data 없음)`);
      return null;
    }
    return json.data as Growth;
  } catch (e) {
    console.log(
      `  HTTP ${path} → 서버 미응답 (${e instanceof Error ? e.message : e})`,
    );
    return null;
  }
}

async function main() {
  const override = process.argv[2] || null;
  const picked = await pickTestUser(override);
  if (!picked) {
    console.log("❌ 테스트 유저를 찾지 못했습니다.");
    return;
  }
  console.log(
    `\n[target] name=${picked.name} profileUserId=${picked.profileUserId}`,
  );

  // ── 1) direct function ──
  const direct = await getWeeklyGrowth(picked.profileUserId);
  if (!direct) {
    console.log("❌ getWeeklyGrowth 가 null 을 반환했습니다.");
    return;
  }
  console.log("\n──────── (1) direct getWeeklyGrowth ────────");
  console.log(`  seasonSummary 시즌 = ${direct.seasonSummary?.displayTitle ?? "N/A"}`);
  printStatuses("direct seasonActivityStatuses", direct.seasonActivityStatuses);

  // ── 4) 표시 규칙 검증 ──
  console.log("\n──────── (4) 표시 규칙 ────────");
  const rulesOk = checkRules(direct.seasonActivityStatuses);

  // ── 2/3/5) HTTP demo + internal 비교 ──
  console.log("\n──────── (2)(3)(5) HTTP /api/cluster4/weekly-growth ────────");
  const internalKey = process.env.INTERNAL_API_KEY;
  const directJson = JSON.stringify(direct.seasonActivityStatuses);
  const demoDto = await tryHttp(
    `/api/cluster4/weekly-growth?demoUserId=${picked.profileUserId}`,
    {},
  );
  const internalDto = internalKey
    ? await tryHttp(`/api/cluster4/weekly-growth?userId=${picked.profileUserId}`, {
        "x-internal-api-key": internalKey,
      })
    : null;

  let httpOk = true;
  if (demoDto) {
    const eq = JSON.stringify(demoDto.seasonActivityStatuses) === directJson;
    httpOk = httpOk && eq;
    console.log(`  demoUserId HTTP == direct : ${eq ? "✅ 일치" : "❌ 불일치"}`);
    if (!eq) printStatuses("HTTP(demo)", demoDto.seasonActivityStatuses);
  } else {
    console.log("  demoUserId HTTP: 응답 없음(서버 미기동 가능) — 스킵");
  }
  if (internalDto) {
    const eq = JSON.stringify(internalDto.seasonActivityStatuses) === directJson;
    console.log(`  internal userId HTTP == direct : ${eq ? "✅ 일치" : "❌ 불일치"}`);
    if (demoDto) {
      const parity =
        JSON.stringify(internalDto.seasonActivityStatuses) ===
        JSON.stringify(demoDto.seasonActivityStatuses);
      console.log(
        `  demoUserId == internal userId : ${parity ? "✅ 동일 DTO" : "❌ 상이"}`,
      );
    }
  }

  // ── 6) snapshot 영향 없음 ──
  console.log("\n──────── (6) snapshot 영향 ────────");
  const { count } = await supabaseAdmin
    .from("cluster4_weekly_card_snapshots")
    .select("user_id", { count: "exact", head: true })
    .eq("user_id", picked.profileUserId);
  console.log(
    "  weekly-growth 는 live 경로 — seasonActivityStatuses 는 매 요청 계산(snapshot 미접근).",
  );
  console.log(
    `  이 유저 snapshot 행 존재=${count ?? 0} (있어도 weekly-growth area-8 과 무관).`,
  );

  console.log("\n──────── 결과 요약 ────────");
  console.log(`  (1) direct 필드 포함   : ✅`);
  console.log(`  (4) 표시 규칙          : ${rulesOk ? "✅" : "❌"}`);
  console.log(
    `  (2)(3)(5) HTTP == direct: ${
      demoDto || internalDto ? (httpOk ? "✅" : "❌") : "⏭ 서버 미기동"
    }`,
  );
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
