/**
 * diag-encre-info-autoreview-dryrun.ts — encre 실무정보(info) 자동 검수 DRY-RUN (READ-ONLY)
 *
 * 목적: target 0명 + output_link 보유 encre info 라인의 카페 댓글 작성자를 일괄 집계하고
 *       encre user_profiles/user_memberships 와 매칭 결과를 보고한다.
 *       ⚠ DB write 일절 없음(검수/완료/적립 생성 금지). 카페 크롤(HTTP read)만 외부 호출.
 *
 * 실행: npx tsx --env-file=.env.local scripts/diag-encre-info-autoreview-dryrun.ts
 *       (옵션) NO_CRAWL=1 → 크롤 생략하고 대상 라인 산출(1단계)만.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { parseLineCodeOrg } from "@/lib/cluster4LineOrg";
import { fetchCafeNicknames } from "@/lib/cafeCrawlerClient";
import {
  loadCrewRecords,
  matchCafeComments,
  type CrewRecord,
} from "@/lib/cluster4CafeLineMatch";
import { resolveUserScope } from "@/lib/userScope";
import { CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM } from "@/lib/lineAvailability";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const NO_CRAWL = process.env.NO_CRAWL === "1";
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : Infinity;
const SAMPLE = process.env.SAMPLE ? Number(process.env.SAMPLE) : Infinity;
const CAFE_HOST_RE = /(^|\.)cafe\.naver\.com$/i;
const CACHE_PATH =
  "C:/Users/vanua/AppData/Local/Temp/claude/C--Users-vanua-OneDrive-Desktop-vraxium-admin/8ad39c37-15f8-42f1-b312-d66efc5794f4/scratchpad/cache-encre-info-crawl.json";

function readCache(): Record<string, { nicknames: string[]; totalComments: number; uniqueNicknames: number }> {
  try {
    if (existsSync(CACHE_PATH)) return JSON.parse(readFileSync(CACHE_PATH, "utf8"));
  } catch {
    /* 손상 캐시 무시 */
  }
  return {};
}
function writeCache(c: Record<string, unknown>): void {
  try {
    writeFileSync(CACHE_PATH, JSON.stringify(c));
  } catch {
    /* 캐시 쓰기 실패 무시 */
  }
}

