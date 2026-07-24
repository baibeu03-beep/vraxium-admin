// 체크 로그 범위(scope_type) — direct==HTTP 읽기 검증(비변조·read-only).
//   run: npx tsx --env-file=.env.local scripts/verify-check-log-scope-http.ts
//   전제: admin dev(:3000). 데이터 무변조(GET 보드의 logs 만 비교).
//
//   검증: ① HTTP 보드 logs 가 scopeType 필드를 담는다 ② direct(listProcessCheckLogs)==HTTP
//        ③ scopeType 판정 규칙 정합(팀명 없으면 null · part 있으면 PART · 없으면 TEAM — 폴백 상태)
//        ④ 파트 전용 액트의 서로 다른 파트가 별개 로그(§6) ⑤ 일반/ test 모드 · 여러 org 동일 DTO(§11)
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { listProcessCheckLogs } from "@/lib/adminProcessCheckData";
import { resolveLogScopeDisplay } from "@/lib/adminProcessCheckTypes";

const BASE = "http://localhost:3000";
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(URL, SERVICE, { auth: { persistSession: false } });
const EMAIL = "vanuatu.golden@gmail.com";
const HUB = "experience";
const ORGS = ["oranke", "encre"];
const MODES = ["operating", "test"] as const;

let pass = 0,
  fail = 0;
const ck = (l: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  ok ? pass++ : fail++;
};

async function adminCookie(): Promise<string> {
  const brow = createClient(URL, ANON);
  const { data: link } = await sb.auth.admin.generateLink({ type: "magiclink", email: EMAIL });
  const { data: v } = await brow.auth.verifyOtp({
    email: EMAIL,
    token: link!.properties.email_otp,
    type: "magiclink",
  });
  const cap: { name: string; value: string }[] = [];
  const srv = createServerClient(URL, ANON, {
    cookies: { getAll: () => [], setAll: (items) => cap.push(...items) },
  });
  await srv.auth.setSession({
    access_token: v!.session!.access_token,
    refresh_token: v!.session!.refresh_token,
  });
  return cap.map((i) => `${i.name}=${i.value}`).join("; ");
}

let cookie = "";
const api = async (path: string) => {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", cookie },
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
};

// scopeType 폴백 판정 규칙(현재 마이그 미적용 상태) — 저장값 없으면 팀/파트 유무로 파생.
function expectScope(teamName: string | null, partName: string | null): "TEAM" | "PART" | null {
  if (!teamName) return null;
  return partName != null ? "PART" : "TEAM";
}

