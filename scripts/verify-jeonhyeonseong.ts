/**
 * 검증(read-only): 전현성 단독 이관 결과.
 *   npx tsx --env-file=.env.local scripts/verify-jeonhyeonseong.ts
 */
import { readFileSync, readdirSync } from "fs";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getSeasonParticipations } from "@/lib/adminSeasonParticipationsData";
import { getCluster4WeeklyCardsForProfileUser } from "@/lib/cluster4WeeklyCardsData";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";

const line = (s = "") => console.log(s);
const hr = () => line("─".repeat(72));
let fail = 0;
const ck = (l: string, ok: boolean, d = "") => { line(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };

const applyFile = readdirSync("claudedocs").filter((f) => f.startsWith("jeonhyeonseong-migration-apply-")).sort().reverse()[0];
const LOG = JSON.parse(readFileSync(`claudedocs/${applyFile}`, "utf8"));
const UUID = LOG.applied?.uuid ?? LOG.target?.uuid;

async function main() {
  line(`적용 로그: ${applyFile}  uuid=${UUID}`);
  hr(); line("1. user_profiles 생성"); hr();
  const { data: prof } = await supabaseAdmin.from("user_profiles").select("*").eq("user_id", UUID).maybeSingle();
  const p = prof as any;
  ck("프로필 존재", !!p);
  ck("display_name=전현성", p?.display_name === "전현성", p?.display_name);
  ck("organization_slug=oranke", p?.organization_slug === "oranke", p?.organization_slug);
  ck("status=active", p?.status === "active", p?.status);
  ck("growth_status=active (seasonal_rest 아님)", p?.growth_status === "active", p?.growth_status);
  ck("birth_date=2004-10-01", p?.birth_date === "2004-10-01", p?.birth_date);
  ck("school 인천대 / team 커머스 / part 센스", p?.school_name === "인천대" && p?.current_team_name === "커머스" && p?.current_part_name === "센스", `${p?.school_name}/${p?.current_team_name}/${p?.current_part_name}`);
  const { data: mem } = await supabaseAdmin.from("user_memberships").select("team_name,part_name,membership_level").eq("user_id", UUID).maybeSingle();
  const { data: edu } = await supabaseAdmin.from("user_educations").select("school_name,major_name_1").eq("user_id", UUID).maybeSingle();
  ck("membership 생성", !!mem, JSON.stringify(mem));
  ck("education 생성(인천대/스포츠과학부)", (edu as any)?.school_name === "인천대", JSON.stringify(edu));
  const { data: usrc } = await supabaseAdmin.from("users").select("source_system,legacy_user_id").eq("id", UUID).maybeSingle();
  ck("users (oranke,1051) 페어", (usrc as any)?.source_system === "oranke" && (usrc as any)?.legacy_user_id === 1051, JSON.stringify(usrc));

  hr(); line("2. 과거 이력 이관 수 + 잔액"); hr();
  const { count: ledgerPointlog } = await supabaseAdmin.from("legacy_point_ledger").select("id", { count: "exact", head: true }).eq("user_id", UUID).in("entry_type", ["POINTLOG", "POINTLOG_VOIDED"]);
  const { count: ledgerAll } = await supabaseAdmin.from("legacy_point_ledger").select("id", { count: "exact", head: true }).eq("user_id", UUID);
  ck("ledger POINTLOG 375건", ledgerPointlog === 375, `${ledgerPointlog}`);
  ck("ledger 전체 376건(+조정1)", ledgerAll === 376, `${ledgerAll}`);
  const { count: uwsCnt } = await supabaseAdmin.from("user_week_statuses").select("id", { count: "exact", head: true }).eq("user_id", UUID);
  const { count: expCnt } = await supabaseAdmin.from("cluster4_line_submissions").select("id", { count: "exact", head: true }).eq("user_id", UUID);
  ck("uws 16주", uwsCnt === 16, `${uwsCnt}`);
  ck("경험 submission 16건", expCnt === 16, `${expCnt}`);
  // 잔액 항등: Σ uwp points + sentinel == PMS Star 838 / Σ(adv-pen) == Shield 40
  const { data: uwp } = await supabaseAdmin.from("user_weekly_points").select("points,advantages,penalty").eq("user_id", UUID);
  const sumStar = (uwp ?? []).reduce((s: number, r: any) => s + (r.points ?? 0), 0);
  const sumShield = (uwp ?? []).reduce((s: number, r: any) => s + (r.advantages ?? 0) - (r.penalty ?? 0), 0);
  ck("잔액 Star = 838 (uwp points 합, sentinel 포함)", sumStar === 838, `${sumStar}`);
  ck("잔액 Shield = 40 (uwp adv-pen 합)", sumShield === 40, `${sumShield}`);
  // useractivities/manageractivities 원천 16+13=29 → 인정주차 16 (중복주차 dedupe·미인정 fail 포함). 원천 수는 dryrun 보고값.
  line(`  (원천 useractivities=16 manageractivities=13 → 주차 dedupe 후 uws/경험 16. dryrun 보고 일치)`);

  hr(); line("3. user_season_statuses(2026-summer, rest) + 소급 없음"); hr();
  const { data: ss } = await supabaseAdmin.from("user_season_statuses").select("season_key,status").eq("user_id", UUID);
  const ssArr = (ss ?? []) as any[];
  line(`  season_statuses: ${ssArr.map((r) => `${r.season_key}:${r.status}`).join(", ") || "(없음)"}`);
  ck("2026-summer rest 1건", ssArr.filter((r) => r.season_key === "2026-summer" && r.status === "rest").length === 1);
  ck("여름 외 다른 시즌 rest 없음(소급 없음)", !ssArr.some((r) => r.season_key !== "2026-summer" && r.status === "rest"));
  // 과거 활동주차는 2025만(소급 없음 — 여름 휴식이 과거 시즌으로 안 번짐)
  const { data: uwsSeasons } = await supabaseAdmin.from("user_week_statuses").select("season_key").eq("user_id", UUID);
  const seasonsSet = new Set((uwsSeasons ?? []).map((r: any) => r.season_key));
  ck("과거 활동주차에 2026-summer 없음(휴식≠활동)", !seasonsSet.has("2026-summer"), [...seasonsSet].join(","));

  hr(); line("4. snapshot 영향/재계산 + demo==일반 DTO"); hr();
  const { data: snap } = await supabaseAdmin.from("cluster4_weekly_card_snapshots").select("card_count,is_stale,computed_at").eq("user_id", UUID).maybeSingle();
  ck("전현성 snapshot 생성됨", !!snap, JSON.stringify(snap));
  ck("snapshot is_stale=false", snap && (snap as any).is_stale === false);
  const live = await getCluster4WeeklyCardsForProfileUser(UUID);
  const snapRead = await readWeeklyCardsSnapshot(UUID);
  if (snapRead.status === "hit" || snapRead.status === "stale") ck(`snapshot-only 카드수 == live(${snapRead.cards.length} vs ${live.length})`, snapRead.cards.length === live.length);
  ck("snapshot card_count == live", snap && (snap as any).card_count === live.length, `${(snap as any)?.card_count} vs ${live.length}`);
  const summerCards = (live as any[]).filter((c) => c.seasonKey === "2026-summer" || (typeof c.startDate === "string" && c.startDate >= "2026-06-29"));
  ck("오늘 live 카드에 2026-summer 카드 없음(여름 미시작·게이팅)", summerCards.length === 0, `${summerCards.length}`);
  line(`  (demo 모드 = 조회 userId override only, 동일 getCluster4WeeklyCardsForProfileUser/readWeeklyCardsSnapshot 경로 — DTO 분기 없음)`);

  hr(); line("5. season-participations direct = 50"); hr();
  const dto = await getSeasonParticipations({ seasonKey: "2026-summer", status: "rest", organizationSlug: null, search: null });
  const perOrg: Record<string, number> = {};
  for (const r of dto.rows) perOrg[r.organization_slug ?? "(null)"] = (perOrg[r.organization_slug ?? "(null)"] ?? 0) + 1;
  ck("direct 50행", dto.rows.length === 50, `${dto.rows.length} perOrg=${JSON.stringify(perOrg)}`);
  ck("전현성 포함", dto.rows.some((r) => r.user_id === UUID));

  hr();
  line(fail === 0 ? "✅ 전현성 검증 ALL PASS" : `❌ ${fail} FAILED`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