async function crawlerHealth(): Promise<string> {
  const base = process.env.CAFE_CRAWLER_URL?.trim();
  if (!base) return "CAFE_CRAWLER_URL 미설정(로컬 폴백)";
  const secret = process.env.CAFE_CRAWLER_SECRET?.trim();
  try {
    const res = await fetch(`${base.replace(/\/+$/, "")}/health?deep=1`, {
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
    });
    const text = await res.text().catch(() => "");
    return `status=${res.status} body=${text.slice(0, 200)}`;
  } catch (e) {
    return `health 실패: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  팀/파트 인지 매칭 변형 (DRY-RUN 비교 전용 — 프로덕션 cluster4CafeLineMatch 무변경)
//
//  encre info 닉네임은 {기수} {팀/파트} {이름} 구조(예: "11기 콘텐츠 김지우").
//  기존 매칭기는 token[1]을 '학교'로만 해석 → 팀/파트 정보를 못 써 동명이인 미해소.
//  변형: token[1]을 school OR team OR part 중 하나와 일치하면 자격(qualified)으로 본다.
//    · 기수(cohort)는 매칭에서 제외(신뢰 불가 — 기존 정책 유지).
//    · qualified 정확히 1명 → 자동. 아니면 이름만 1명 → 자동(기존 폴백 보존).
//    · 그 외(0명 / 2명↑) → 수동.
//  ⇒ 변형 자동집합 ⊇ 기존 자동집합(기존이 잡던 건 전부 잡고, 동명이인만 추가 해소).
//    기존이 review 로 보낸 동명이인을 token[1]로 1명 확정하는 것이 유일한 추가분(= 위험면).
//
//  신형 {이름} {팀} {전공}(token[0]이 기수 아님 + 정확히 3토큰)은 기존과 동일 로직 사용.
// ─────────────────────────────────────────────────────────────────────────
function vnorm(s: string | null | undefined): string {
  return (s ?? "").trim().replace(/\s+/g, "").toLowerCase();
}
function veq(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = vnorm(a);
  const nb = vnorm(b);
  return na.length > 0 && na === nb;
}
const V_COHORT_RE = /^\d+기$/;

type VParsed =
  | { format: "cohort"; cohort: string; mid: string; name: string; raw: string }
  | { format: "new"; name: string; teamName: string; majorName: string; raw: string }
  | { format: "unknown"; name: string; raw: string };

function vParse(raw: string): VParsed {
  const s = (raw ?? "").trim().replace(/\s+/g, " ");
  const tokens = s.length > 0 ? s.split(" ") : [];
  // {기수} {중간토큰=팀/파트 또는 학교} {이름...}
  if (tokens.length >= 3 && V_COHORT_RE.test(tokens[0])) {
    return { format: "cohort", cohort: tokens[0], mid: tokens[1], name: tokens.slice(2).join(" "), raw };
  }
  // 신형 {이름} {팀} {전공}
  if (tokens.length === 3) {
    return { format: "new", name: tokens[0], teamName: tokens[1], majorName: tokens[2], raw };
  }
  return { format: "unknown", name: tokens[0] ?? "", raw };
}

type VSingle =
  | { status: "auto"; crew: CrewRecord; reason: string }
  | { status: "review"; reason: string; nameCandidates: CrewRecord[] };

function vMatchOne(parsed: VParsed, crews: CrewRecord[]): VSingle {
  if (parsed.format === "cohort") {
    const nameMatches = crews.filter((c) => veq(c.name, parsed.name));
    // token[1] 을 school/team/part 어느 하나와라도 일치하면 자격.
    const qualified = nameMatches.filter(
      (c) => veq(c.schoolName, parsed.mid) || veq(c.teamName, parsed.mid) || veq(c.partName, parsed.mid),
    );
    if (qualified.length === 1) {
      const c = qualified[0];
      const field = veq(c.schoolName, parsed.mid)
        ? "school"
        : veq(c.teamName, parsed.mid)
          ? "team"
          : "part";
      return { status: "auto", crew: c, reason: `cohort:name+${field}` };
    }
    if (nameMatches.length === 1) {
      return { status: "auto", crew: nameMatches[0], reason: "cohort:name-only" };
    }
    const reason =
      nameMatches.length === 0
        ? "이름 후보 0명"
        : qualified.length >= 2
          ? `이름+팀/파트/학교 후보 ${qualified.length}명`
          : `이름 후보 ${nameMatches.length}명(팀/파트/학교 불일치)`;
    return { status: "review", reason, nameCandidates: nameMatches };
  }
  if (parsed.format === "new") {
    const nameMatches = crews.filter((c) => veq(c.name, parsed.name));
    const full = nameMatches.filter(
      (c) => veq(c.teamName, parsed.teamName) && veq(c.majorName, parsed.majorName),
    );
    if (full.length === 1) return { status: "auto", crew: full[0], reason: "new:name+team+major" };
    const reason =
      nameMatches.length === 0
        ? "신형: 후보 0명"
        : full.length >= 2
          ? `신형: 이름+팀+전공 후보 ${full.length}명`
          : "신형: 부분 일치";
    return { status: "review", reason, nameCandidates: nameMatches };
  }
  return { status: "review", reason: "형식 불명(파싱 불가)", nameCandidates: crews.filter((c) => veq(c.name, parsed.name)) };
}

type VMatched = { order: number; nickname: string; matchReason: string; crew: CrewRecord };
type VReview = { order: number; nickname: string; reason: string; nameCandidates: CrewRecord[] };
type VResult = { matched: VMatched[]; review: VReview[] };

function vMatchAll(nicknames: string[], crews: CrewRecord[]): VResult {
  const matched: VMatched[] = [];
  const review: VReview[] = [];
  const seen = new Set<string>();
  nicknames.forEach((nickname, order) => {
    const m = vMatchOne(vParse(nickname), crews);
    if (m.status === "auto") {
      if (seen.has(m.crew.userId)) return;
      seen.add(m.crew.userId);
      matched.push({ order, nickname, matchReason: m.reason, crew: m.crew });
    } else {
      review.push({ order, nickname, reason: m.reason, nameCandidates: m.nameCandidates });
    }
  });
  return { matched, review };
}

function isCafeUrl(raw: unknown): boolean {
  if (typeof raw !== "string" || !raw.trim()) return false;
  try {
    return CAFE_HOST_RE.test(new URL(raw.trim()).hostname);
  } catch {
    return false;
  }
}

type LineRow = {
  id: string;
  line_code: string | null;
  part_type: string;
  is_active: boolean;
  week_id: string | null;
  activity_type_id: string | null;
  main_title: string | null;
  output_links: unknown;
  output_link_1: string | null;
  output_link_2: string | null;
};

type WeekMeta = {
  id: string;
  season_key: string | null;
  week_number: number | null;
  start_date: string | null;
  iso_year: number | null;
  iso_week: number | null;
  result_published_at: string | null;
};

function collectLinks(l: LineRow): string[] {
  const urls: string[] = [];
  const arr = Array.isArray(l.output_links) ? l.output_links : [];
  for (const item of arr) {
    if (item && typeof item === "object" && typeof (item as any).url === "string") {
      urls.push((item as any).url);
    } else if (typeof item === "string") {
      urls.push(item);
    }
  }
  if (l.output_link_1) urls.push(l.output_link_1);
  if (l.output_link_2) urls.push(l.output_link_2);
  // dedup + cafe URL only
  return Array.from(new Set(urls.map((u) => u.trim()))).filter(isCafeUrl);
}

async function main() {
  console.log("=== encre 실무정보(info) 자동 검수 DRY-RUN (READ-ONLY) ===");
  console.log(`날짜 기준 적립 경계(CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM) = ${CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM}`);
  console.log(`크롤러: CAFE_CRAWLER_URL ${process.env.CAFE_CRAWLER_URL ? "설정됨(외부 서비스)" : "미설정(로컬 폴백)"} · NO_CRAWL=${NO_CRAWL}\n`);

  // ── 1) 대상 라인 산출 ────────────────────────────────────────────────
  // part_type='info' · is_active=true 전부 로드 후 코드로 encre 필터.
  const { data: linesRaw, error: lErr } = await sb
    .from("cluster4_lines")
    .select(
      "id,line_code,part_type,is_active,week_id,activity_type_id,main_title,output_links,output_link_1,output_link_2",
    )
    .eq("part_type", "info")
    .eq("is_active", true);
  if (lErr) throw new Error(`cluster4_lines 조회 실패: ${lErr.message}`);
  const allInfo = (linesRaw ?? []) as LineRow[];

  const encreInfo = allInfo.filter((l) => parseLineCodeOrg(l.line_code) === "encre");
  console.log(`[1] active info 라인 ${allInfo.length}건 중 encre(EC 토큰) ${encreInfo.length}건`);

  // 타깃 수 집계 (user-mode 기준 "N명") — 0명만 후보.
  const lineIds = encreInfo.map((l) => l.id);
  const targetCount = new Map<string, { user: number; rule: number }>();
  for (let i = 0; i < lineIds.length; i += 200) {
    const slice = lineIds.slice(i, i + 200);
    const { data: tg } = await sb
      .from("cluster4_line_targets")
      .select("line_id,target_mode")
      .in("line_id", slice);
    for (const t of (tg ?? []) as Array<{ line_id: string; target_mode: string }>) {
      const c = targetCount.get(t.line_id) ?? { user: 0, rule: 0 };
      if (t.target_mode === "user") c.user++;
      else c.rule++;
      targetCount.set(t.line_id, c);
    }
  }

  // week 메타 일괄 로드.
  const weekIds = Array.from(new Set(encreInfo.map((l) => l.week_id).filter(Boolean))) as string[];
  const weekMap = new Map<string, WeekMeta>();
  for (let i = 0; i < weekIds.length; i += 200) {
    const slice = weekIds.slice(i, i + 200);
    const { data: wk } = await sb
      .from("weeks")
      .select("id,season_key,week_number,start_date,iso_year,iso_week,result_published_at")
      .in("id", slice);
    for (const w of (wk ?? []) as WeekMeta[]) weekMap.set(w.id, w);
  }

  // activity_types 표시명(있으면).
  const actIds = Array.from(new Set(encreInfo.map((l) => l.activity_type_id).filter(Boolean))) as string[];
  const actName = new Map<string, string>();
  if (actIds.length) {
    const { data: ats } = await sb.from("activity_types").select("id,name").in("id", actIds);
    for (const a of (ats ?? []) as Array<{ id: string; name: string | null }>) {
      if (a.name) actName.set(a.id, a.name);
    }
  }

  // 후보 = 0 user-target + cafe output_link 보유.
  type Candidate = LineRow & { links: string[]; tc: { user: number; rule: number }; week: WeekMeta | null };
  const candidates: Candidate[] = [];
  let zeroTargetCount = 0;
  let zeroTargetNoLink = 0;
  for (const l of encreInfo) {
    const tc = targetCount.get(l.id) ?? { user: 0, rule: 0 };
    if (tc.user !== 0) continue; // 타깃 보유 → 제외
    zeroTargetCount++;
    const links = collectLinks(l);
    if (links.length === 0) {
      zeroTargetNoLink++;
      continue;
    }
    candidates.push({ ...l, links, tc, week: l.week_id ? weekMap.get(l.week_id) ?? null : null });
  }

  console.log(`    └ user-target 0명: ${zeroTargetCount}건 (그 중 cafe링크 없음 ${zeroTargetNoLink}건)`);
  console.log(`[1] ✅ 자동 검수 대상 라인(0명 + cafe링크) = ${candidates.length}건\n`);

  console.log("── 대상 라인 목록 ──");
  for (const c of candidates) {
    const w = c.week;
    const wLabel = w
      ? `${w.season_key ?? "?"} ${w.week_number ?? "?"}주차(iso ${w.iso_year}-W${w.iso_week}, start ${w.start_date}, ${w.result_published_at ? "공표됨" : "미공표"})`
      : "week 없음";
    console.log(
      `  · ${c.id.slice(0, 8)} | ${c.line_code} | ${wLabel} | act=${c.activity_type_id ?? "-"}${
        c.activity_type_id && actName.get(c.activity_type_id) ? `(${actName.get(c.activity_type_id)})` : ""
      } | "${c.main_title ?? ""}" | links=${c.links.length} | target(user/rule)=${c.tc.user}/${c.tc.rule}`,
    );
    for (const u of c.links) console.log(`        ↳ ${u}`);
  }

  if (NO_CRAWL || candidates.length === 0) {
    console.log("\n(크롤 생략 — 1단계 산출만)");
    return;
  }

  // 선택: LIMIT=N(앞 N건) 또는 SAMPLE=N(전체에 균등 간격으로 N건 — 시즌/act 다양성 확보).
  let selected = candidates;
  if (Number.isFinite(SAMPLE) && SAMPLE < candidates.length) {
    const stride = candidates.length / SAMPLE;
    const picked: typeof candidates = [];
    for (let i = 0; i < SAMPLE; i++) picked.push(candidates[Math.floor(i * stride)]);
    selected = picked;
    console.log(`\n[2] SAMPLE=${SAMPLE} → 전체 ${candidates.length}건에서 균등 간격 ${selected.length}건 선택(대표 표본).`);
  } else if (Number.isFinite(LIMIT)) {
    selected = candidates.slice(0, LIMIT);
    console.log(`\n[2] LIMIT=${LIMIT} → 앞 ${selected.length}건으로 제한(스모크).`);
  }

  console.log(`\n[크롤러 health] ${await crawlerHealth()}`);

  // ── 크루 레코드 로드 (encre, operating 스코프=테스트계정 제외) ──────
  const allEncreCrews = await loadCrewRecords("encre");
  const scope = await resolveUserScope("operating", "encre");
  const crews: CrewRecord[] = scope.filter(allEncreCrews, (c) => c.userId);
  console.log(
    `\n[3] encre 크루 레코드 ${allEncreCrews.length}명 로드 → operating(테스트 ${scope.testUserIds.size}명 제외) = ${crews.length}명`,
  );

  // ── 크롤 (URL 캐시: 재실행·before/after 비교 시 네이버 재호출 방지) ──────
  type CachedCrawl = { nicknames: string[]; totalComments: number; uniqueNicknames: number };
  const cache: Record<string, CachedCrawl> = readCache();
  let crawlOk = 0;
  let crawlFail = 0;
  let cacheHit = 0;
  const failedLinks: { lineId: string; url: string; error: string }[] = [];

  console.log("\n[2] 카페 댓글 크롤 + 매칭(기존 vs 팀/파트 변형 동시)\n");
  type Side = {
    matched: { nickname: string; userId: string; crewNo: number | null; name: string; reason: string }[];
    matchedUserIds: string[];
    ambiguous: number;
    unmatched: number;
    unparseable: number;
    reviewTotal: number;
  };
  type LineReport = {
    lineId: string;
    lineCode: string | null;
    seasonKey: string | null;
    weekLabel: string;
    weekId: string | null;
    published: boolean;
    accrualWouldSkip: boolean;
    nickCount: number;
    base: Side;
    variant: Side;
    // 변형이 추가로 자동확정한(기존=review) 건 = 동명이인 해소 + 위험면.
    resolved: { nickname: string; chosen: string; reason: string; otherCandidates: string[] }[];
  };
  const reports: LineReport[] = [];

  const classify = (reviews: { reason: string }[]) => {
    let ambiguous = 0;
    let unmatched = 0;
    let unparseable = 0;
    for (const rv of reviews) {
      if (rv.reason.includes("0명")) unmatched++;
      else if (rv.reason.includes("형식 불명")) unparseable++;
      else ambiguous++;
    }
    return { ambiguous, unmatched, unparseable };
  };

  for (const c of selected) {
    const w = c.week;
    const startDate = w?.start_date ?? null;
    const accrualWouldSkip = !(startDate && startDate >= CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM);

    // 라인의 모든 카페 링크 크롤 → 닉네임 합집합(순서 보존). 캐시 우선.
    const seenNick = new Set<string>();
    const orderedNicks: string[] = [];
    for (const url of c.links) {
      let data: CachedCrawl | null = cache[url] ?? null;
      if (data) {
        cacheHit++;
      } else {
        const res = await fetchCafeNicknames(url);
        if (res.ok) {
          data = {
            nicknames: res.data.nicknames,
            totalComments: res.data.totalComments,
            uniqueNicknames: res.data.uniqueNicknames,
          };
          cache[url] = data;
        } else {
          crawlFail++;
          failedLinks.push({ lineId: c.id, url, error: res.error });
        }
        await new Promise((r) => setTimeout(r, 600)); // 세션 보호
      }
      if (data) {
        crawlOk++;
        for (const nk of data.nicknames) {
          if (!seenNick.has(nk)) {
            seenNick.add(nk);
            orderedNicks.push(nk);
          }
        }
      }
    }

    // 기존 매칭기 (프로덕션 cluster4CafeLineMatch).
    const bm = matchCafeComments(orderedNicks, crews);
    const baseCls = classify(bm.review);
    const base: Side = {
      matched: bm.matched.map((x) => ({ nickname: x.nickname, userId: x.crew.userId, crewNo: x.crew.crewNo, name: x.crew.name, reason: x.matchReason })),
      matchedUserIds: bm.matched.map((x) => x.crew.userId),
      ...baseCls,
      reviewTotal: bm.review.length,
    };

    // 팀/파트 변형.
    const vm = vMatchAll(orderedNicks, crews);
    const varCls = classify(vm.review);
    const variant: Side = {
      matched: vm.matched.map((x) => ({ nickname: x.nickname, userId: x.crew.userId, crewNo: x.crew.crewNo, name: x.crew.name, reason: x.matchReason })),
      matchedUserIds: vm.matched.map((x) => x.crew.userId),
      ...varCls,
      reviewTotal: vm.review.length,
    };

    // 변형이 새로 확정한 닉네임(기존에는 자동 아님) — 동명이인 해소분 + 위험면.
    const baseAutoNicks = new Set(bm.matched.map((x) => x.nickname));
    const baseReviewByNick = new Map(bm.review.map((x) => [x.nickname, x]));
    const resolved: LineReport["resolved"] = [];
    for (const x of vm.matched) {
      if (baseAutoNicks.has(x.nickname)) continue;
      const br = baseReviewByNick.get(x.nickname);
      resolved.push({
        nickname: x.nickname,
        chosen: `${x.crew.name}(crew#${x.crew.crewNo ?? "-"}, ${x.crew.userId.slice(0, 8)})`,
        reason: x.matchReason,
        otherCandidates: (br?.nameCandidates ?? [])
          .filter((cd) => cd.userId !== x.crew.userId)
          .map((cd) => `${cd.name}(crew#${cd.crewNo ?? "-"}/${cd.teamName ?? "-"}·${cd.partName ?? "-"})`),
      });
    }

    reports.push({
      lineId: c.id,
      lineCode: c.line_code,
      seasonKey: w?.season_key ?? null,
      weekLabel: w ? `${w.season_key ?? "?"} ${w.week_number ?? "?"}주차` : "week 없음",
      weekId: c.week_id,
      published: Boolean(w?.result_published_at),
      accrualWouldSkip,
      nickCount: orderedNicks.length,
      base,
      variant,
      resolved,
    });

    console.log(
      `  · ${c.id.slice(0, 8)} ${c.line_code} [${reports[reports.length - 1].weekLabel}] 닉 ${orderedNicks.length} | 기존 매칭 ${base.matched.length} · 변형 ${variant.matched.length} (+${variant.matched.length - base.matched.length}) | 적립 ${accrualWouldSkip ? "SKIP" : "발생"}`,
    );
  }
  writeCache(cache);

  // ── 종합 비교 보고 ──────────────────────────────────────────────────
  const sum = (f: (r: LineReport) => number) => reports.reduce((n, r) => n + f(r), 0);
  const totalNick = sum((r) => r.nickCount);
  const baseMatched = sum((r) => r.base.matched.length);
  const varMatched = sum((r) => r.variant.matched.length);
  const baseAmb = sum((r) => r.base.ambiguous);
  const varAmb = sum((r) => r.variant.ambiguous);
  const baseUnm = sum((r) => r.base.unmatched);
  const varUnm = sum((r) => r.variant.unmatched);
  const baseUnp = sum((r) => r.base.unparseable);
  const varUnp = sum((r) => r.variant.unparseable);
  const baseDistinct = new Set(reports.flatMap((r) => r.base.matchedUserIds));
  const varDistinct = new Set(reports.flatMap((r) => r.variant.matchedUserIds));
  const totalResolved = sum((r) => r.resolved.length);
  const skipLines = reports.filter((r) => r.accrualWouldSkip).length;
  const pct = (n: number) => (totalNick ? ((n / totalNick) * 100).toFixed(1) : "0.0");

  console.log("\n================= DRY-RUN 비교 종합 =================");
  console.log(`대상(크롤) 라인 수                : ${selected.length}`);
  console.log(`크롤 성공/실패 링크 (캐시히트)     : ${crawlOk} / ${crawlFail} (cache ${cacheHit})`);
  console.log(`댓글 작성자(닉네임) 총 수          : ${totalNick}`);
  console.log("");
  console.log("                          기존 매칭기    →   팀/파트 변형");
  console.log(`자동 매칭(닉네임 기준)   : ${String(baseMatched).padStart(6)} (${pct(baseMatched)}%)  →  ${String(varMatched).padStart(6)} (${pct(varMatched)}%)`);
  console.log(`  └ 고유 user_id        : ${String(baseDistinct.size).padStart(6)}        →  ${String(varDistinct.size).padStart(6)}`);
  console.log(`모호(동명이인 등)        : ${String(baseAmb).padStart(6)} (${pct(baseAmb)}%)  →  ${String(varAmb).padStart(6)} (${pct(varAmb)}%)`);
  console.log(`미매칭(이름 0명)         : ${String(baseUnm).padStart(6)} (${pct(baseUnm)}%)  →  ${String(varUnm).padStart(6)} (${pct(varUnm)}%)`);
  console.log(`형식 불명               : ${String(baseUnp).padStart(6)}        →  ${String(varUnp).padStart(6)}`);
  console.log("");
  console.log(`변형이 추가 확정(동명이인 해소+신규)  : ${totalResolved}건  ← 기존 review → 변형 auto`);
  console.log(`적립 SKIP 라인(start<${CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM}) : ${skipLines}/${reports.length}`);

  // 위험 검토: 변형이 추가 확정한 건(특히 다른 동명 후보가 존재했던 케이스).
  const riskCases = reports.flatMap((r) =>
    r.resolved
      .filter((x) => x.otherCandidates.length > 0)
      .map((x) => ({ line: r.lineCode, ...x })),
  );
  console.log(`\n── 변형 추가확정 중 동명이인 존재(수동 검증 권장) : ${riskCases.length}건 ──`);
  for (const rc of riskCases.slice(0, 40)) {
    console.log(`  ⚠ [${rc.line}] "${rc.nickname}" → ${rc.chosen} (${rc.reason}) | 다른 후보: ${rc.otherCandidates.join(", ")}`);
  }
  if (riskCases.length > 40) console.log(`  … 외 ${riskCases.length - 40}건`);

  // ── 시즌별 매칭률(변형 기준) ────────────────────────────────────────
  type SeasonAgg = { lines: number; nick: number; auto: number; amb: number; unm: number; recipients: number };
  const seasonMap = new Map<string, SeasonAgg>();
  for (const r of reports) {
    const k = r.seasonKey ?? "unknown";
    const a = seasonMap.get(k) ?? { lines: 0, nick: 0, auto: 0, amb: 0, unm: 0, recipients: 0 };
    a.lines++;
    a.nick += r.nickCount;
    a.auto += r.variant.matched.length;
    a.amb += r.variant.ambiguous;
    a.unm += r.variant.unmatched;
    a.recipients += r.variant.matchedUserIds.length;
    seasonMap.set(k, a);
  }
  const seasonOrder = Array.from(seasonMap.keys()).sort();
  console.log("\n── 시즌별 매칭률(변형 기준) ──");
  console.log("  season            라인  닉네임  자동매칭(률)   모호  미매칭  recipient");
  for (const k of seasonOrder) {
    const a = seasonMap.get(k)!;
    const rate = a.nick ? ((a.auto / a.nick) * 100).toFixed(1) : "0.0";
    console.log(
      `  ${k.padEnd(16)} ${String(a.lines).padStart(4)} ${String(a.nick).padStart(6)} ${String(a.auto).padStart(7)} (${rate.padStart(5)}%) ${String(a.amb).padStart(5)} ${String(a.unm).padStart(6)} ${String(a.recipients).padStart(9)}`,
    );
  }

  // ── execute 시 생성될 recipient 수 (변형 매칭 기준) ─────────────────
  // recipient row = (라인, user) 단위. 라인 간 동일 user 는 라인별로 각각 1행.
  const totalRecipients = sum((r) => r.variant.matchedUserIds.length);
  console.log(
    `\n실제 execute 시 생성될 recipient(검수 명단) 행 수 = ${totalRecipients} (라인×매칭user, 변형 기준)`,
  );
  console.log(`  └ 고유 user_id = ${varDistinct.size}명 / 적립 발생 라인 0 → process_point_awards 0행(과거주차 era_blocked)`);

  // ── 전체 라인별 변형 매칭 user_id 를 파일로 (309건 stdout 과다 방지) ──
  const fullReportPath = "claudedocs/encre-info-autoreview-dryrun-full.json";
  const lineUserMap = reports.map((r) => ({
    lineId: r.lineId,
    lineCode: r.lineCode,
    season: r.seasonKey,
    week: r.weekLabel,
    accrualWouldSkip: r.accrualWouldSkip,
    nickCount: r.nickCount,
    matchedUserIds: r.variant.matchedUserIds,
    matched: r.variant.matched.map((m) => ({ userId: m.userId, crewNo: m.crewNo, name: m.name, nickname: m.nickname, reason: m.reason })),
    review: r.variant.matched.length, // placeholder; full review below in fullReport
  }));
  try {
    writeFileSync(
      fullReportPath,
      JSON.stringify(
        {
          generatedFor: "encre info auto-review dry-run (FULL)",
          effectiveFrom: CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM,
          totals: {
            lines: reports.length,
            totalNicknames: totalNick,
            base: { autoMatched: baseMatched, distinctUsers: baseDistinct.size, ambiguous: baseAmb, unmatched: baseUnm, unparseable: baseUnp },
            variant: { autoMatched: varMatched, distinctUsers: varDistinct.size, ambiguous: varAmb, unmatched: varUnm, unparseable: varUnp },
            resolvedByVariant: totalResolved,
            totalRecipients,
            crawlOk,
            crawlFail,
          },
          seasons: seasonOrder.map((k) => ({ season: k, ...seasonMap.get(k)! })),
          lines: reports,
        },
        null,
        2,
      ),
    );
    console.log(`\n전체 라인별 상세(JSON) → ${fullReportPath} (${lineUserMap.length} lines)`);
  } catch (e) {
    console.log(`\n[!] full report 파일 쓰기 실패: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (failedLinks.length) {
    console.log("\n── 크롤 실패 링크 ──");
    for (const f of failedLinks) console.log(`  ✗ ${f.lineId.slice(0, 8)} ${f.url} → ${f.error}`);
  }

  console.log("\n=== JSON_REPORT_BEGIN ===");
  console.log(
    JSON.stringify(
      {
        effectiveFrom: CLUSTER4_SLOT_POLICY_EFFECTIVE_FROM,
        crawledLines: selected.length,
        crawlOk,
        crawlFail,
        cacheHit,
        totalNicknames: totalNick,
        base: { autoMatched: baseMatched, distinctUsers: baseDistinct.size, ambiguous: baseAmb, unmatched: baseUnm, unparseable: baseUnp },
        variant: { autoMatched: varMatched, distinctUsers: varDistinct.size, ambiguous: varAmb, unmatched: varUnm, unparseable: varUnp },
        resolvedByVariant: totalResolved,
        riskCases: riskCases.length,
        skipAccrualLines: skipLines,
        totalRecipients,
      },
      null,
      2,
    ),
  );
  console.log("=== JSON_REPORT_END ===");
}

main().catch((e) => {
  console.error("ERR", e instanceof Error ? e.stack : e);
  process.exit(1);
});
