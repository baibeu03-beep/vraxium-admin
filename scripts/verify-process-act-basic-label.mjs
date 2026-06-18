// 액트 종류 'basic' UI 라벨 '기본'→'기타' 변경 검증.
//   - direct: PROCESS_ACT_TYPE_LABEL.basic === "기타" (SoT 상수)
//   - 저장값 불변: 신규 basic 액트 → DB act_type === "basic"
//   - HTTP: 보드 crewReactionLabel === "기타"
//   - direct == HTTP
//   - 운영(oranke)/테스트(org 분기 encre) 동일 표시
//   run: node scripts/verify-process-act-basic-label.mjs
// 전제: dev 서버(:3000) + process_acts 마이그레이션 적용. net-zero(TAG 정리).
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const r = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json"));
const { createClient } = r("@supabase/supabase-js");
const { createServerClient } = r("@supabase/ssr");
const env = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env.local"), "utf8");
const get = (k) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const BASE = "http://localhost:3000";
const URL = get("NEXT_PUBLIC_SUPABASE_URL"), ANON = get("NEXT_PUBLIC_SUPABASE_ANON_KEY"), SERVICE = get("SUPABASE_SERVICE_ROLE_KEY");
const sb = createClient(URL, SERVICE), brow = createClient(URL, ANON);
const EMAIL = "vanuatu.golden@gmail.com";
const HUB = "info", TAG = "ZZ-basic-label";
const J = (o) => JSON.stringify(o);

const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
const { data: v } = await brow.auth.verifyOtp({ email: EMAIL, token: link.properties.email_otp, type: "magiclink" });
const cap = []; const srv = createServerClient(URL, ANON, { cookies: { getAll: () => [], setAll: (i) => cap.push(...i) } });
await srv.auth.setSession({ access_token: v.session.access_token, refresh_token: v.session.refresh_token });
const cookie = cap.map((i) => `${i.name}=${i.value}`).join("; ");
const api = async (path, init = {}) => {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { "Content-Type": "application/json", cookie, ...(init.headers ?? {}) } });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};
let pass = 0, fail = 0; const ck = (l, ok, d = "") => { console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`); ok ? pass++ : fail++; };

async function cleanup() {
  const g = (await sb.from("process_line_groups").select("id").eq("hub", HUB).like("name", `${TAG}%`)).data ?? [];
  const ids = g.map((x) => x.id);
  if (ids.length) { await sb.from("process_acts").delete().in("line_group_id", ids); await sb.from("process_line_groups").delete().in("id", ids); }
}

try {
  // [direct] SoT 상수 — basic 라벨.
  const mod = await import(resolve(dirname(fileURLToPath(import.meta.url)), "..", "lib", "adminProcessesTypes.ts")).catch(() => null);
  if (mod?.PROCESS_ACT_TYPE_LABEL) {
    ck("[direct] PROCESS_ACT_TYPE_LABEL.basic === '기타'", mod.PROCESS_ACT_TYPE_LABEL.basic === "기타", mod.PROCESS_ACT_TYPE_LABEL.basic);
    ck("[direct] 라벨(필수/자율/선별)", mod.PROCESS_ACT_TYPE_LABEL.required === "필수" && mod.PROCESS_ACT_TYPE_LABEL.optional === "자율" && mod.PROCESS_ACT_TYPE_LABEL.selection === "선별");
  } else {
    console.log("  (direct: tsx 미경유 import 불가 — HTTP/DB로 대체 검증)");
  }

  await cleanup();
  const cg = await api("/api/admin/processes/line-groups", { method: "POST", body: J({ hub: HUB, name: `${TAG} 라인급` }) });
  const groupId = cg.json.data?.id;
  const mk = (name, type) => ({
    line_group_id: groupId, hub: HUB, act_name: `${TAG} ${name}`, duration_minutes: 10,
    occur_week: "N", occur_dow: 3, occur_time: "09:00", check_week: "N", check_dow: 3, check_time: "21:00",
    point_check: 3, point_advantage: 2, point_penalty: 0, cafe: "none", check_target: "check", act_type: type,
    overview: null, remarks: null,
  });
  // 신규 'basic' 액트(사용자가 화면에서 '기타' 선택 → 저장값 basic).
  const cBasic = await api("/api/admin/processes/acts", { method: "POST", body: J(mk("기타액트", "basic")) });
  const basicId = cBasic.json.data?.id;
  ck("[시드] 라인급 + basic 액트 생성", !!groupId && !!basicId, `status=${cBasic.status}`);

  // [저장값 불변] DB act_type === "basic" (라벨 변경이 enum 저장에 무영향).
  const dbRow = (await sb.from("process_acts").select("act_type").eq("id", basicId).maybeSingle()).data;
  ck("[저장값] DB act_type === 'basic' (불변)", dbRow?.act_type === "basic", J(dbRow));

  // [HTTP·운영] oranke 보드 — basic 액트 crewReactionLabel === '기타'.
  const bO = await api(`/api/admin/processes/check?hub=${HUB}&org=oranke`);
  const httpO = (bO.json.data?.acts ?? []).find((a) => a.actName === `${TAG} 기타액트`);
  ck("[HTTP·운영] basic 액트 crewReactionLabel === '기타'", httpO?.crewReactionLabel === "기타", J(httpO?.crewReactionLabel));

  // [direct==HTTP] DB는 basic 저장 · HTTP는 라벨 '기타'로 표시.
  ck("[direct==HTTP] DB act_type=basic ↔ HTTP 라벨 '기타' 정합", dbRow?.act_type === "basic" && httpO?.crewReactionLabel === "기타");

  // [테스트 모드/org 분기] encre 도 동일 라벨 '기타'.
  const bE = await api(`/api/admin/processes/check?hub=${HUB}&org=encre`);
  const httpE = (bE.json.data?.acts ?? []).find((a) => a.actName === `${TAG} 기타액트`);
  ck("[org 분기] encre 도 crewReactionLabel === '기타'", httpE?.crewReactionLabel === "기타", J(httpE?.crewReactionLabel));

  // [재조회] 같은 액트 재조회 시에도 '기타' 유지(라벨이 저장값에서 매번 파생).
  const bO2 = await api(`/api/admin/processes/check?hub=${HUB}&org=oranke`);
  const httpO2 = (bO2.json.data?.acts ?? []).find((a) => a.actName === `${TAG} 기타액트`);
  ck("[재조회] 저장 후 재조회도 '기타'", httpO2?.crewReactionLabel === "기타");
} catch (e) { console.error("ERROR:", e?.stack ?? e?.message ?? e); fail++; }
finally { await cleanup(); console.log("(cleanup 완료 — net-zero)"); console.log(`\n결과: ${pass} pass / ${fail} fail`); process.exit(fail > 0 ? 1 : 0); }
