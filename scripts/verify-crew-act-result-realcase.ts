/**
 * 실제 사례(7행 전부 Point.C, 합 20) 라이브 HTTP 검증 — 크루 기준 액트 판정 수정.
 * ─────────────────────────────────────────────────────────────────────
 *   기대: available=7 · success=0 · fail=7 · pending=0 · rate=0 · 획득 화살 20/20 ·
 *         행별 결과 7개 전부 "체크 실패"(resultTone=fail).
 *   파리티: operating == mode=test == demoUserId(테스트유저) DTO byte-identical.
 *           크루 페이지 요약(snapshot actLogs → 공통 빌더) == 관리자 탭 요약.
 *
 *   선행: admin dev(:3000) 기동.
 *   ./node_modules/.bin/tsx.cmd --env-file=.env.local scripts/verify-crew-act-result-realcase.ts
 */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { readWeeklyCardsSnapshot } from "@/lib/cluster4WeeklyCardsSnapshot";
import {
  buildCrewActSummary,
  resolveCrewActKind,
  type CrewActSummaryRow,
} from "@/shared/crewActSummary";
import type { Cluster4ActLogDto, Cluster4WeeklyCardDto } from "@/shared/cluster4.contracts";
import type { CrewWeekActDetailDto } from "@/lib/adminCrewWeekActDetail";

const BASE = process.env.ADMIN_API_BASE_URL?.replace(/\/$/, "") || "http://localhost:3000";
const u = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const a = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const s = process.env.SUPABASE_SERVICE_ROLE_KEY!;

let pass = 0;
let fail = 0;
function check(n: string, ok: boolean, d?: unknown) {
  if (ok) pass++;
  else {
    fail++;
    console.log(`❌ ${n}${d !== undefined ? " :: " + JSON.stringify(d) : ""}`);
  }
}

async function adminCookie(): Promise<string> {
  const { data: adm } = await supabaseAdmin
    .from("admin_users").select("email").eq("is_active", true).not("email", "is", null).limit(1);
  const email = (adm?.[0] as { email: string } | undefined)?.email;
  if (!email) throw new Error("활성 관리자 없음");
  const A = createClient(u, s);
  const N = createClient(u, a);
  const { data: l } = await A.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await N.auth.verifyOtp({
    email, token: (l as { properties: { email_otp: string } }).properties.email_otp, type: "magiclink",
  });
  const cap: { name: string; value: string }[] = [];
  const sv = createServerClient(u, a, {
    cookies: { getAll: () => [], setAll: (items: { name: string; value: string }[]) => cap.push(...items) },
  });
  const sess = (v as { session: { access_token: string; refresh_token: string } }).session;
  await sv.auth.setSession({ access_token: sess.access_token, refresh_token: sess.refresh_token });
  return cap.map((c) => `${c.name}=${c.value}`).join("; ");
}

// 크루 페이지(Cluster4CardContent) 어댑터 재현 — card.actLogs → 요약 행(판정=공통 SoT).
function crewPageRows(actLogs: Cluster4ActLogDto[]): CrewActSummaryRow[] {
  return actLogs.map((x) => {
    const source: "regular" | "irregular" = x.source === "irregular" ? "irregular" : "regular";
    return {
      result: x.result === "checked" ? "checked" : "miss",
      source,
      kindKey: resolveCrewActKind(source, x.kind).key,
      pointA: x.pointA ?? 0, pointB: x.pointB ?? 0, pointC: x.pointC ?? 0,
    };
  });
}

async function fetchActs(cookie: string, userId: string, weekId: string, query = "") {
  const res = await fetch(`${BASE}/api/admin/members/${userId}/weeks/${weekId}/acts${query}`, {
    headers: { cookie }, cache: "no-store",
  });
  const json = (await res.json()) as { success?: boolean; data?: CrewWeekActDetailDto };
  return { status: res.status, data: json?.data };
}

