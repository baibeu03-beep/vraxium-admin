/**
 * [실 HTTP · E2E] 라인 강화 내역 — 강화 시 포인트 vs 평점 Point A 분리 표시 검증.
 *
 *   dev server 필요. run:
 *     BASE=http://localhost:3000 node_modules/.bin/tsx --env-file=.env.local \
 *       scripts/verify-line-rating-display-e2e.ts
 *
 * ⚠ 쓰기 범위 — **QA 테스트 라인(cluster4_lines.is_qa_test=true)에 한정**한다.
 *   · reconcileLineResultAwardForUser 재실행(멱등: 같은 판정으로 같은 값 재기록)
 *   · 평점 수정 케이스는 QA 평가행 1건을 일시 변경 후 **원값으로 반드시 복원**한다.
 *   운영 라인(is_qa_test=false)·실사용자 데이터는 **어떤 경로로도 건드리지 않는다**.
 *   (과거 주차 backfill 은 별도 승인 사항 — 이 스크립트는 수행하지 않는다.)
 *
 * 검증 사례(요구 §검증 1~12):
 *   ① 강화 시 포인트 + 평점 Point A 둘 다 있는 라인
 *   ② 강화 시 포인트만 있고 평점 Point A 없는 라인(미지급)
 *   ③④⑤ 평점 4 / 7 / 10
 *   ⑥ 평점 0~3 강화 실패 → 둘 다 미지급
 *   ⑦ 평점 수정 → 원장·API 동시 변경(재정합)
 *   ⑧ 회수(강화 실패 전환) → 평점 Point A 회수 · 복원
 *   ⑨ 관리 라인 포함 · ⑩ 확장 라인 제외
 *   ⑪⑫ snapshot 보유/미보유 주차
 *   + 원장 ↔ API DTO ↔ 합계 정합 · 일반/mode=test/actAsTestUserId/demoUserId 파리티 · 중복 없음
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- 검증 스크립트: 외부 API 응답/raw row 를 훑는다. */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  reconcileLineResultAwardForUser,
  recomputeWeeklyPointsForUsers,
} from "@/lib/processPointAccrual";
import { resolveCrewWeekCard } from "@/lib/adminCrewWeekDetail";

const BASE = process.env.BASE ?? "http://localhost:3000";
const u = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const a = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const s = process.env.SUPABASE_SERVICE_ROLE_KEY!;

let failed = 0;
const ck = (n: string, ok: boolean, d?: unknown) => {
  console.log(`${ok ? "✅" : "❌"} ${n}${d !== undefined ? " :: " + JSON.stringify(d) : ""}`);
  if (!ok) failed++;
};

