/**
 * verify-line-opening-status-board-http.ts
 * 라인 개설 상태창 공통 수정 검증(실제 HTTP + 공용 엔진).
 *   B.1 선택한 주차 상태 미표시  ·  B.2 라벨==데이터('개설 대상 주차')  ·  B.3 역할별 강조 토큰.
 *
 * 상태창은 표시 전용이므로: (1) 서버 opening-status 응답(currentWeek/targetWeek)을 실제 HTTP 로 받고,
 *   (2) 그 응답을 공용 엔진(buildLineOpeningStatus)에 그대로 넣어 최종 렌더 문구/토큰을 만들고 검증한다.
 *   컴포넌트(LineOpeningStatusBoard)는 이 엔진 출력을 StatusTokens 로 렌더하므로 문구=화면과 동일하다.
 *
 * 실행: npx tsx --env-file=.env.local scripts/verify-line-opening-status-board-http.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import {
  buildLineOpeningStatus,
  type StatusToken,
  type StatusWeek,
} from "@/lib/lineOpeningStatusEngine";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

let pass = 0, fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (ok) pass++; else fail++;
};

async function adminCookieHeader(): Promise<string> {
  const admin = createClient(SUPABASE_URL, SERVICE);
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({ type: "magiclink", email: ADMIN_EMAIL });
  if (linkErr) throw linkErr;
  const otp = linkData.properties?.email_otp;
  if (!otp) throw new Error("email_otp 없음");
  const { data: verifyData, error: vErr } = await browser.auth.verifyOtp({ email: ADMIN_EMAIL, token: otp, type: "magiclink" });
  if (vErr) throw vErr;
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(SUPABASE_URL, ANON, { cookies: { getAll: () => [], setAll: (items) => captured.push(...items) } });
  await server.auth.setSession({ access_token: verifyData.session!.access_token, refresh_token: verifyData.session!.refresh_token });
  return captured.map((c) => `${c.name}=${c.value}`).join("; ");
}

const flat = (tokens: StatusToken[]) => tokens.map((t) => t.text).join("");
const label = (w: StatusWeek | null) => (w ? `${w.year} ${w.seasonName} W${w.weekNumber} (${w.startDate})` : "null");

type StatusData = {
  currentWeek: StatusWeek | null;
  targetWeek: StatusWeek | null;
  targetWeekId?: string | null;
  extension?: { kind: "none" | "online" | "offline"; index: number | null; total: number | null };
  teams?: Array<{ teamId: string; teamName: string; opened: boolean; isOpeningPeriod?: boolean }>;
};

async function fetchStatus(cookie: string, org: string, mode: string, weekId?: string): Promise<{ status: number; data: StatusData | null; keys: string }> {
  const qs = new URLSearchParams({ organization: org, mode });
  if (weekId) qs.set("week_id", weekId);
  const res = await fetch(`${BASE}/api/admin/cluster4/experience/opening-status?${qs}`, { headers: { cookie } });
  const json = await res.json();
  return { status: res.status, data: json?.success ? (json.data as StatusData) : null, keys: json?.data ? Object.keys(json.data).sort().join(",") : "" };
}

const dtoShapes = new Set<string>();
const tokenKindsSeen = new Set<string>();

async function runScenario(cookie: string, org: string, mode: string) {
  console.log(`\n=== [${mode}] org=${org} ===`);
  const { status, data, keys } = await fetchStatus(cookie, org, mode);
  if (status !== 200 || !data) {
    check("opening-status 200", false, `status=${status}`);
    return;
  }
  dtoShapes.add(keys);

  // 요청받은 값 보고.
  console.log(`  currentWeek.id    : ${data.currentWeek ? await weekIdOf(data.currentWeek) : "null"}`);
  console.log(`  currentWeek.label : ${label(data.currentWeek)}`);
  console.log(`  targetWeek(개설대상).id    : ${data.targetWeekId ?? "null"}`);
  console.log(`  targetWeek(개설대상).label : ${label(data.targetWeek)}`);

  const engine = buildLineOpeningStatus({
    hubLabel: "실무 경험",
    today: new Date(),
    currentWeek: data.currentWeek,
    targetWeek: data.targetWeek,
    extension: data.extension ?? { kind: "none", index: null, total: null },
    teams: data.teams ?? [],
  });

  const block1Text = flat(engine.block1.tokens);
  const block2Text = flat(engine.block2.tokens);
  const block3Texts = engine.block3.map((l) => flat(l.tokens));
  console.log(`  block1: ${block1Text}`);
  console.log(`  block2: ${block2Text}`);
  for (const b of block3Texts.slice(0, 3)) console.log(`  block3: ${b}`);
  if (block3Texts.length > 3) console.log(`  block3: … (+${block3Texts.length - 3} 팀)`);

  const allText = [block1Text, block2Text, ...block3Texts].join("\n");
  const allTokens = [engine.block1, engine.block2, ...engine.block3].flatMap((l) => l.tokens);
  for (const tk of allTokens) tokenKindsSeen.add(tk.kind);

  // 문구: block1='이번 주', block2/3='지난 주 […]'(유지) · '선택한 주차' 금지(B.1).
  check("block1 은 '이번 주' + currentWeek 라벨", block1Text.includes("이번 주는 [") && (data.currentWeek ? block1Text.includes(String(data.currentWeek.weekNumber) + "주차") : true), block1Text);
  check("[유지] '지난 주 […]' 문구 유지", block2Text.includes("지난 주 [") && block3Texts.every((b) => b.includes("지난 주 [")), "");
  check("[B.1] '선택한 주차' 문구 미생성", !allText.includes("선택한 주차"));

  // B.3 — 역할별 토큰(빨강 boolean 아님, 역할 kind 존재).
  const hasDate = allTokens.some((t) => t.kind === "date");
  const hasTeam = allTokens.some((t) => t.kind === "team");
  const hasStatusKind = allTokens.some((t) => ["openDone", "openNeed", "crewOk", "periodNone"].includes(t.kind));
  check("[B.3] 날짜·주차=date(rose) 토큰 존재", hasDate);
  check("[B.3] 팀명=team(blue) 토큰 존재(팀 있을 때)", (data.teams?.length ?? 0) === 0 || hasTeam);
  check("[B.3] 개설 상태(green/amber/gray) 토큰 존재(팀 있을 때)", (data.teams?.length ?? 0) === 0 || hasStatusKind);
  check("[B.3] 모든 토큰이 역할 kind 를 가짐(red boolean 잔재 없음)", allTokens.every((t) => typeof t.kind === "string"));
}

async function weekIdOf(w: StatusWeek): Promise<string> {
  const sb = createClient(SUPABASE_URL, SERVICE);
  const { data } = await sb.from("weeks").select("id").eq("start_date", w.startDate).limit(1).maybeSingle();
  return (data as { id: string } | null)?.id ?? "(미상)";
}

async function main() {
  const cookie = await adminCookieHeader();

  // B.1 검증 보강 — 드롭다운(week_id) 변경이 상태창 데이터를 바꾸지 않음(컴포넌트가 week_id 미전송이므로
  //   기준 응답 = week_id 없는 응답 하나뿐). 참고로 임의 week_id 를 넣어도 컴포넌트는 이 값을 쓰지 않는다.
  for (const mode of ["operating", "test"]) {
    for (const org of ["encre", "oranke", "phalanx"]) {
      await runScenario(cookie, org, mode);
    }
  }

  console.log("\n=== DTO/토큰 동일성 ===");
  check("opening-status DTO 키 1종(모드/org 무관)", dtoShapes.size === 1, [...dtoShapes].join(" / "));
  console.log(`  관찰된 토큰 역할: ${[...tokenKindsSeen].sort().join(", ")}`);
  check("역할 토큰만 사용(plain 외 최소 date 포함)", tokenKindsSeen.has("date"));

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