async function main() {
  try {
    const h = await fetch(`${BASE}/api/health`);
    if (!h.ok) throw new Error("no health");
  } catch {
    console.log(`❌ admin dev 미기동(${BASE}).`);
    process.exit(2);
  }
  const cookie = await adminCookie();

  // 실제 사례 후보(7행 전부 C>0, 합20). 앞서 스캔한 사용자들.
  const realUsers = [
    "35c987bf-015f-482c-b966-63fe55af0256",
    "6678e364-68ad-4aa1-a531-79f62c2c166a",
    "b303c17e-26ec-429c-804e-f0d25c3f9463",
  ];
  const { data: markers } = await supabaseAdmin.from("test_user_markers").select("user_id");
  const testIds = new Set(((markers ?? []) as { user_id: string | null }[]).map((r) => r.user_id).filter(Boolean));

  let verifiedAny = false;
  for (const uid of realUsers) {
    const snap = await readWeeklyCardsSnapshot(uid);
    if (snap.status !== "hit" && snap.status !== "stale") { console.log(`· ${uid.slice(0,8)} snapshot ${snap.status} skip`); continue; }
    const cards = snap.cards as Cluster4WeeklyCardDto[];
    // 7행 전부 C>0 인 카드.
    const card = cards.find((c) => {
      const logs = c.actLogs ?? [];
      return logs.length === 7 && logs.every((l) => Math.abs(l.pointC ?? 0) > 0) && !!c.weekId;
    });
    if (!card) { console.log(`· ${uid.slice(0,8)} 7행-전부-C 카드 없음 skip`); continue; }
    verifiedAny = true;
    const tag = `${uid.slice(0, 8)}/${card.weekLabel ?? card.startDate}`;

    // (A) 크루 페이지 요약(공통 빌더)
    const crewSummary = buildCrewActSummary(crewPageRows(card.actLogs ?? []));
    check(`${tag} 크루 available=7`, crewSummary.total === 7, crewSummary.total);
    check(`${tag} 크루 success=0`, crewSummary.success === 0, crewSummary.success);
    check(`${tag} 크루 fail=7`, crewSummary.fail === 7, crewSummary.fail);
    check(`${tag} 크루 pending=0`, crewSummary.pending === 0, crewSummary.pending);
    check(`${tag} 크루 rate=0`, crewSummary.rate === 0, crewSummary.rate);
    check(`${tag} 크루 획득화살 20/20`, crewSummary.points.pointC.earned === 20 && crewSummary.points.pointC.available === 20, crewSummary.points.pointC);

    // (B) 관리자 탭 HTTP(operating)
    const op = await fetchActs(cookie, uid, card.weekId!);
    if (op.status !== 200 || !op.data) { check(`${tag} 관리자 acts 200`, false, { status: op.status }); continue; }
    const sm = op.data.summary;
    check(`${tag} 관리자 available=7`, sm.total === 7, sm.total);
    check(`${tag} 관리자 success=0`, sm.success === 0, sm.success);
    check(`${tag} 관리자 fail=7`, sm.fail === 7, sm.fail);
    check(`${tag} 관리자 pending=0`, sm.pending === 0, sm.pending);
    check(`${tag} 관리자 rate=0`, sm.rate === 0, sm.rate);
    check(`${tag} 관리자 획득화살 20/20`, sm.points.pointC.earned === 20 && sm.points.pointC.available === 20, sm.points.pointC);
    // 행별 결과 — 미취소 행 전부 "체크 실패"·tone=fail
    const live = op.data.acts.filter((r) => !r.cancelled);
    check(`${tag} 행 7개`, live.length === 7, live.length);
    check(`${tag} 행별 전부 '체크 실패'`, live.every((r) => r.resultLabel === "체크 실패"), live.map((r) => r.resultLabel));
    check(`${tag} 행별 전부 tone=fail`, live.every((r) => r.resultTone === "fail"), live.map((r) => r.resultTone));
    check(`${tag} '체크 성공' 행 0개`, live.filter((r) => r.resultLabel === "체크 성공").length === 0, true);

    // (C) 크루 == 관리자 요약 canonical JSON
    check(`${tag} 크루==관리자 요약 byte-identical`, JSON.stringify(crewSummary) === JSON.stringify(sm), { crew: crewSummary, admin: sm });

    // (D) 모드 파리티 — operating == mode=test == demoUserId
    const t = await fetchActs(cookie, uid, card.weekId!, "?mode=test");
    if (t.status === 200 && t.data) check(`${tag} operating==mode=test DTO`, JSON.stringify(t.data) === JSON.stringify(op.data), true);
    if (testIds.has(uid)) {
      const d = await fetchActs(cookie, uid, card.weekId!, `?demoUserId=${uid}`);
      if (d.status === 200 && d.data) check(`${tag} operating==demoUserId DTO`, JSON.stringify(d.data) === JSON.stringify(op.data), true);
      const dt = await fetchActs(cookie, uid, card.weekId!, `?demoUserId=${uid}&mode=test`);
      if (dt.status === 200 && dt.data) check(`${tag} operating==demo+test DTO`, JSON.stringify(dt.data) === JSON.stringify(op.data), true);
    }
    console.log(`✔ ${tag} 검증 완료 (C 합 ${sm.points.pointC.earned})`);
  }

  if (!verifiedAny) console.log("⚠ 실제 사례 카드 없음 — snapshot 재생성 필요할 수 있음");
  console.log(`\n═══ 실제사례 라이브 검증: PASS ${pass} · FAIL ${fail} ═══`);
  process.exit(fail > 0 || !verifiedAny ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
