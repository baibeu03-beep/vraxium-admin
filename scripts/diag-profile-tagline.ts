/**
 * profileTagline "-" 표시 진단 (READ-ONLY).
 *
 *   npx tsx --env-file=.env.local scripts/diag-profile-tagline.ts
 *
 * profileTagline 은 카드 최상위 필드가 아니라 weeklyReputations[].fromProfile/toProfile,
 * weeklyColleagues[].colleagueProfile (= Cluster4PersonProfileDto) 안에만 존재한다.
 * 화면 "-" 는 그 임베드 프로필의 profileTagline 이 null/누락일 때 프론트 fallback.
 *
 * HTTP GET /api/cluster4/weekly-cards 는 snapshot-only(저장본 그대로) →  snapshot.cards == HTTP.
 * 따라서 ledger → direct(fetchWeeklyPeopleByWeek) → snapshot(=HTTP) 를 서버 없이 비교한다.
 *
 * 검증 항목:
 *   1. user_profiles.profile_tagline 원장 값 (분포 + 표본)
 *   2. DTO direct 결과에 profileTagline 포함 여부 (fetchWeeklyPeopleByWeek)
 *   3. snapshot(=HTTP) 저장본에 profileTagline 포함 여부 (key 존재 + 값)
 *   4. direct vs snapshot(=HTTP) 비교
 *   5. snapshot 영향 (dto_version 분포 / stale)
 *   6. 재계산 필요 여부 판정
 */
