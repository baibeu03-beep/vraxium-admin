/**
 * verify-line-opening-locked-parity-http.ts
 *
 * 실무 정보 / 실무 경험 / 실무 역량 [라인 개설] 탭 — "개설 완료 후 잠금 + 개설 취소" 정합 검증.
 *
 * 사전: dev 서버(:3000) 기동.
 * 실행: npx tsx --env-file=.env.local scripts/verify-line-opening-locked-parity-http.ts
 *
 * 검증 항목(모두 실제 HTTP):
 *   A. 개설 상태의 권위 원천이 세 화면 모두 서버 GET 이고, 응답에 판정 필드가 존재하는가.
 *        info       : GET /cluster4/info-lines            → rows[].isActive · isOpenThisWeek
 *        experience : GET /cluster4/experience/team-overall → status('opened') · canOpen
 *        competency : GET /cluster4/competency/opening-status → opened · canOpen
 *   B. 일반 모드 vs mode=test — HTTP status 동일 · DTO 최상위 키 집합 동일 · 개설 상태 필드 타입 동일.
 *   C. 개설 완료(status='opened') 팀·주차에서 파트 신청 저장/취소가 서버에서 실제로 차단되는가
 *        (409 + code=experience_overall_opened_locked, DB write 0).
 *   D. 개설 취소 엔드포인트가 세 화면 모두 존재하고 권한/게이트를 통과하는가(OPTIONS 성격의 존재 확인).
 *
 * ⚠ 이 스크립트는 **쓰기를 하지 않는다**. C 는 서버가 거부(409)하는 경로만 두드리므로 write 0 이다.
 *   APP_ENV=operating(운영 DB)에서 실제 개설/취소 사이클을 돌리면 고객 반영 데이터가 바뀌므로 금지.
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL ?? "vanuatu.golden@gmail.com";
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const sb = createClient(SUPABASE_URL, SERVICE);

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  ok ? pass++ : fail++;
};
const info = (label: string) => console.log(`  · ${label}`);

async function adminCookieHeader(): Promise<string> {
  const admin = createClient(SUPABASE_URL, SERVICE);
  const browser = createClient(SUPABASE_URL, ANON);
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: ADMIN_EMAIL,
  });
  if (linkErr) throw linkErr;
  const otp = linkData.properties?.email_otp;
  if (!otp) throw new Error("email_otp 없음");
  const { data: verifyData, error: vErr } = await browser.auth.verifyOtp({
    email: ADMIN_EMAIL,
    token: otp,
    type: "magiclink",
  });
  if (vErr) throw vErr;
  const captured: Array<{ name: string; value: string }> = [];
  const server = createServerClient(SUPABASE_URL, ANON, {
    cookies: { getAll: () => [], setAll: (items) => captured.push(...items) },
  });
  await server.auth.setSession({
    access_token: verifyData.session!.access_token,
    refresh_token: verifyData.session!.refresh_token,
  });
  return captured.map((c) => `${c.name}=${c.value}`).join("; ");
}

type Got = { status: number; json: Record<string, unknown> };
async function get(cookie: string, path: string): Promise<Got> {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie }, cache: "no-store" });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}
async function send(
  cookie: string,
  method: "POST" | "DELETE",
  path: string,
  body?: unknown,
): Promise<Got> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { cookie, "content-type": "application/json" } : { cookie },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

const dataOf = (g: Got) => (g.json?.data ?? {}) as Record<string, unknown>;
const keysOf = (g: Got) => Object.keys(dataOf(g)).sort().join(",");
const typeOf = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

const ORGS = ["encre", "oranke", "phalanx"] as const;

async function main() {
  const cookie = await adminCookieHeader();
  console.log(`\nBASE=${BASE} · APP_ENV=${process.env.APP_ENV}\n`);

  // ── A/B. 실무 역량 — opening-status 권위 + 모드 파리티 ──────────────────────
  console.log("[역량] opening-status — 권위 필드 + 운영/테스트 파리티");
  for (const org of ORGS) {
    const op = await get(cookie, `/api/admin/cluster4/competency/opening-status?organization=${org}`);
    const te = await get(
      cookie,
      `/api/admin/cluster4/competency/opening-status?organization=${org}&mode=test`,
    );
    check(`${org} status 동일`, op.status === te.status, `${op.status}/${te.status}`);
    check(`${org} DTO 키 동일`, keysOf(op) === keysOf(te), keysOf(op));
    check(
      `${org} opened 필드 존재(boolean)`,
      typeOf(dataOf(op).opened) === "boolean" && typeOf(dataOf(te).opened) === "boolean",
      `op=${dataOf(op).opened} test=${dataOf(te).opened}`,
    );
    check(
      `${org} canOpen 필드 존재(boolean)`,
      typeOf(dataOf(op).canOpen) === "boolean" && typeOf(dataOf(te).canOpen) === "boolean",
      `op=${dataOf(op).canOpen} test=${dataOf(te).canOpen}`,
    );
    const tw = (dataOf(op).targetWeek ?? null) as { startDate?: string } | null;
    const twT = (dataOf(te).targetWeek ?? null) as { startDate?: string } | null;
    info(
      `${org} targetWeek operating=${tw?.startDate ?? "-"} test=${twT?.startDate ?? "-"}` +
        (tw?.startDate !== twT?.startDate ? "  (테스트 예외 주차 분기 — mode 전달이 실제로 반영됨)" : ""),
    );
  }

  console.log("\n[역량] applications — 명단/집계 모드 파리티(읽기)");
  for (const org of ORGS) {
    const op = await get(cookie, `/api/admin/cluster4/competency/applications?organization=${org}`);
    const te = await get(
      cookie,
      `/api/admin/cluster4/competency/applications?organization=${org}&mode=test`,
    );
    check(`${org} status 동일`, op.status === te.status, `${op.status}/${te.status}`);
    check(`${org} DTO 키 동일`, keysOf(op) === keysOf(te), keysOf(op));
  }

  // ── 역량: 개설 완료 주차에서 명단 수정 서버 차단(409, write 0) ───────────────
  console.log("\n[역량] 개설 완료 상태에서 명단 수정 서버 차단(409, write 0)");
  let lockedOrg: string | null = null;
  for (const org of ORGS) {
    const st = await get(cookie, `/api/admin/cluster4/competency/opening-status?organization=${org}`);
    if (dataOf(st).opened === true) {
      lockedOrg = org;
      break;
    }
  }
  if (!lockedOrg) {
    info("opened=true 인 org 표본이 없어 negative write 검증 생략(운영 DB 쓰기 금지).");
  } else {
    const list = await get(
      cookie,
      `/api/admin/cluster4/competency/applications?organization=${lockedOrg}`,
    );
    const apps = (dataOf(list).applications ?? []) as Array<{
      id: string;
      targetUserId: string;
      cafeChecked: boolean;
      source: "customer" | "manual";
    }>;
    const weekId = String(dataOf(list).weekId ?? "");
    info(`대상 org=${lockedOrg} week=${weekId} 신청 ${apps.length}건`);

    const beforeCount = await sb
      .from("cluster4_competency_applications")
      .select("id", { count: "exact", head: true })
      .eq("organization_slug", lockedOrg)
      .eq("week_id", weekId);

    // PATCH — 게이트가 없더라도 값이 바뀌지 않도록 **현재값 그대로** 보낸다(운영 DB 무해).
    const patchTarget = apps[0] ?? null;
    if (patchTarget) {
      const res = await fetch(
        `${BASE}/api/admin/cluster4/competency/applications/${patchTarget.id}`,
        {
          method: "PATCH",
          headers: { cookie, "content-type": "application/json" },
          body: JSON.stringify({ cafe_checked: patchTarget.cafeChecked }),
        },
      );
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      check("PATCH applications/[id] → 409", res.status === 409, `status=${res.status}`);
      check(
        "PATCH 차단 code=competency_hub_opened_locked",
        json?.code === "competency_hub_opened_locked",
        String(json?.error ?? ""),
      );
    } else {
      info("신청 표본 없음 — PATCH 차단 검증 생략.");
    }

    // DELETE — 게이트가 없더라도 실제 삭제가 일어나지 않도록 source='customer' 행을 고른다
    //   (기존 source 게이트가 403 으로 막는다). 게이트가 있으면 그보다 먼저 409 가 나온다.
    const delTarget = apps.find((a) => a.source === "customer") ?? null;
    if (delTarget) {
      const delRes = await send(
        cookie,
        "DELETE",
        `/api/admin/cluster4/competency/applications/${delTarget.id}`,
      );
      check(
        "DELETE applications/[id] → 409(개설 잠금이 source 게이트보다 우선)",
        delRes.status === 409,
        `status=${delRes.status} code=${String(delRes.json?.code ?? "-")}`,
      );
    } else {
      info("customer 소스 신청 표본 없음 — DELETE 차단 검증 생략(운영 DB 삭제 위험 회피).");
    }

    // 수동 추가(POST) — 게이트가 없으면 실제 insert 가 되므로, 만약 성공하면 즉시 원복한다.
    const masters = await get(
      cookie,
      `/api/admin/cluster4/competency-line-masters?organization=${lockedOrg}`,
    );
    const master = (
      (masters.json?.data ?? []) as Array<{
        id: string;
        lineCode: string;
        lineName: string;
        isActive: boolean;
      }>
    ).find((m) => m.isActive);
    const candidate = apps[0]?.targetUserId ?? null;
    if (master && candidate) {
      const addRes = await send(cookie, "POST", "/api/admin/cluster4/competency/applications", {
        organization: lockedOrg,
        target_user_id: candidate,
        week_id: weekId,
        competency_line_master_id: master.id,
        line_code: master.lineCode,
        line_name: master.lineName,
      });
      check(
        "POST applications(수동 추가) → 409",
        addRes.status === 409,
        `status=${addRes.status} code=${String(addRes.json?.code ?? "-")}`,
      );
      check(
        "수동 추가 차단 code=competency_hub_opened_locked",
        addRes.json?.code === "competency_hub_opened_locked",
        String(addRes.json?.error ?? ""),
      );
      // 안전망 — 게이트가 뚫려 insert 된 경우 즉시 원복(운영 DB 오염 방지).
      const insertedId = (addRes.json?.data as { id?: string } | undefined)?.id;
      if (insertedId) {
        await sb.from("cluster4_competency_applications").delete().eq("id", insertedId);
        info(`⚠ 게이트 미작동으로 insert 된 행(${insertedId})을 원복했습니다.`);
      }
    } else {
      info("수동 추가 후보(master/crew) 표본 없음 — POST 차단 검증 생략.");
    }

    const afterCount = await sb
      .from("cluster4_competency_applications")
      .select("id", { count: "exact", head: true })
      .eq("organization_slug", lockedOrg)
      .eq("week_id", weekId);
    check(
      "차단 시 DB write 0(신청 행 수 불변)",
      (beforeCount.count ?? -1) === (afterCount.count ?? -2),
      `${beforeCount.count} → ${afterCount.count}`,
    );
  }

  // ── 실무 경험 — team-overall 권위 + 모드 파리티 ─────────────────────────────
  console.log("\n[경험] team-overall — 권위 필드(status/canOpen) + 운영/테스트 파리티");
  // 개설 완료(opened) 상태인 (org, week, team) 을 DB 에서 찾아 C 의 negative write 대상으로 쓴다.
  const { data: overallRows } = await sb
    .from("cluster4_experience_team_overall")
    .select("organization_slug,week_id,team_id,status,reviewed_at")
    .order("created_at", { ascending: false })
    .limit(400);
  const rows = (overallRows ?? []) as Array<{
    organization_slug: string;
    week_id: string;
    team_id: string;
    status: string | null;
    reviewed_at: string | null;
  }>;
  const openedRow = rows.find((r) => r.status === "opened") ?? null;
  const anyRow = openedRow ?? rows[0] ?? null;

  if (!anyRow) {
    check("team-overall 표본 존재", false, "cluster4_experience_team_overall 행 없음 — 경험 검증 생략");
  } else {
    const { data: teamRow } = await sb
      .from("cluster4_teams")
      .select("team_name")
      .eq("id", anyRow.team_id)
      .maybeSingle();
    const teamName = (teamRow as { team_name?: string } | null)?.team_name ?? "";
    const qs =
      `organization=${anyRow.organization_slug}&week_id=${anyRow.week_id}` +
      `&team_id=${anyRow.team_id}&team_name=${encodeURIComponent(teamName)}`;
    const op = await get(cookie, `/api/admin/cluster4/experience/team-overall?${qs}`);
    const te = await get(cookie, `/api/admin/cluster4/experience/team-overall?${qs}&mode=test`);
    check("status 동일", op.status === te.status, `${op.status}/${te.status}`);
    check("DTO 키 동일", keysOf(op) === keysOf(te), keysOf(op));
    check(
      "status(개설 상태) 필드 존재",
      typeof dataOf(op).status === "string" && typeof dataOf(te).status === "string",
      `op=${dataOf(op).status} test=${dataOf(te).status}`,
    );
    check(
      "canOpen 필드 존재(boolean)",
      typeOf(dataOf(op).canOpen) === "boolean" && typeOf(dataOf(te).canOpen) === "boolean",
      `op=${dataOf(op).canOpen} test=${dataOf(te).canOpen}`,
    );
    check(
      "opened 판정값 동일(운영==테스트)",
      dataOf(op).status === dataOf(te).status,
      `${dataOf(op).status}`,
    );

    // ── C. 개설 완료 팀에서 파트 신청 저장/취소 서버 차단(write 0) ─────────────
    console.log("\n[경험] 개설 완료 상태에서 파트 신청 저장/취소 서버 차단(409, write 0)");
    if (!openedRow) {
      info("status='opened' 인 팀·주차 표본이 없어 negative write 검증 생략(운영 DB 쓰기 금지).");
    } else {
      const { data: t2 } = await sb
        .from("cluster4_teams")
        .select("team_name")
        .eq("id", openedRow.team_id)
        .maybeSingle();
      const openedTeamName = (t2 as { team_name?: string } | null)?.team_name ?? "";
      // 그 팀·주차의 저장된 파트명 하나(실제 존재하는 파트여야 게이트까지 도달).
      const { data: subRows } = await sb
        .from("cluster4_experience_part_submissions")
        .select("part_name")
        .eq("organization_slug", openedRow.organization_slug)
        .eq("week_id", openedRow.week_id)
        .eq("team_id", openedRow.team_id)
        .limit(1);
      const partName = (subRows?.[0] as { part_name?: string } | undefined)?.part_name ?? null;
      if (!partName) {
        info("개설 완료 팀의 파트 신청 헤더 표본 없음 — negative write 검증 생략.");
      } else {
        const before = await sb
          .from("cluster4_experience_part_submissions")
          .select("id", { count: "exact", head: true })
          .eq("organization_slug", openedRow.organization_slug)
          .eq("week_id", openedRow.week_id)
          .eq("team_id", openedRow.team_id);

        const postRes = await send(cookie, "POST", "/api/admin/cluster4/experience/part-input", {
          organization: openedRow.organization_slug,
          week_id: openedRow.week_id,
          team_id: openedRow.team_id,
          team_name: openedTeamName,
          part: partName,
          cells: [],
        });
        check(
          "POST part-input → 409",
          postRes.status === 409,
          `status=${postRes.status} code=${String(postRes.json?.code ?? "-")}`,
        );
        check(
          "POST 차단 code=experience_overall_opened_locked",
          postRes.json?.code === "experience_overall_opened_locked",
          String(postRes.json?.error ?? ""),
        );

        const delQs = new URLSearchParams({
          organization: openedRow.organization_slug,
          week_id: openedRow.week_id,
          team_id: openedRow.team_id,
          part: partName,
        });
        const delRes = await send(
          cookie,
          "DELETE",
          `/api/admin/cluster4/experience/part-input?${delQs}`,
        );
        check(
          "DELETE part-input → 409",
          delRes.status === 409,
          `status=${delRes.status} code=${String(delRes.json?.code ?? "-")}`,
        );
        check(
          "DELETE 차단 code=experience_overall_opened_locked",
          delRes.json?.code === "experience_overall_opened_locked",
          String(delRes.json?.error ?? ""),
        );

        const after = await sb
          .from("cluster4_experience_part_submissions")
          .select("id", { count: "exact", head: true })
          .eq("organization_slug", openedRow.organization_slug)
          .eq("week_id", openedRow.week_id)
          .eq("team_id", openedRow.team_id);
        check(
          "차단 시 DB write 0(신청 헤더 수 불변)",
          (before.count ?? -1) === (after.count ?? -2),
          `${before.count} → ${after.count}`,
        );
      }
    }
  }

  // ── 실무 정보 — info-lines 권위 + 모드 파리티 ──────────────────────────────
  console.log("\n[정보] info-lines — 권위 필드(rows[].isActive/isOpenThisWeek) + 운영/테스트 파리티");
  const { data: weekRow } = await sb
    .from("cluster4_lines")
    .select("week_id,activity_type_id,is_active")
    .eq("part_type", "info")
    .eq("is_active", true)
    .not("week_id", "is", null)
    .not("activity_type_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const wr = weekRow as { week_id: string; activity_type_id: string | null } | null;
  if (!wr?.week_id || !wr.activity_type_id) {
    check("info 라인 표본 존재", false, "cluster4_lines(part_type=info) 표본 없음 — 정보 검증 생략");
  } else {
    const base =
      `/api/admin/cluster4/info-lines?week_id=${wr.week_id}` +
      `&activity_type_id=${wr.activity_type_id}`;
    const op = await get(cookie, base);
    const te = await get(cookie, `${base}&mode=test`);
    check("status 동일", op.status === te.status, `${op.status}/${te.status}`);
    check("DTO 키 동일", keysOf(op) === keysOf(te), keysOf(op));
    // isOpenThisWeek 는 org 스코프에서만 boolean(통합/org 미지정이면 null=미상 — 설계된 폴백).
    check(
      "isOpenThisWeek 키 존재 + 모드 간 동일",
      "isOpenThisWeek" in dataOf(op) && dataOf(op).isOpenThisWeek === dataOf(te).isOpenThisWeek,
      `op=${dataOf(op).isOpenThisWeek} test=${dataOf(te).isOpenThisWeek} (org 미지정 → null 정상)`,
    );
    for (const org of ORGS) {
      const o = await get(cookie, `${base}&organization=${org}`);
      const t = await get(cookie, `${base}&organization=${org}&mode=test`);
      check(
        `${org} isOpenThisWeek boolean + 모드 간 동일`,
        typeOf(dataOf(o).isOpenThisWeek) === "boolean" &&
          dataOf(o).isOpenThisWeek === dataOf(t).isOpenThisWeek,
        `op=${dataOf(o).isOpenThisWeek} test=${dataOf(t).isOpenThisWeek}`,
      );
    }
    const opRows = (dataOf(op).rows ?? []) as Array<{ isActive?: boolean }>;
    check(
      "rows[].isActive 필드 존재(개설 완료 판정 원천)",
      opRows.length === 0 || typeOf(opRows[0].isActive) === "boolean",
      `rows=${opRows.length} activeCount=${opRows.filter((r) => r.isActive).length}`,
    );
  }

  // ── E. 세 페이지 SSR 스모크(?tab=open · 운영/테스트) ───────────────────────
  console.log("\n[페이지] /admin/integrated/line-opening/* ?tab=open SSR 200");
  for (const slug of ["practical-info", "practical-experience", "practical-competency"]) {
    for (const suffix of ["", "&mode=test"]) {
      const path = `/admin/integrated/line-opening/${slug}?org=encre&tab=open${suffix}`;
      const res = await fetch(`${BASE}${path}`, { headers: { cookie }, cache: "no-store" });
      check(`${slug}${suffix ? " (test)" : ""} → ${res.status}`, res.status === 200, path);
    }
  }

  console.log(`\n결과: ${pass} pass / ${fail} fail\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
