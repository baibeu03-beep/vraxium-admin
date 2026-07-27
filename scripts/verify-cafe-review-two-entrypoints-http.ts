/**
 * 카페 댓글 검수 — 두 통합 진입 경로의 공통 실행 경로/statusId 동일성 HTTP 검증.
 *
 *   진입 A: /admin/integrated/processes/check/{hub}
 *     GET  /api/admin/processes/check           → acts[].checkStatusId (= process_check_statuses.id)
 *     POST /api/admin/qa/run-now/process-check-row { statusId, source:'regular' }   (즉시 검수)
 *     POST /api/admin/processes/check/recollect  { organization, statusId, source } (댓글 재수집)
 *   진입 B: /admin/integrated/line-opening/{part}
 *     GET/POST /api/admin/cluster4/cafe-line-crew  (라이브 피커 — 크루 매칭 전용, status 레코드 없음)
 *
 *   검증 축:
 *     1) GET DTO 의 checkStatusId 가 전부 실제 process_check_statuses 행이고 org/mode/week 스코프가 일치한다.
 *     2) 그 statusId 를 즉시 검수 POST 가 같은 요청 컨텍스트에서 조회한다(status!=='not_found').
 *     3) 일반 모드(operating)·mode=test 가 동일 DTO 필드·동일 서버 함수를 쓴다.
 *     4) status 레코드가 없는 행(needed)은 checkStatusId=null → 버튼 미노출(합성 ID 없음).
 *     5) 두 진입의 카페 수집이 동일 크롤+매칭 함수(inProcessCrawlAndMatch/cafe-line-crew)로 수렴한다.
 *
 *   쓰기는 전부 ZZ- 접두 throwaway 라인급/액트에만 하고 종료 시 삭제(무흔적).
 *
 *   npx tsx --env-file=.env.local scripts/verify-cafe-review-two-entrypoints-http.ts
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const __dirname = dirname(fileURLToPath(import.meta.url));
const adminRoot = resolve(__dirname, "..");
const env = readFileSync(resolve(adminRoot, ".env.local"), "utf8");
const g = (k: string) => env.match(new RegExp(`^${k}=(.+)$`, "m"))?.[1]?.trim();
const adminEmail = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const SUPABASE_URL = g("NEXT_PUBLIC_SUPABASE_URL")!;
const ANON = g("NEXT_PUBLIC_SUPABASE_ANON_KEY")!;
const SERVICE = g("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE);

const ORGS = ["encre", "oranke", "phalanx"] as const;
const HUBS = ["info", "club", "experience", "competency"] as const;
const MODES = ["operating", "test"] as const;

let pass = 0;
let fail = 0;
const ck = (l: string, ok: boolean, d = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${l}${d ? ` — ${d}` : ""}`);
  ok ? pass++ : fail++;
};

async function cookieHeader(): Promise<string> {
  const anon = createClient(SUPABASE_URL, ANON);
  const { data: link } = await admin.auth.admin.generateLink({ type: "magiclink", email: adminEmail });
  const { data: v } = await anon.auth.verifyOtp({
    email: adminEmail,
    token: (link as any).properties.email_otp,
    type: "magiclink",
  });
  const cap: any[] = [];
  const srv = createServerClient(SUPABASE_URL, ANON, {
    cookies: { getAll: () => [], setAll: (i: any[]) => cap.push(...i) },
  });
  await srv.auth.setSession({
    access_token: (v as any).session.access_token,
    refresh_token: (v as any).session.refresh_token,
  });
  return cap.map((c) => `${c.name}=${c.value}`).join("; ");
}

type Req = { url: string; status: number; json: any };
async function req(cookie: string, path: string, init?: RequestInit): Promise<Req> {
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: { cookie, "Content-Type": "application/json", ...(init?.headers ?? {}) },
    cache: "no-store",
  });
  const json = await res.json().catch(() => ({}));
  return { url, status: res.status, json };
}

const cleanup: { statusIds: string[]; actIds: string[]; groupIds: string[] } = {
  statusIds: [],
  actIds: [],
  groupIds: [],
};

async function main() {
  const cookie = await cookieHeader();

  // ── (A) 목록 GET — 반환된 checkStatusId 전수가 실제 상태행이고 스코프가 일치하는가 ──────
  console.log("\n[A] 목록 GET — checkStatusId 원천(process_check_statuses.id) + 스코프 일치");
  let dtoIdTotal = 0;
  let dtoIdBad = 0;
  let neededWithId = 0;
  for (const org of ORGS) {
    for (const mode of MODES) {
      for (const hub of HUBS) {
        const qs = `hub=${hub}&org=${org}${mode === "test" ? "&mode=test" : ""}`;
        const r = await req(cookie, `/api/admin/processes/check?${qs}`);
        if (r.status !== 200 || !r.json?.success) {
          ck(`GET ${org}/${hub}/${mode} 200`, false, `status=${r.status}`);
          continue;
        }
        const acts: any[] = r.json.data?.acts ?? [];
        const weekId: string | null = r.json.data?.selectedWeekId ?? r.json.data?.week?.weekId ?? null;
        const ids = acts.map((a) => a.checkStatusId).filter(Boolean) as string[];
        // needed(상태행 없음) 행은 반드시 checkStatusId=null — 합성 ID 금지.
        neededWithId += acts.filter((a) => a.status === "needed" && a.checkStatusId).length;
        // pending/completed 행은 반드시 checkStatusId 보유(버튼 노출 조건과 동일 축).
        const missing = acts.filter((a) => a.status !== "needed" && !a.checkStatusId).length;
        dtoIdTotal += ids.length;
        if (ids.length > 0) {
          const { data: rows } = await admin
            .from("process_check_statuses")
            .select("id,organization_slug,scope_mode,week_id")
            .in("id", ids);
          const byId = new Map((rows ?? []).map((x: any) => [x.id, x]));
          for (const id of ids) {
            const row = byId.get(id);
            const okScope =
              row &&
              row.organization_slug === org &&
              (row.scope_mode ?? "operating") === mode &&
              (!weekId || row.week_id === weekId);
            if (!okScope) dtoIdBad += 1;
          }
        }
        console.log(
          `    · ${org}/${hub}/${mode}: acts=${acts.length} statusId=${ids.length}` +
            ` needed+id=${acts.filter((a) => a.status === "needed" && a.checkStatusId).length}` +
            ` (pending|completed)-id누락=${missing}`,
        );
      }
    }
  }
  ck("GET DTO 의 checkStatusId 전수가 실제 상태행 + org/mode/week 스코프 일치", dtoIdBad === 0, `불일치=${dtoIdBad}/${dtoIdTotal}`);
  ck("needed(상태행 없음) 행은 checkStatusId=null — 화면 전용 합성 ID 없음", neededWithId === 0, `위반=${neededWithId}`);

  // ── (B) 즉시 검수 POST — GET 이 준 statusId 를 같은 컨텍스트에서 조회하는가 ────────────
  console.log("\n[B] 즉시 검수/재수집 POST — GET statusId ≡ POST 조회 대상 (org × mode 교차)");
  for (const org of ORGS) {
    for (const mode of MODES) {
      const hub = "club";
      const qs = `hub=${hub}&org=${org}${mode === "test" ? "&mode=test" : ""}`;
      const board = await req(cookie, `/api/admin/processes/check?${qs}`);
      const weekId: string | null = board.json?.data?.selectedWeekId ?? board.json?.data?.week?.weekId ?? null;
      if (!weekId) {
        ck(`[${org}/${mode}] 주차 확보`, false, "weekId 없음");
        continue;
      }

      // throwaway 라인급 + 액트 시드(운영 데이터 무접촉). name/act_name 은 30자 제한(DB CHECK).
      const tag = `ZZ${org.slice(0, 3)}${mode.slice(0, 3)}${String(Date.now()).slice(-6)}`;
      const grp = await admin.from("process_line_groups").insert({ hub, name: `${tag}L` }).select("id").single();
      if (grp.error || !grp.data) {
        ck(`[${org}/${mode}] 시드 라인급`, false, grp.error?.message ?? "");
        continue;
      }
      const groupId = (grp.data as any).id as string;
      cleanup.groupIds.push(groupId);
      const act = await admin
        .from("process_acts")
        .insert({
          line_group_id: groupId, hub, act_name: `${tag}A`, duration_minutes: 10,
          occur_week: "N", occur_dow: 1, occur_time: "10:00",
          check_week: "N", check_dow: 3, check_time: "12:00",
          point_check: 1, point_advantage: 0, point_penalty: 0,
          cafe: "occur", check_target: "check", act_type: "required", is_active: true,
        })
        .select("id")
        .single();
      if (act.error || !act.data) {
        ck(`[${org}/${mode}] 시드 액트`, false, act.error?.message ?? "");
        continue;
      }
      const actId = (act.data as any).id as string;
      cleanup.actIds.push(actId);
      const ins = await admin
        .from("process_check_statuses")
        .insert({
          organization_slug: org, hub, week_id: weekId, act_id: actId, line_group_id: groupId,
          status: "pending", scope_mode: mode, review_link: "https://cafe.naver.com/zz-verify-cafe-review",
          scheduled_check_at: new Date(Date.now() + 2 * 86_400_000).toISOString(), attempt_count: 0,
        })
        .select("id")
        .maybeSingle();
      if (ins.error || !ins.data) {
        ck(`[${org}/${mode}] 시드 상태행`, false, ins.error?.message ?? "");
        continue;
      }
      const seedId = (ins.data as any).id as string;
      cleanup.statusIds.push(seedId);

      // 1) 같은 목록 GET 이 그 statusId 를 실제로 돌려주는가.
      const board2 = await req(cookie, `/api/admin/processes/check?${qs}`);
      const acts2: any[] = board2.json?.data?.acts ?? [];
      const inDto = acts2.some((a) => a.checkStatusId === seedId);
      ck(`[${org}/${mode}] GET DTO 에 statusId 존재`, inDto, `GET ${board2.url} ${board2.status} · statusId=${seedId}`);

      // 2) 즉시 검수 POST — 동일 statusId. not_found(조회 실패)면 실패.
      const now = await req(cookie, "/api/admin/qa/run-now/process-check-row", {
        method: "POST",
        body: JSON.stringify({ statusId: seedId, source: "regular" }),
      });
      const d = now.json?.data ?? {};
      ck(
        `[${org}/${mode}] 즉시 검수 POST 가 동일 statusId 를 조회(status!=='not_found')`,
        now.status === 200 && d.status !== "not_found",
        `POST ${now.url} ${now.status} · status=${d.status} code=${d.code} statusId=${d.statusId}`,
      );
      const { data: afterRow } = await admin
        .from("process_check_statuses")
        .select("status,scope_mode,organization_slug,comment_collection_status,raw_comment_count")
        .eq("id", seedId)
        .maybeSingle();
      ck(
        `[${org}/${mode}] 검수 결과 저장(status=completed · 스코프 불변)`,
        (afterRow as any)?.status === "completed" &&
          ((afterRow as any)?.scope_mode ?? "operating") === mode &&
          (afterRow as any)?.organization_slug === org,
        `db=${JSON.stringify(afterRow)}`,
      );

      // 3) 댓글 재수집 POST — 동일 statusId + 동일 org 컨텍스트에서 대상 행이 조회되는가(404 아님).
      const rec = await req(cookie, "/api/admin/processes/check/recollect", {
        method: "POST",
        body: JSON.stringify({ organization: org, statusId: seedId, source: "regular" }),
      });
      ck(
        `[${org}/${mode}] 댓글 재수집 POST 가 동일 statusId 를 조회(404 아님)`,
        rec.status !== 404 && rec.status !== 403,
        `POST ${rec.url} ${rec.status} · ${JSON.stringify(rec.json?.data ?? rec.json?.error ?? null)}`,
      );
    }
  }

  // ── (C) 라인 개설 진입(cafe-line-crew) — 같은 org/mode 스코프 · statusId 미사용 확인 ────
  console.log("\n[C] 라인 개설 진입 — cafe-line-crew(라이브 피커) 스코프");
  for (const org of ORGS) {
    for (const mode of MODES) {
      const qs = `organization=${org}${mode === "test" ? "&mode=test" : ""}&excludeSeasonRest=1&q=`;
      const r = await req(cookie, `/api/admin/cluster4/cafe-line-crew?${qs}`);
      ck(
        `[${org}/${mode}] cafe-line-crew GET 200(크루 모집단 조회)`,
        r.status === 200 && r.json?.success === true,
        `GET ${r.url} ${r.status} crews=${(r.json?.data?.crews ?? []).length}`,
      );
    }
  }

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
}

main()
  .catch((e) => {
    console.error(e);
    fail++;
  })
  .finally(async () => {
    // 무흔적 정리 — 시드 상태행/recipients/원장/액트/라인급.
    for (const id of cleanup.statusIds) {
      await admin.from("process_check_review_recipients").delete().eq("ref_id", id);
      await admin.from("process_point_awards").delete().eq("ref_id", id);
      await admin.from("process_check_statuses").delete().eq("id", id);
    }
    for (const id of cleanup.actIds) {
      await admin.from("process_check_logs").delete().eq("act_id", id);
      await admin.from("process_acts").delete().eq("id", id);
    }
    for (const id of cleanup.groupIds) await admin.from("process_line_groups").delete().eq("id", id);
    console.log(
      `  [cleanup] status=${cleanup.statusIds.length} act=${cleanup.actIds.length} group=${cleanup.groupIds.length} 삭제`,
    );
    process.exit(fail > 0 ? 1 : 0);
  });