import { createClient } from "@supabase/supabase-js";
import { fetchWeeklyPeopleByWeek } from "@/lib/cluster4WeeklyPeopleData";
import { WEEKLY_CARDS_DTO_VERSION } from "@/lib/cluster4WeeklyCardsSnapshot";
import type { Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const TABLE = "cluster4_weekly_card_snapshots";

function short(id: unknown) {
  return String(id ?? "").slice(0, 8);
}

// snapshot 카드 배열 안의 모든 임베드 프로필을 평탄화.
type EmbeddedProfile = {
  via: string; // fromProfile|toProfile|colleagueProfile
  weekId: string;
  userId: string | null;
  hasKey: boolean; // profileTagline 키 자체 존재?
  value: unknown; // profileTagline 값
};
function collectEmbeddedProfiles(cards: Cluster4WeeklyCardDto[]): EmbeddedProfile[] {
  const out: EmbeddedProfile[] = [];
  const push = (via: string, weekId: string, p: unknown) => {
    if (!p || typeof p !== "object") return;
    const rec = p as Record<string, unknown>;
    out.push({
      via,
      weekId,
      userId: (rec.userId as string) ?? null,
      hasKey: Object.prototype.hasOwnProperty.call(rec, "profileTagline"),
      value: rec.profileTagline,
    });
  };
  for (const c of cards ?? []) {
    const wk = String((c as { weekId?: unknown }).weekId ?? "");
    const reps = (c as { weeklyReputations?: unknown[] }).weeklyReputations ?? [];
    for (const r of reps) {
      push("fromProfile", wk, (r as Record<string, unknown>).fromProfile);
      push("toProfile", wk, (r as Record<string, unknown>).toProfile);
    }
    const cols = (c as { weeklyColleagues?: unknown[] }).weeklyColleagues ?? [];
    for (const c2 of cols) {
      push("colleagueProfile", wk, (c2 as Record<string, unknown>).colleagueProfile);
    }
  }
  return out;
}

async function main() {
  // ─────────────────────────────────────────────────────────────
  // 1. 원장 값: user_profiles.profile_tagline 분포 + 표본
  // ─────────────────────────────────────────────────────────────
  console.log("══════════ 1. 원장 user_profiles.profile_tagline ══════════");
  const { data: allProfiles, error: pErr } = await sb
    .from("user_profiles")
    .select("user_id,display_name,profile_tagline");
  if (pErr) {
    console.log("user_profiles 조회 실패:", pErr.message);
    return;
  }
  const profiles = allProfiles ?? [];
  const taglineByUser = new Map<string, string | null>();
  let nonEmpty = 0;
  let emptyString = 0;
  let nullVal = 0;
  for (const p of profiles as { user_id: string; profile_tagline: string | null }[]) {
    taglineByUser.set(p.user_id, p.profile_tagline ?? null);
    const v = p.profile_tagline;
    if (v == null) nullVal++;
    else if (v.trim() === "") emptyString++;
    else nonEmpty++;
  }
  console.log(`총 user_profiles: ${profiles.length}`);
  console.log(`profile_tagline 비어있지않음(값 있음): ${nonEmpty}`);
  console.log(`profile_tagline = "" (빈문자열): ${emptyString}`);
  console.log(`profile_tagline = null: ${nullVal}`);
  const withTagline = (profiles as { user_id: string; display_name: string | null; profile_tagline: string | null }[])
    .filter((p) => p.profile_tagline && p.profile_tagline.trim() !== "");
  console.log(`\n값 있는 표본 (최대 8):`);
  for (const p of withTagline.slice(0, 8)) {
    console.log(`  ${short(p.user_id)} ${p.display_name ?? "?"} → "${p.profile_tagline}"`);
  }
  if (withTagline.length === 0) {
    console.log("  ⚠ profile_tagline 값을 가진 사용자가 0명 — 화면 '-' 는 원장 공백이 원인(정상).");
  }

  // ─────────────────────────────────────────────────────────────
  // 5. snapshot 영향: dto_version 분포 / stale (먼저 스캔해 표본 선정에 활용)
  // ─────────────────────────────────────────────────────────────
  console.log("\n══════════ 5. snapshot dto_version / stale 분포 ══════════");
  const { data: snapMeta, error: sErr } = await sb
    .from(TABLE)
    .select("user_id,dto_version,is_stale,computed_at,card_count");
  if (sErr) {
    console.log("snapshot 메타 조회 실패:", sErr.message);
    return;
  }
  const snaps = (snapMeta ?? []) as {
    user_id: string;
    dto_version: number;
    is_stale: boolean;
    computed_at: string;
    card_count: number;
  }[];
  const byVer: Record<string, number> = {};
  let staleTrue = 0;
  let verMismatch = 0;
  for (const r of snaps) {
    byVer[r.dto_version] = (byVer[r.dto_version] ?? 0) + 1;
    if (r.is_stale) staleTrue++;
    if (r.dto_version !== WEEKLY_CARDS_DTO_VERSION) verMismatch++;
  }
  console.log(`현재 코드 DTO_VERSION = ${WEEKLY_CARDS_DTO_VERSION}`);
  console.log(`총 snapshot 행: ${snaps.length}`);
  console.log(`dto_version 분포: ${JSON.stringify(byVer)}`);
  console.log(`is_stale=true: ${staleTrue}`);
  console.log(`dto_version != ${WEEKLY_CARDS_DTO_VERSION} (version_mismatch → stale graceful): ${verMismatch}`);
  console.log(
    `\n해석: version_mismatch / is_stale 행은 조회 시 '구 카드'를 graceful 노출(계산 안 함).`,
  );
  console.log(
    `      profileTagline 도입(cfd0747) 이전 직렬화 snapshot 이면 임베드 프로필에 키 자체가 없어 '-'.`,
  );

  // ─────────────────────────────────────────────────────────────
  // 3. snapshot(=HTTP) 저장본 임베드 프로필 profileTagline 키/값 스캔
  // ─────────────────────────────────────────────────────────────
  console.log("\n══════════ 3. snapshot(=HTTP) 저장본 profileTagline 키/값 스캔 ══════════");
  // 임베드 프로필이 있는 snapshot 만 의미 있음 → 전수 로드 비용 큼: card_count>0 우선, 최대 N행.
  const SCAN_LIMIT = 80;
  const scanTargets = snaps
    .filter((r) => r.card_count > 0)
    .slice(0, SCAN_LIMIT);
  let snapsWithEmbedded = 0;
  let embeddedTotal = 0;
  let embeddedHasKey = 0;
  let embeddedNonNull = 0;
  // 원장엔 값 있는데 snapshot 엔 키없음/ null → 명백한 stale 증거
  const staleEvidence: string[] = [];
  // 키 없는 snapshot 의 버전 분포
  const missingKeyByVer: Record<string, number> = {};

  for (const r of scanTargets) {
    const { data: row } = await sb
      .from(TABLE)
      .select("cards")
      .eq("user_id", r.user_id)
      .maybeSingle();
    const cards = Array.isArray(row?.cards) ? (row!.cards as Cluster4WeeklyCardDto[]) : [];
    const embedded = collectEmbeddedProfiles(cards);
    if (embedded.length === 0) continue;
    snapsWithEmbedded++;
    for (const e of embedded) {
      embeddedTotal++;
      if (e.hasKey) embeddedHasKey++;
      if (e.value != null && String(e.value).trim() !== "") embeddedNonNull++;
      if (!e.hasKey) {
        missingKeyByVer[r.dto_version] = (missingKeyByVer[r.dto_version] ?? 0) + 1;
      }
      // 교차검증: 이 임베드 인물의 원장 tagline 이 값 있는데 snapshot 이 비었으면 stale 증거
      const ledger = e.userId ? taglineByUser.get(e.userId) : undefined;
      if (
        ledger != null &&
        ledger.trim() !== "" &&
        (e.value == null || String(e.value).trim() === "")
      ) {
        if (staleEvidence.length < 12) {
          staleEvidence.push(
            `owner=${short(r.user_id)} via=${e.via} person=${short(e.userId)} 원장="${ledger}" snapshot=${e.hasKey ? JSON.stringify(e.value) : "<키없음>"} (snapVer=${r.dto_version})`,
          );
        }
      }
    }
  }
  console.log(`스캔한 snapshot(card_count>0, 최대 ${SCAN_LIMIT}): ${scanTargets.length}`);
  console.log(`임베드 프로필 보유 snapshot: ${snapsWithEmbedded}`);
  console.log(`임베드 프로필 총수: ${embeddedTotal}`);
  console.log(`  profileTagline 키 존재: ${embeddedHasKey} / ${embeddedTotal}`);
  console.log(`  profileTagline 값 있음(non-null·non-empty): ${embeddedNonNull} / ${embeddedTotal}`);
  console.log(`  키 없는 임베드 프로필 버전분포: ${JSON.stringify(missingKeyByVer)}`);
  if (staleEvidence.length) {
    console.log(`\n⚠ 원장엔 값 있으나 snapshot 이 비어있는 stale 증거 (${staleEvidence.length}건 표본):`);
    for (const e of staleEvidence) console.log("  " + e);
  } else {
    console.log(`\n원장-snapshot 불일치(원장有·snapshot無) 0건 — 스캔 표본 한정.`);
  }

  // ─────────────────────────────────────────────────────────────
  // 2 & 4. DTO direct 결과 + direct vs snapshot 비교 (결정적 owner 표본)
  // ─────────────────────────────────────────────────────────────
  console.log("\n══════════ 2·4. DTO direct vs snapshot(=HTTP) 비교 ══════════");
  // 임베드 인물 중 원장 tagline 값이 있는 인물이 등장하는 owner 를 우선 선정.
  // weekly_colleagues / weekly_reputations 에서 owner+week 후보를 찾는다.
  const taglineUserIds = new Set(withTagline.map((p) => p.user_id));
  // colleague: 지목된 인물(colleague_id)이 tagline 보유 → 그 카드 owner(user_id) 가 결정적 표본
  const { data: colRows } = await sb
    .from("weekly_colleagues")
    .select("user_id,week_card_id,colleague_id")
    .in("colleague_id", Array.from(taglineUserIds).slice(0, 200))
    .limit(20);
  // reputation: target(=owner)이 tagline 보유 → toProfile 로 등장
  const { data: repRows } = await sb
    .from("weekly_reputations")
    .select("target_user_id,reviewer_id,week_card_id")
    .in("target_user_id", Array.from(taglineUserIds).slice(0, 200))
    .limit(20);

  type Probe = { owner: string; week: string; person: string; via: string };
  const probes: Probe[] = [];
  for (const c of (colRows ?? []) as { user_id: string; week_card_id: string; colleague_id: string }[]) {
    probes.push({ owner: c.user_id, week: c.week_card_id, person: c.colleague_id, via: "colleagueProfile" });
  }
  for (const r of (repRows ?? []) as { target_user_id: string; reviewer_id: string; week_card_id: string }[]) {
    probes.push({ owner: r.target_user_id, week: r.week_card_id, person: r.target_user_id, via: "toProfile" });
  }

  if (probes.length === 0) {
    console.log(
      "결정적 표본 없음: tagline 값 가진 인물이 weekly_colleagues/weekly_reputations 에 등장하지 않음.",
    );
    console.log("→ 원장에 tagline 값이 있는 사용자가 평판/동료 카드에 아직 안 엮인 상태일 수 있음.");
  }

  const seen = new Set<string>();
  let probed = 0;
  for (const pr of probes) {
    if (probed >= 6) break;
    const k = `${pr.owner}|${pr.week}`;
    if (seen.has(k)) continue;
    seen.add(k);
    probed++;

    const ledger = taglineByUser.get(pr.person) ?? null;

    // direct
    let directVal: unknown = "<미도달>";
    let directHasKey = false;
    try {
      const map = await fetchWeeklyPeopleByWeek(pr.owner, [pr.week]);
      const wp = map.get(pr.week);
      let prof: Record<string, unknown> | null | undefined;
      if (pr.via === "colleagueProfile") {
        prof = wp?.weeklyColleagues.find((c) => c.colleagueUserId === pr.person)?.colleagueProfile as
          | Record<string, unknown>
          | null
          | undefined;
      } else {
        prof = wp?.weeklyReputations.find((r) => r.toUserId === pr.person)?.toProfile as
          | Record<string, unknown>
          | null
          | undefined;
      }
      if (prof) {
        directHasKey = Object.prototype.hasOwnProperty.call(prof, "profileTagline");
        directVal = prof.profileTagline;
      } else {
        directVal = "<프로필 null>";
      }
    } catch (e) {
      directVal = `<error ${e instanceof Error ? e.message : String(e)}>`;
    }

    // snapshot(=HTTP)
    let snapVal: unknown = "<행없음>";
    let snapHasKey = false;
    let snapVer: number | string = "?";
    const { data: srow } = await sb
      .from(TABLE)
      .select("cards,dto_version,is_stale")
      .eq("user_id", pr.owner)
      .maybeSingle();
    if (srow) {
      snapVer = (srow as { dto_version: number }).dto_version;
      const cards = Array.isArray((srow as { cards: unknown }).cards)
        ? ((srow as { cards: Cluster4WeeklyCardDto[] }).cards)
        : [];
      const embedded = collectEmbeddedProfiles(cards).find(
        (e) => e.weekId === pr.week && e.userId === pr.person && e.via === pr.via,
      );
      if (embedded) {
        snapHasKey = embedded.hasKey;
        snapVal = embedded.value;
      } else {
        snapVal = "<해당 임베드 없음>";
      }
    }

    const match =
      directHasKey &&
      snapHasKey &&
      (directVal ?? null) === (snapVal ?? null);
    console.log(
      `\n[owner=${short(pr.owner)} week=${short(pr.week)} person=${short(pr.person)} via=${pr.via}]`,
    );
    console.log(`  원장 profile_tagline : ${JSON.stringify(ledger)}`);
    console.log(`  DTO direct           : key=${directHasKey} value=${JSON.stringify(directVal)}`);
    console.log(`  snapshot(=HTTP)      : key=${snapHasKey} value=${JSON.stringify(snapVal)} (snapVer=${snapVer})`);
    console.log(`  direct==snapshot?    : ${match}`);
    if (directHasKey && (directVal == null || String(directVal).trim() === "") && ledger && ledger.trim() !== "") {
      console.log(`  ⚠ direct 가 원장값을 못 채움 → buildPersonProfileMap 경로 점검 필요`);
    }
    if (!snapHasKey || (snapVal == null && ledger && ledger.trim() !== "")) {
      console.log(`  ⚠ snapshot 이 비었거나 키없음 → 이 owner snapshot 재계산 필요`);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 6. 재계산 필요 여부 종합 판정
  // ─────────────────────────────────────────────────────────────
  console.log("\n══════════ 6. 재계산 필요 여부 판정 ══════════");
  const needRecompute = verMismatch > 0 || staleTrue > 0 || staleEvidence.length > 0;
  console.log(`version_mismatch 행: ${verMismatch}`);
  console.log(`is_stale 행: ${staleTrue}`);
  console.log(`원장有·snapshot無 증거: ${staleEvidence.length}`);
  console.log(
    `\n판정: ${needRecompute ? "재계산 필요 (위 stale/mismatch 행을 v" + WEEKLY_CARDS_DTO_VERSION + " 로 재생성)" : "재계산 불필요 (snapshot 이 원장과 정합 — 화면 '-' 는 원장 공백)"}`,
  );

  console.log("\n══ 종료 (READ-ONLY, 변경/recompute 없음) ══");
}

main().catch((e) => {
  console.error("fatal", e);
  process.exit(1);
});
