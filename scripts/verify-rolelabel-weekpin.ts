/**
 * 카드 roleLabel(역할/등급 배지) 주차 핀(week-pinned) 검증 — READ-ONLY.
 *
 * 명제: 한 사용자의 단계(position_code)가 주차에 따라 바뀌면, 그 사용자의 snapshot 카드
 *   roleLabel 도 주차별로 달라야 한다(= user_position_histories 주차단위 SoT). 그리고 과거 주차
 *   카드의 roleLabel 이 "현재 membership_level"과 (바뀐 경우) 달라야 한다(최신값으로 덮이지 않음).
 *
 *   실행: npx tsx --env-file=.env.local scripts/verify-rolelabel-weekpin.ts [USER_ID]
 */
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { readWeeklyCardsSnapshot, WEEKLY_CARDS_DTO_VERSION } from "@/lib/cluster4WeeklyCardsSnapshot";
import { POSITION_CODE_TO_LABEL, type PositionCode } from "@/lib/positionHistory";

type PosRow = { user_id: string; season_key: string | null; week_start_date: string | null; position_code: PositionCode };

async function findStageChangeUser(): Promise<string | null> {
  // position_code 가 2종 이상인 사용자(주차별 단계 변화 보유자)를 찾는다.
  const { data, error } = await supabaseAdmin
    .from("user_position_histories")
    .select("user_id,position_code")
    .limit(20000);
  if (error || !data) { console.warn("position scan 실패", error?.message); return null; }
  const byUser = new Map<string, Set<string>>();
  for (const r of data as { user_id: string; position_code: string }[]) {
    const s = byUser.get(r.user_id) ?? new Set<string>();
    s.add(r.position_code);
    byUser.set(r.user_id, s);
  }
  // 테스트 계정 제외(운영 기준).
  const { data: markers } = await supabaseAdmin.from("test_user_markers").select("user_id");
  const testSet = new Set((markers ?? []).map((m: { user_id: string }) => m.user_id));
  for (const [uid, set] of byUser) {
    if (set.size >= 2 && !testSet.has(uid)) return uid;
  }
  // 운영 계정에 없으면 테스트 포함이라도 1명.
  for (const [uid, set] of byUser) if (set.size >= 2) return uid;
  return null;
}

async function main() {
  const userId = (process.argv[2] ?? "").trim() || (await findStageChangeUser());
  if (!userId) { console.log("단계 변화 보유 사용자를 찾지 못함."); return; }

  console.log(`\n════════ roleLabel 주차 핀 검증 (user=${userId}, DTO v${WEEKLY_CARDS_DTO_VERSION}) ════════`);

  // 1) 현재 membership_level (최신값)
  const { data: mem } = await supabaseAdmin
    .from("user_memberships")
    .select("membership_level,is_current,updated_at")
    .eq("user_id", userId);
  const curLevel = (mem ?? [])
    .slice()
    .sort((a: any, b: any) => (Boolean(b.is_current) ? 1 : 0) - (Boolean(a.is_current) ? 1 : 0))[0]?.membership_level ?? null;
  console.log(`현재 membership_level(최신) : ${curLevel ?? "(없음)"}`);

  // 2) 주차별 position 이력(SoT)
  const { data: posData } = await supabaseAdmin
    .from("user_position_histories")
    .select("user_id,season_key,week_start_date,position_code")
    .eq("user_id", userId)
    .order("week_start_date", { ascending: true });
  const posByStart = new Map<string, string>();
  for (const r of (posData ?? []) as PosRow[]) {
    if (r.week_start_date) posByStart.set(r.week_start_date, POSITION_CODE_TO_LABEL[r.position_code]);
  }
  console.log(`position 이력 주차 수       : ${posByStart.size}`);

  // 3) snapshot 카드의 주차별 roleLabel
  const snap = await readWeeklyCardsSnapshot(userId);
  if (snap.status !== "hit" && snap.status !== "stale") {
    console.log(`snapshot 상태=${snap.status} — 카드 없음. 종료.`); return;
  }
  const cards = snap.cards;
  console.log(`snapshot 상태=${snap.status}, 카드 수=${cards.length}\n`);

  const rows: any[] = [];
  let weekPinnedMatches = 0;
  let pinnedComparable = 0;
  const distinctCardLabels = new Set<string>();
  for (const c of cards) {
    const start = c.startDate;
    const pos = start ? posByStart.get(start) ?? null : null;
    const cardLabel = c.roleLabel ?? null;
    if (cardLabel) distinctCardLabels.add(cardLabel);
    if (pos) {
      pinnedComparable++;
      if (pos === cardLabel) weekPinnedMatches++;
    }
    rows.push({
      week: c.weekLabel,
      start: start,
      season: c.seasonKey,
      "PMS position(SoT)": pos ?? "—",
      "card roleLabel": cardLabel ?? "—",
      "pinned==card": pos ? (pos === cardLabel ? "✅" : "❌") : "—(gap/현재폴백)",
    });
  }
  console.table(rows.slice(0, 60));

  console.log("──────── 판정 ────────");
  console.log(`주차 1:1 매칭(PMS 행 존재 주차) : ${weekPinnedMatches}/${pinnedComparable}`);
  console.log(`카드 roleLabel 의 distinct 값 수 : ${distinctCardLabels.size} {${[...distinctCardLabels].join(", ")}}`);
  console.log(
    distinctCardLabels.size >= 2
      ? "  ✅ 카드 roleLabel 이 주차/시즌별로 분화됨 — 단일 최신값으로 덮이지 않음(week-pinned 작동)."
      : "  ⚠ 카드 roleLabel 이 단일값 — 이 사용자는 표시상 단계 변화가 없거나 gap 시즌 폴백.",
  );
  console.log("\n[done] READ-ONLY. DB 변경 없음.\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