async function main() {
  cookie = await adminCookie();
  ck("admin 로그인(cookie 확보)", cookie.length > 0);

  for (const org of ORGS) {
    for (const mode of MODES) {
      const { status, json } = await api(
        `/api/admin/processes/check?hub=${HUB}&org=${org}&mode=${mode}`,
      );
      const okStatus = status === 200 && json?.success;
      ck(`[${org}/${mode}] GET 보드 200`, okStatus, `status=${status}`);
      if (!okStatus) continue;

      const httpLogs = (json.data?.logs ?? []) as Array<any>;
      const weekId = json.data?.week?.weekId ?? null;
      // direct — 같은 org/hub/week 로 listProcessCheckLogs 직접 호출.
      const directLogs = await listProcessCheckLogs(HUB, org, weekId);

      // ① scopeType 필드 존재
      const hasField = httpLogs.every((l) => "scopeType" in l);
      ck(`[${org}/${mode}] 모든 HTTP 로그에 scopeType 필드`, hasField, `n=${httpLogs.length}`);

      // ② direct==HTTP (id→scopeType/partName/teamName 동일)
      const dMap = new Map(directLogs.map((d) => [d.id, d]));
      let mism = 0;
      for (const l of httpLogs) {
        const d = dMap.get(l.id);
        if (!d) continue;
        if (
          d.scopeType !== l.scopeType ||
          (d.partName ?? null) !== (l.partName ?? null) ||
          (d.teamName ?? null) !== (l.teamName ?? null)
        )
          mism++;
      }
      ck(`[${org}/${mode}] direct==HTTP (scope/part/team 일치)`, mism === 0, `mismatch=${mism}`);

      // ③ scopeType 판정 규칙 정합
      let ruleBad = 0;
      for (const l of httpLogs) {
        if (l.scopeType !== expectScope(l.teamName ?? null, l.partName ?? null)) ruleBad++;
      }
      ck(`[${org}/${mode}] scopeType 판정 규칙 정합`, ruleBad === 0, `bad=${ruleBad}`);

      // ④ 파트 전용 로그의 서로 다른 파트 = 별개 로그(§6) — 같은 act 에 2개 이상 파트가 있으면 확인.
      const partByAct = new Map<string, Set<string>>();
      for (const l of httpLogs) {
        if (l.scopeType === "PART" && l.partName) {
          const key = `${l.actName}`;
          if (!partByAct.has(key)) partByAct.set(key, new Set());
          partByAct.get(key)!.add(l.partName);
        }
      }
      const multi = [...partByAct.entries()].filter(([, s]) => s.size >= 2);
      if (multi.length > 0) {
        ck(
          `[${org}/${mode}] 파트 전용 액트가 파트별 별개 로그`,
          true,
          multi.map(([a, s]) => `${a}:{${[...s].join(",")}}`).join(" · "),
        );
      }

      // ⑤ 표시 라벨 렌더 정합(비팀 로그는 none, 팀 로그는 라벨 존재)
      let dispBad = 0;
      for (const l of httpLogs) {
        const r = resolveLogScopeDisplay(l.scopeType, l.partName);
        if (l.teamName && r.kind === "none") dispBad++;
        if (!l.teamName && r.kind !== "none") dispBad++;
      }
      ck(`[${org}/${mode}] 표시 라벨(팀 유무↔범위 세그먼트) 정합`, dispBad === 0, `bad=${dispBad}`);
    }
  }

  // ── 로그가 풍부한 특정 주차 대상(§6 파트 독립·비어있지 않은 실데이터) ──
  const RICH: Array<{ org: string; week: string; mode: string }> = [
    { org: "phalanx", week: "39aae7a0-216f-4262-8a67-6beef1bccf22", mode: "test" },
    { org: "oranke", week: "496656d0-8d92-4738-b69b-e5e28aa1d57a", mode: "test" },
  ];
  for (const { org, week, mode } of RICH) {
    const { status, json } = await api(
      `/api/admin/processes/check?hub=${HUB}&org=${org}&mode=${mode}&week=${week}`,
    );
    const okStatus = status === 200 && json?.success;
    ck(`[${org} rich] GET 보드 200`, okStatus, `status=${status}`);
    if (!okStatus) continue;
    const httpLogs = (json.data?.logs ?? []) as Array<any>;
    const directLogs = await listProcessCheckLogs(HUB, org, week);
    ck(`[${org} rich] 로그 비어있지 않음`, httpLogs.length > 0, `n=${httpLogs.length}`);

    // direct==HTTP
    const dMap = new Map(directLogs.map((d) => [d.id, d]));
    let mism = 0;
    for (const l of httpLogs) {
      const d = dMap.get(l.id);
      if (!d) continue;
      if (d.scopeType !== l.scopeType || (d.partName ?? null) !== (l.partName ?? null)) mism++;
    }
    ck(`[${org} rich] direct==HTTP`, mism === 0, `mismatch=${mism}`);

    // scopeType 판정 규칙 정합
    let ruleBad = 0;
    for (const l of httpLogs)
      if (l.scopeType !== expectScope(l.teamName ?? null, l.partName ?? null)) ruleBad++;
    ck(`[${org} rich] scopeType 규칙 정합`, ruleBad === 0, `bad=${ruleBad}`);

    // §6 파트 독립 — 같은 act 에 ≥2 파트가 각각 별개 로그
    const partByAct = new Map<string, Set<string>>();
    for (const l of httpLogs) {
      if (l.scopeType === "PART" && l.partName) {
        if (!partByAct.has(l.actName)) partByAct.set(l.actName, new Set());
        partByAct.get(l.actName)!.add(l.partName);
      }
    }
    const multi = [...partByAct.entries()].filter(([, s]) => s.size >= 2);
    ck(`[${org} rich] 파트 전용 액트 = 파트별 별개 로그(§6)`, multi.length > 0,
      multi.map(([a, s]) => `${a}:{${[...s].join(",")}}`).join(" · ") || "복수파트 액트 없음");

    // 팀 총괄(TEAM) 로그도 함께 존재(팀 총괄 + 파트 혼재 렌더 확인)
    const teamOverall = httpLogs.filter((l) => l.scopeType === "TEAM");
    ck(`[${org} rich] 팀 총괄(TEAM) 로그 존재`, teamOverall.length > 0, `n=${teamOverall.length}`);

    // 샘플 렌더 3건 출력(팀명 + 배지 라벨)
    for (const l of httpLogs.slice(0, 3)) {
      const r = resolveLogScopeDisplay(l.scopeType, l.partName);
      console.log(`      · [${l.action}] ${l.teamName} 팀 [${r.label}] (${r.kind}) — ${l.actName}`);
    }
  }

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