async function cookieHeader(): Promise<string> {
  const { data: adm } = await supabaseAdmin
    .from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = (adm?.[0] as { email: string } | undefined)?.email;
  if (!email) throw new Error("활성 관리자 계정을 찾지 못했습니다.");
  const A = createClient(u, s), N = createClient(u, a);
  const { data: l } = await A.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await N.auth.verifyOtp({ email, token: (l as any).properties.email_otp, type: "magiclink" });
  const cap: Array<{ name: string; value: string }> = [];
  const sv = createServerClient(u, a, {
    cookies: { getAll: () => [], setAll: (it: any[]) => cap.push(...it.map(({ name, value }) => ({ name, value }))) },
  });
  await sv.auth.setSession({ access_token: (v as any).session.access_token, refresh_token: (v as any).session.refresh_token });
  console.log(`admin = ${email}\n`);
  return cap.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function get(path: string, cookie: string) {
  const r = await fetch(`${BASE}${path}`, { headers: { cookie }, cache: "no-store" });
  let json: any = null;
  try { json = await r.json(); } catch { /* non-json */ }
  return { status: r.status, json };
}

const linesPath = (userId: string, weekId: string, q = "") =>
  `/api/admin/members/${userId}/weeks/${weekId}/lines${q}`;

// 원장 실측 — (user, line) 의 활성 행. source 별 분리.
async function ledger(userId: string, lineId: string) {
  const { data } = await supabaseAdmin
    .from("process_point_awards")
    .select("source,point_check,point_advantage,point_penalty,cancelled_at")
    .eq("user_id", userId).eq("ref_id", lineId).in("source", ["line", "line_rating"]);
  const rows = ((data ?? []) as any[]).filter((r) => !r.cancelled_at);
  const enh = rows.find((r) => r.source === "line") ?? null;
  const rat = rows.find((r) => r.source === "line_rating") ?? null;
  return {
    enhA: enh?.point_check ?? 0, enhB: enh?.point_advantage ?? 0,
    ratA: rat?.point_check ?? 0, ratB: rat?.point_advantage ?? 0, ratC: rat?.point_penalty ?? 0,
    ratPaid: rat != null,
    rowCount: ((data ?? []) as any[]).filter((r) => !r.cancelled_at).length,
  };
}

type Case = {
  label: string; org: string; weekLabel: string; userId: string; lineId: string;
  weekId: string; cat: string; rating: number | null; evaluated: boolean;
};

async function collectQaCases(): Promise<Case[]> {
  const { data: lines } = await supabaseAdmin
    .from("cluster4_lines")
    .select("id,experience_line_master_id")
    .eq("part_type", "experience").eq("is_qa_test", true).eq("is_active", true);
  const L = (lines ?? []) as any[];
  if (L.length === 0) return [];
  const { data: masters } = await supabaseAdmin
    .from("cluster4_experience_line_masters").select("id,experience_category");
  const catBy = new Map(((masters ?? []) as any[]).map((m) => [m.id, m.experience_category]));
  const { data: tgts } = await supabaseAdmin
    .from("cluster4_line_targets").select("id,line_id,week_id,target_user_id")
    .in("line_id", L.map((l) => l.id)).eq("target_mode", "user").not("target_user_id", "is", null);
  const T = (tgts ?? []) as any[];
  const evs: any[] = [];
  for (let i = 0; i < T.length; i += 60) {
    const { data } = await supabaseAdmin
      .from("cluster4_experience_line_evaluations").select("line_target_id,user_id,rating,evaluated_by")
      .in("line_target_id", T.slice(i, i + 60).map((t) => t.id));
    evs.push(...((data ?? []) as any[]));
  }
  const E = new Map(evs.map((e) => [`${e.line_target_id}:${e.user_id}`, e]));
  const { data: wks } = await supabaseAdmin.from("weeks").select("id,season_key,week_number");
  const W = new Map(((wks ?? []) as any[]).map((w) => [w.id, `${w.season_key} W${w.week_number}`]));
  const uids = Array.from(new Set(T.map((t) => t.target_user_id)));
  const profs: any[] = [];
  for (let i = 0; i < uids.length; i += 60) {
    const { data } = await supabaseAdmin
      .from("user_profiles").select("user_id,organization_slug").in("user_id", uids.slice(i, i + 60));
    profs.push(...((data ?? []) as any[]));
  }
  const P = new Map(profs.map((p) => [p.user_id, p]));

  const all: Case[] = T.map((t) => {
    const l = L.find((x) => x.id === t.line_id);
    const e = E.get(`${t.id}:${t.target_user_id}`);
    return {
      label: "", org: P.get(t.target_user_id)?.organization_slug ?? "?",
      weekLabel: W.get(t.week_id) ?? "?", userId: t.target_user_id, lineId: t.line_id, weekId: t.week_id,
      cat: (l?.experience_line_master_id ? catBy.get(l.experience_line_master_id) : null) ?? "?",
      rating: e ? (e.rating ?? 0) : null, evaluated: e != null && e.evaluated_by != null,
    };
  });

  // 요구 사례별로 1건씩 뽑는다(전수 대신 대표 케이스 — 실행 시간·쓰기 범위 최소화).
  const pick = (label: string, f: (c: Case) => boolean): Case | null => {
    const hit = all.find(f);
    return hit ? { ...hit, label } : null;
  };
  return [
    pick("③ 평점 4점", (c) => c.evaluated && c.rating === 4),
    pick("④ 평점 7점", (c) => c.evaluated && c.rating === 7),
    pick("⑤ 평점 10점", (c) => c.evaluated && c.rating === 10),
    pick("⑥ 평점 0~3 (강화 실패)", (c) => c.evaluated && (c.rating ?? 99) <= 3),
    pick("⑨ 관리 라인", (c) => c.cat === "management" && c.evaluated && (c.rating ?? 0) >= 4),
    pick("⑩ 확장 라인(제외 확인)", (c) => c.cat === "extension"),
  ].filter((c): c is Case => c !== null);
}

async function main() {
  const cookie = await cookieHeader();
  const cases = await collectQaCases();
  if (cases.length === 0) {
    console.log("⚠ QA 테스트 experience 라인이 없어 종료합니다(쓰기 0).");
    process.exit(0);
  }
  console.log(`QA 대표 케이스 ${cases.length}건 — 쓰기 범위는 is_qa_test=true 라인뿐입니다.\n`);

  const touched = new Set<string>();

  for (const c of cases) {
    console.log(`\n▸ ${c.label} — ${c.org} ${c.weekLabel} ${c.cat} rating=${c.rating ?? "행없음"} (평가=${c.evaluated ? "O" : "X"})`);

    // 카드의 강화 판정(SoT)을 그대로 써서 원장 정합 — 재판정하지 않는다.
    const resolved = await resolveCrewWeekCard(c.userId, c.weekId);
    if (!resolved.ok) { ck(`${c.label} · 카드 로드`, false, resolved.reason); continue; }
    const line = resolved.card.lines.find((l) => l.lineId === c.lineId && l.lineTargetId != null);
    if (!line) { console.log("   (이 크루의 배정 라인이 카드에 없음 — 건너뜀)"); continue; }
    const isSuccess = line.enhancementStatus === "success";
    await reconcileLineResultAwardForUser(c.userId, c.lineId, c.weekId, isSuccess, null);
    touched.add(`${c.userId}:${c.weekId}`);

    const led = await ledger(c.userId, c.lineId);
    const res = await get(linesPath(c.userId, c.weekId), cookie);
    ck(`${c.label} · API 200`, res.status === 200, { status: res.status });
    if (res.status !== 200) continue;
    const row = (res.json?.data?.lineDetails ?? []).find((r: any) => r.lineId === c.lineId);
    if (!row) { ck(`${c.label} · DTO 행 존재`, false); continue; }

    // ── DTO 계약 ──
    const shapeOk =
      typeof row.enhancementPointA === "number" && typeof row.enhancementPointB === "number" &&
      typeof row.ratingPointA === "number" && typeof row.totalPointA === "number" &&
      ["paid", "not_paid", "not_applicable"].includes(row.ratingPointStatus);
    ck(`${c.label} · DTO 필드/타입(enhancement*·rating*·total*)`, shapeOk, {
      enhancementPointA: row.enhancementPointA, enhancementPointB: row.enhancementPointB,
      ratingPointA: row.ratingPointA, ratingPointStatus: row.ratingPointStatus,
      totalPointA: row.totalPointA, totalPointB: row.totalPointB,
    });

    // ── 원장 == DTO(강화/평점 각각) ──
    ck(`${c.label} · 강화 시 포인트: 원장 == DTO`,
      row.enhancementPointA === led.enhA && row.enhancementPointB === led.enhB,
      { 원장: [led.enhA, led.enhB], DTO: [row.enhancementPointA, row.enhancementPointB] });
    ck(`${c.label} · 평점 Point A: 원장 == DTO`,
      row.ratingPointA === led.ratA && (row.ratingPointStatus === "paid") === led.ratPaid,
      { 원장: { A: led.ratA, paid: led.ratPaid }, DTO: { A: row.ratingPointA, status: row.ratingPointStatus } });
    ck(`${c.label} · 두 항목이 뭉개지지 않음(합계 = 강화 + 평점)`,
      row.totalPointA === row.enhancementPointA + row.ratingPointA && row.totalPointB === row.enhancementPointB,
      { total: [row.totalPointA, row.totalPointB], parts: [row.enhancementPointA, row.ratingPointA, row.enhancementPointB] });
    ck(`${c.label} · 평점은 Point B/C 로 지급되지 않음(원장)`,
      led.ratB === 0 && led.ratC === 0, { B: led.ratB, C: led.ratC });

    // ── 사례별 기대값 ──
    if (c.label.startsWith("③") || c.label.startsWith("④") || c.label.startsWith("⑤") || c.label.startsWith("⑨")) {
      if (isSuccess) {
        ck(`${c.label} · 평점 ${c.rating}점 그대로 Point A 적립`, row.ratingPointA === c.rating, { expected: c.rating, got: row.ratingPointA });
        ck(`${c.label} · ① 강화 시 포인트와 평점 Point A 가 **둘 다** 노출`,
          row.ratingPointStatus === "paid" && typeof row.enhancementPointA === "number",
          { enh: [row.enhancementPointA, row.enhancementPointB], rating: row.ratingPointA });
      } else {
        console.log(`   (카드 강화 판정이 ${line.enhancementStatus} — 지급 조건 미충족, 미지급 기대)`);
        ck(`${c.label} · 비성공 → 평점 미지급`, row.ratingPointStatus !== "paid", { status: row.ratingPointStatus });
      }
    }
    if (c.label.startsWith("⑥")) {
      ck(`⑥ 평점 0~3 → 강화 시 포인트·평점 Point A 모두 미지급`,
        row.enhancementPointA === 0 && row.enhancementPointB === 0 && row.ratingPointStatus === "not_paid",
        { enh: [row.enhancementPointA, row.enhancementPointB], status: row.ratingPointStatus });
    }
    if (c.label.startsWith("⑩")) {
      ck(`⑩ 확장 라인 → 평점 Point A 대상 아님("-")`, row.ratingPointStatus === "not_applicable", { status: row.ratingPointStatus });
    }

    // ── 요약 == 행 합 불변식 ──
    const d = res.json.data;
    const sumRating = (d.lineDetails as any[]).reduce((n, r) => n + (r.ratingPointA || 0), 0);
    const sumEnh = (d.lineDetails as any[]).reduce((n, r) => n + (r.enhancementPointA || 0), 0);
    ck(`${c.label} · 요약 ratingPointA == Σ행`, d.ratingPointA === sumRating, { summary: d.ratingPointA, rows: sumRating });
    ck(`${c.label} · 요약 points.pointA.earned == Σ행 강화(뭉개짐 없음)`,
      d.points.pointA.earned === sumEnh, { summary: d.points.pointA.earned, rows: sumEnh });
    ck(`${c.label} · 요약 totalPointA == 강화 + 평점`,
      d.totalPointA === d.points.pointA.earned + d.ratingPointA,
      { total: d.totalPointA, enh: d.points.pointA.earned, rating: d.ratingPointA });

    // ── ⑪⑫ snapshot 보유/미보유 ──
    const { data: snap } = await supabaseAdmin
      .from("cluster4_weekly_card_snapshots").select("user_id").eq("user_id", c.userId).limit(1);
    console.log(`   snapshot ${((snap ?? []) as any[]).length > 0 ? "보유" : "미보유"} 주차 — 라인별 획득값은 snapshot 이 아니라 원장 live 조회(구조상 stale 불가)`);

    // ── 모드 파리티 ──
    for (const [vname, q] of [
      ["mode=test", "?mode=test"],
      ["actAsTestUserId", `?mode=test&actAsTestUserId=${c.userId}`],
      ["demoUserId", `?demoUserId=${c.userId}`],
    ] as Array<[string, string]>) {
      const v = await get(linesPath(c.userId, c.weekId, q), cookie);
      ck(`${c.label} · 일반 == ${vname}`,
        v.status === res.status && JSON.stringify(v.json?.data) === JSON.stringify(d),
        v.status === res.status ? undefined : { base: res.status, [vname]: v.status });
    }

    // ── 중복 없음(반복 실행 멱등) ──
    await reconcileLineResultAwardForUser(c.userId, c.lineId, c.weekId, isSuccess, null);
    await reconcileLineResultAwardForUser(c.userId, c.lineId, c.weekId, isSuccess, null);
    const led2 = await ledger(c.userId, c.lineId);
    ck(`${c.label} · 반복 실행 → 중복 행/중복 합산 없음`,
      led2.rowCount === led.rowCount && led2.ratA === led.ratA && led2.enhA === led.enhA,
      { before: led, after: led2 });
  }

  // ── ⑦ 평점 수정 → 원장·API 동시 반영 (QA 평가행 1건 일시 변경 후 복원) ────────
  const edit = cases.find((c) => c.evaluated && (c.rating ?? 0) >= 7);
  if (edit) {
    console.log(`\n▸ ⑦ 평점 수정 재정합 — ${edit.org} ${edit.weekLabel} ${edit.cat} (${edit.rating} → 5 → ${edit.rating})`);
    const { data: tgt } = await supabaseAdmin
      .from("cluster4_line_targets").select("id").eq("line_id", edit.lineId)
      .eq("target_user_id", edit.userId).eq("target_mode", "user").limit(1);
    const targetId = ((tgt ?? []) as any[])[0]?.id;
    const original = edit.rating as number;
    if (targetId) {
      const applyRating = async (v: number) => {
        await supabaseAdmin.from("cluster4_experience_line_evaluations")
          .update({ rating: v }).eq("line_target_id", targetId).eq("user_id", edit.userId);
        await reconcileLineResultAwardForUser(edit.userId, edit.lineId, edit.weekId, true, null);
        const led = await ledger(edit.userId, edit.lineId);
        const res = await get(linesPath(edit.userId, edit.weekId), cookie);
        const row = (res.json?.data?.lineDetails ?? []).find((r: any) => r.lineId === edit.lineId);
        return { led, row };
      };
      try {
        const mid = await applyRating(5);
        ck("⑦ 평점 7→5 수정 → 원장 5", mid.led.ratA === 5, { ledger: mid.led.ratA });
        ck("⑦ 평점 7→5 수정 → API DTO 도 5(화면 동시 변경)", mid.row?.ratingPointA === 5, { dto: mid.row?.ratingPointA });
        ck("⑦ 차액 재정합(중복 누적 아님)", mid.led.ratA === 5, { ledger: mid.led.ratA });
      } finally {
        const back = await applyRating(original);
        ck(`⑦ 원값(${original}) 복원 — 원장·API 동시`,
          back.led.ratA === original && back.row?.ratingPointA === original,
          { ledger: back.led.ratA, dto: back.row?.ratingPointA });
      }
    } else {
      console.log("   (대상 target 미발견 — 건너뜀)");
    }

    // ── ⑧ 회수 → 복원 ──────────────────────────────────────────────────────
    console.log(`\n▸ ⑧ 강화 실패 전환 → 평점 Point A 회수 · 복원`);
    await reconcileLineResultAwardForUser(edit.userId, edit.lineId, edit.weekId, false, null);
    const revoked = await ledger(edit.userId, edit.lineId);
    const revRes = await get(linesPath(edit.userId, edit.weekId), cookie);
    const revRow = (revRes.json?.data?.lineDetails ?? []).find((r: any) => r.lineId === edit.lineId);
    ck("⑧ 회수 → 원장 평점 비활성", revoked.ratPaid === false, { ratPaid: revoked.ratPaid });
    ck("⑧ 회수 → 화면 '미지급'(잘못된 0점 항목 아님)", revRow?.ratingPointStatus === "not_paid", { status: revRow?.ratingPointStatus });
    ck("⑧ 회수 → 강화 시 포인트도 함께 0", revRow?.enhancementPointA === 0 && revRow?.enhancementPointB === 0,
      { enh: [revRow?.enhancementPointA, revRow?.enhancementPointB] });

    await reconcileLineResultAwardForUser(edit.userId, edit.lineId, edit.weekId, true, null);
    const back2 = await ledger(edit.userId, edit.lineId);
    const backRes = await get(linesPath(edit.userId, edit.weekId), cookie);
    const backRow = (backRes.json?.data?.lineDetails ?? []).find((r: any) => r.lineId === edit.lineId);
    ck("⑧ 재성공 → 평점 Point A 복원(원장·API)",
      back2.ratA === original && backRow?.ratingPointA === original,
      { ledger: back2.ratA, dto: backRow?.ratingPointA });
  }

  // ── ② 강화 시 포인트만 있고 평점 없는 라인(정보/역량/경력) ──────────────────
  const anyCase = cases[0];
  if (anyCase) {
    const res = await get(linesPath(anyCase.userId, anyCase.weekId), cookie);
    const nonExp = (res.json?.data?.lineDetails ?? []).filter((r: any) => r.partType !== "experience");
    ck("② 비-실무경험 라인은 평점 Point A '해당 없음'(0점 항목 생성 금지)",
      nonExp.length > 0 && nonExp.every((r: any) => r.ratingPointStatus === "not_applicable"),
      { rows: nonExp.length, statuses: Array.from(new Set(nonExp.map((r: any) => r.ratingPointStatus))) });
  }

  // ── user_weekly_points 반영 확인 ────────────────────────────────────────
  //   ⚠ reconcileLineResultAwardForUser 는 원장만 갱신하고 재합산하지 않는다(설계). 운영 호출부는
  //     직후 recomputeWeeklyPointsForUsers 로 1회 수렴한다(adminCrewWeekLineSave §5 ·
  //     lineResultAwardReconcile). 검증도 **같은 순서**를 재현해야 한다.
  for (const key of touched) {
    const [userId, weekId] = key.split(":");
    await recomputeWeeklyPointsForUsers([userId], weekId);
  }
  for (const key of touched) {
    const [userId, weekId] = key.split(":");
    const { data: w } = await supabaseAdmin.from("weeks").select("iso_year,iso_week").eq("id", weekId).maybeSingle();
    if (!w) continue;
    const { data: uwp } = await supabaseAdmin.from("user_weekly_points").select("points")
      .eq("user_id", userId).eq("year", (w as any).iso_year).eq("week_number", (w as any).iso_week).maybeSingle();
    const { data: aw } = await supabaseAdmin.from("process_point_awards")
      .select("point_check,cancelled_at").eq("user_id", userId)
      .eq("year", (w as any).iso_year).eq("week_number", (w as any).iso_week);
    const activeA = ((aw ?? []) as any[]).filter((r) => !r.cancelled_at).reduce((n, r) => n + (r.point_check || 0), 0);
    const points = (uwp as any)?.points ?? 0;
    ck(`uwp.points(${points}) >= 활성 award ΣA(${activeA}) — 평점 A 가 주차 Point A 에 포함`,
      points >= activeA, { userId: userId.slice(0, 8), points, activeA });
  }

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
