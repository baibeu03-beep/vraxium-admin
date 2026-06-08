// 2026-06-05 "시즌 중 졸업"(시즌 카드 상태 5종째) A 작업 HTTP 검증.
//   1) 졸업자: graduated 시즌 정확히 1개 = "시즌 중 졸업" (진행 중 시즌 포함)
//   2) 종료 시즌에서도 "시즌 중 졸업" 유지 (endDate < today 케이스)
//   3) 회귀: graduating/active 유저 = "시즌 진행 중", 종료 시즌 성공/중단/휴식 라벨 불변
//   4) demoUserId 부착/미부착 응답 동일 (front weekly-growth 는 userId 만 사용)
//   5) direct(SoT=admin resume "정상 졸업" 시즌) vs HTTP(front weekly-growth) 1:1 일치
// 기본 대상 = 로컬(front:3001 / admin:3000, 변경이 미배포이므로). 운영 검증 시:
//   DIAG_FRONT_BASE=https://vraxium.vercel.app DIAG_ADMIN_BASE=https://vraxium-admin.vercel.app
// Usage: node scripts/verify-season-mid-graduation-http.mjs
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = readFileSync(resolve(__dirname, "..", ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const internalKey = get("INTERNAL_API_KEY");
const supabase = createClient(get("NEXT_PUBLIC_SUPABASE_URL"), get("SUPABASE_SERVICE_ROLE_KEY"));

const FRONT_BASE = process.env.DIAG_FRONT_BASE ?? "http://localhost:3001";
const ADMIN_BASE = process.env.DIAG_ADMIN_BASE ?? "http://localhost:3000";

// 고정 케이스 (verify-status-fixes-http.mjs 와 동일 유저 — 단 B 섹션 기대값은
// 본 정책으로 대체: graduated 진행 시즌 = "시즌 진행 중" → "시즌 중 졸업").
const HONG = "e6574586-6279-41cc-ae36-1c9dc3078bc3"; // T홍지환 graduated
const AHN = "ff6adaf8-8993-4b5b-b5ea-a4fa1036cdee"; // T안건우 graduating
const REAL = "247021bc-374b-48f4-8d49-b181d149ee33"; // 이유나 active 실유저

const LABELS = new Set(["시즌 진행 중", "시즌 성공", "시즌 중단", "시즌 휴식", "시즌 중 졸업"]);
const today = new Date().toISOString().slice(0, 10);

let pass = 0, fail = 0;
const check = (label, ok, detail) => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  ok ? pass++ : fail++;
};

// front weekly-growth — 로컬 dev 는 trailingSlash 308 이므로 경로 끝에 / 필수.
const fetchGrowth = async (uid, extraQS = "") => {
  const r = await fetch(`${FRONT_BASE}/api/cluster4/weekly-growth/?userId=${uid}${extraQS}`);
  const j = await r.json().catch(() => null);
  return { status: r.status, sums: j?.data?.seasonSummaries ?? [], cur: j?.data?.seasonSummary ?? null };
};
const fetchResume = async (uid) => {
  const r = await fetch(`${ADMIN_BASE}/api/cluster1/resume?userId=${uid}`, {
    headers: { "x-internal-api-key": internalKey },
  });
  const j = await r.json().catch(() => null);
  return j?.data?.seasonRecords ?? [];
};
const SEASON_NAME_TO_TYPE = { 봄: "spring", 여름: "summer", 가을: "autumn", 겨울: "winter" };
const resumeGradKeys = (recs) =>
  recs
    .filter((x) => x.progressStatus === "정상 졸업")
    .map((x) => `20${x.year}-${SEASON_NAME_TO_TYPE[String(x.seasonName ?? "").replace(/\s*시즌\s*$/, "").trim()]}`);

console.log(`FRONT=${FRONT_BASE} ADMIN=${ADMIN_BASE} today=${today}\n`);

// ── 1+2+5) 졸업자 전수: DB 스캔 → graduated 시즌 1개 = 시즌 중 졸업 = 이력서 정상 졸업 시즌 ──
console.log("=== 1·2·5) growth_status=graduated 전수 (시즌 중 졸업 + 이력서 SoT 1:1) ===");
const { data: grads, error: gradErr } = await supabase
  .from("user_profiles")
  .select("user_id, display_name, growth_status")
  .eq("growth_status", "graduated");
if (gradErr) {
  check("graduated 유저 DB 스캔", false, gradErr.message);
} else {
  console.log(`  graduated 유저 ${grads.length}명`);
  let endedGradSeen = 0;
  for (const g of grads) {
    const { sums } = await fetchGrowth(g.user_id);
    if (sums.length === 0) {
      console.log(`    (참고) ${g.display_name}: seasonSummaries 0개 — 활동 행 없음, 스킵`);
      continue;
    }
    const gradSeasons = sums.filter((s) => s.seasonResult === "graduated");
    check(
      `${g.display_name}: graduated 시즌 정확히 1개`,
      gradSeasons.length === 1,
      `실제=${gradSeasons.length} [${gradSeasons.map((s) => s.seasonKey).join(",")}]`,
    );
    if (gradSeasons.length === 1) {
      const s = gradSeasons[0];
      check(`${g.display_name}: ${s.seasonKey} 라벨="시즌 중 졸업"`, s.statusLabel === "시즌 중 졸업", `실제=${s.statusLabel}`);
      // 5) direct SoT 비교 — 이력서 "정상 졸업" 시즌과 1:1
      const gradKeys = resumeGradKeys(await fetchResume(g.user_id));
      check(
        `${g.display_name}: 이력서 정상 졸업 시즌과 일치`,
        gradKeys.length === 1 && gradKeys[0] === s.seasonKey,
        `이력서=[${gradKeys.join(",")}] vs HTTP=${s.seasonKey}`,
      );
      // 2) 종료 시즌 유지 케이스
      if (s.endDate && today > s.endDate) {
        endedGradSeen++;
        check(`${g.display_name}: 종료 시즌(${s.seasonKey}, end=${s.endDate})에서도 유지`, true);
      }
    }
    // 라벨 5종 외 신규/깨진 라벨 없음
    const badLabels = sums.filter((s) => !LABELS.has(s.statusLabel));
    check(`${g.display_name}: 전 시즌 라벨 5종 내`, badLabels.length === 0, badLabels.map((s) => `${s.seasonKey}=${s.statusLabel}`).join(","));
  }
  if (endedGradSeen === 0) {
    console.log("  (참고) 종료 시즌 졸업 케이스 0건 — 전 졸업자의 graduated 시즌이 진행 중. 검증2는 판정식(status 무관 seasonResult 우선)으로 보장.");
  }
}

// ── 3) 회귀: 비졸업 유저 라벨 불변 ──
console.log("\n=== 3) 회귀 — graduating/active/휴식/중단 라벨 불변 ===");
{
  const { sums: ahn } = await fetchGrowth(AHN);
  const a26s = ahn.find((s) => s.seasonKey === "2026-spring");
  const a25a = ahn.find((s) => s.seasonKey === "2025-autumn");
  const a26w = ahn.find((s) => s.seasonKey === "2026-winter");
  check("T안건우(graduating) 2026-spring=시즌 진행 중", a26s?.statusLabel === "시즌 진행 중", `실제=${a26s?.statusLabel}`);
  check("T안건우 2025-autumn=시즌 중단(이력서 활동 중단)", a25a?.statusLabel === "시즌 중단", `실제=${a25a?.statusLabel}`);
  check("T안건우 2026-winter=시즌 성공(이력서 정상 완료)", a26w?.statusLabel === "시즌 성공", `실제=${a26w?.statusLabel}`);
  check("T안건우 graduated 시즌 0개", ahn.every((s) => s.seasonResult !== "graduated"));

  const { sums: real, cur: realCur } = await fetchGrowth(REAL);
  const r26s = real.find((s) => s.seasonKey === "2026-spring");
  check("이유나(active) 2026-spring=시즌 진행 중", r26s?.statusLabel === "시즌 진행 중", `실제=${r26s?.statusLabel}`);
  check("이유나 현재 시즌 단일 요약=시즌 진행 중", realCur?.statusLabel === "시즌 진행 중", `실제=${realCur?.statusLabel}`);

  // 시즌 휴식 회귀 — personal_rest 보유 유저 샘플에서 "시즌 휴식" 라벨 경로 생존 확인
  const { data: restUsers } = await supabase
    .from("user_week_statuses")
    .select("user_id")
    .eq("status", "personal_rest")
    .limit(20);
  const restIds = [...new Set((restUsers ?? []).map((r) => r.user_id))].slice(0, 3);
  let restLabelSeen = false;
  for (const uid of restIds) {
    const { sums } = await fetchGrowth(uid);
    if (sums.some((s) => s.statusLabel === "시즌 휴식")) { restLabelSeen = true; break; }
  }
  check("시즌 휴식 라벨 경로 생존(샘플)", restLabelSeen || restIds.length === 0, restLabelSeen ? "" : `샘플 ${restIds.length}명에서 미발견(통합 휴식 시즌 부재 가능 — 참고)`);
}

// ── 4) demoUserId 부착/미부착 동일 ──
console.log("\n=== 4) demoUserId / 일반 모드 동일 ===");
{
  const plain = await fetchGrowth(HONG);
  const demo = await fetchGrowth(HONG, `&demoUserId=${HONG}`);
  check(
    "T홍지환 seasonSummaries plain==demo",
    JSON.stringify(plain.sums) === JSON.stringify(demo.sums),
    `plain=${plain.sums.length}개 demo=${demo.sums.length}개`,
  );
  check(
    "T홍지환 단일 요약 plain==demo",
    JSON.stringify(plain.cur) === JSON.stringify(demo.cur),
  );
}

console.log(`\n결과: pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
