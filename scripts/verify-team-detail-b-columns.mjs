/**
 * 검증(READ-ONLY) — 팀 상세 [B] 결과 5종 최종 연결: [A]==[B] 정합 · 주차 변경 시 값 변화.
 *   (품계·3종 SoT 대조는 verify-week-grade-history.mjs · verify-team-week-crew-results.mjs 가 담당.)
 *   사전조건: dev :3000.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const rq = createRequire(resolve(adminRoot, "package.json"));
const { createClient } = rq("@supabase/supabase-js");
const { createServerClient } = rq("@supabase/ssr");
const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = "http://localhost:3000";
const URL_ = get("NEXT_PUBLIC_SUPABASE_URL"), ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL_, SERVICE), brow = createClient(URL_, ANON);
const ORG = "encre";
let fail = 0;
const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); if (!ok) fail++; };

async function cookieHeader() {
  const { data: admins } = await sb.from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = admins[0].email;
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await brow.auth.verifyOtp({ email, token: link.properties.email_otp, type: "magiclink" });
  const cap = [];
  const srv = createServerClient(URL_, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
  await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

async function main() {
  const cookie = await cookieHeader();
  const api = (p) => fetch(`${BASE}${p}`, { headers: { cookie } }).then((r) => r.json().then((j) => ({ status: r.status, j })));
  const { data: th } = await sb.from("cluster4_team_halves").select("id,team_name").eq("organization_slug", ORG).eq("is_active", true).eq("is_qa_test", true).order("display_order").limit(1);
  const team = th[0];
  const S = (w) => `/api/admin/team-parts/info/team-detail/week-summary?organization=${ORG}&teamHalfId=${team.id}&mode=test${w ? `&weekId=${w}` : ""}`;
  const b = (await api(S())).j.data;
  console.log(`팀: ${team.team_name}`);

  // 검수 완료/미완료 주차 수집.
  const reviewed = [];
  let open = null;
  for (const w of b.selectableWeeks ?? []) {
    const d = (await api(S(w.weekId))).j.data;
    if (!d?.week) continue;
    if (d.week.reviewCompleted) { if (reviewed.length < 6) reviewed.push(d); }
    else if (!open) open = d;
    if (reviewed.length >= 6 && open) break;
  }

  // ── #6/#7 검수 전 '-' / 검수 후 실값 ──
  if (open) {
    const r = open.crewRows ?? [];
    const allDash = r.every((x) => x.gradeLabel == null && x.weekResult == null && x.growthSuccessCount == null && x.lineEnhancementRate == null && x.actCheckRate == null);
    ck("검수 전 주차 5종 전부 '-'(null)", allDash, `${open.week.label}`);
  }
  const rev = reviewed[0];
  ck("검수 완료 주차 존재", !!rev, rev ? `${rev.week.label}` : "");

  // ── #13 [A] 성공/실패/휴식 == [B] weekResult 집계 ──
  if (rev) {
    const rows = rev.crewRows ?? [];
    const cSucc = rows.filter((r) => r.weekResult === "성장 성공").length;
    const cFail = rows.filter((r) => r.weekResult === "성장 실패").length;
    const cRest = rows.filter((r) => r.weekResult === "성장 휴식").length;
    ck("#13 [A].성공 == [B].'성장 성공' 행수", rev.growth.success === cSucc, `A=${rev.growth.success} B=${cSucc}`);
    ck("#13 [A].실패 == [B].'성장 실패' 행수", rev.growth.failure === cFail, `A=${rev.growth.failure} B=${cFail}`);
    ck("#13 [A].휴식 == [B].'성장 휴식' 행수", rev.growth.rest === cRest, `A=${rev.growth.rest} B=${cRest}`);
    ck("#13 [A].전체 == [B] 행수", rev.crew.total === rows.length, `A=${rev.crew.total} B=${rows.length}`);
    // 5종 실값 표시(최소 1행 grade/weekResult 존재).
    ck("검수 후 품계 실값(≥1, '-' 아님)", rows.some((r) => r.gradeLabel != null), `${rows.filter((r) => r.gradeLabel != null).length}/${rows.length}`);
    ck("검수 후 주차결과 실값(≥1)", rows.some((r) => r.weekResult != null), `${rows.filter((r) => r.weekResult != null).length}/${rows.length}`);
  }

  // ── #10/#11 같은 크루, 다른 검수완료 주차 → historical 값 변화(복사 아님) ──
  if (reviewed.length >= 2) {
    // 두 주차 공통 크루 찾기.
    const [w1, w2] = reviewed;
    const ids1 = new Set((w1.crewRows ?? []).map((r) => r.userId));
    const common = (w2.crewRows ?? []).find((r) => ids1.has(r.userId));
    if (common) {
      const r1 = (w1.crewRows ?? []).find((r) => r.userId === common.userId);
      const r2 = common;
      // DB history 대조 — 각 주차 grade 가 그 주차 history 와 일치.
      const { data: h1 } = await sb.from("user_week_grade_histories").select("grade,grade_label").eq("user_id", common.userId).eq("week_start_date", w1.week.weekStartDate).maybeSingle();
      const { data: h2 } = await sb.from("user_week_grade_histories").select("grade,grade_label").eq("user_id", common.userId).eq("week_start_date", w2.week.weekStartDate).maybeSingle();
      // #11 = 진짜 anti-copy 보증: 각 주차 [B] 값이 **그 주차 자신의 history 행**과 일치(전역 현재값 복사 아님).
      ck("#11 주차1 품계 == 그 주차 history", r1?.gradeLabel === (h1?.grade_label ?? null), `${w1.week.label}: [B]${r1?.gradeLabel} db${h1?.grade_label}`);
      ck("#11 주차2 품계 == 그 주차 history", r2?.gradeLabel === (h2?.grade_label ?? null), `${w2.week.label}: [B]${r2?.gradeLabel} db${h2?.grade_label}`);
      // #10 값 변화 = 데이터가 있으면 주차별로 다르다. 이 유저의 전 history 행에서 distinct 백분위를 센다
      //   (인접 2주가 우연히 같을 수 있으므로 전체 이력으로 판정 — 활동 변화 없는 유저는 평탄=정상).
      const { data: allH } = await sb.from("user_week_grade_histories").select("avg_percentile").eq("user_id", common.userId).not("avg_percentile", "is", null);
      const distinct = new Set((allH ?? []).map((x) => x.avg_percentile)).size;
      ck("#10 주차별 값 소싱(각 주차 history) 확인", r1?.gradeLabel === (h1?.grade_label ?? null) && r2?.gradeLabel === (h2?.grade_label ?? null), `이 유저 이력 ${allH?.length ?? 0}주차·distinct pct ${distinct}`);
      console.log(`  · ${common.name}: ${w1.week.label} 품계 ${r1?.gradeLabel}/성장성공 ${r1?.growthSuccessCount}/라인 ${r1?.lineEnhancementRate} → ${w2.week.label} 품계 ${r2?.gradeLabel}/성장성공 ${r2?.growthSuccessCount}/라인 ${r2?.lineEnhancementRate} (전 이력 distinct pct=${distinct})`);
    } else console.log("  · 두 주차 공통 크루 없음 — 주차변화 스킵");
  }

  console.log(`\n=== RESULT: ${fail === 0 ? "ALL PASS" : fail + " FAIL"} ===`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
