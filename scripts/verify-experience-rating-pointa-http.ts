/**
 * [실 HTTP] 실무 경험 평점 Point A 정책 — 일반 모드 == mode=test 파리티 + DTO 계약 검증.
 *
 *   dev server 필요. run:
 *     BASE=http://localhost:3012 node_modules/.bin/tsx --env-file=.env.local \
 *       scripts/verify-experience-rating-pointa-http.ts
 *
 * 검증 항목(§8):
 *   · HTTP 상태 코드
 *   · DTO 키/필드 타입
 *   · 팀별 오픈 셀 → preview minimalA/diligentB/N 반영
 *   · 일반 모드 vs mode=test vs actAsTestUserId vs demoUserId 응답 동일 여부
 *   · 저장값(latch) 과 preview 산식 동일성 — 같은 config 를 넣으면 같은 A/B/N 이 나오는가
 *   · 관리·확장 셀 토글이 A/B/N 을 바꾸지 않는가(주차 기준 제외)
 *   · 도출/분석/견문 셀 1칸 토글이 (강화포인트+4)/(강화포인트+7) 만큼만 움직이는가
 *
 * write 없음 — recognition-preview(POST)는 계산만 하고 저장하지 않는다.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- 검증 스크립트: 외부 API 응답을 그대로 훑는다. */
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { ORGANIZATIONS } from "@/lib/organizations";

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
    .from("admin_users")
    .select("email")
    .eq("is_active", true)
    .not("email", "is", null)
    .limit(1);
  const email = (adm?.[0] as { email: string } | undefined)?.email;
  if (!email) throw new Error("활성 관리자 계정을 찾지 못했습니다.");
  const A = createClient(u, s);
  const N = createClient(u, a);
  const { data: l } = await A.auth.admin.generateLink({ type: "magiclink", email });
  const { data: v } = await N.auth.verifyOtp({
    email,
    token: (l as any).properties.email_otp,
    type: "magiclink",
  });
  const cap: Array<{ name: string; value: string }> = [];
  const sv = createServerClient(u, a, {
    cookies: { getAll: () => [], setAll: (it: any[]) => cap.push(...it.map(({ name, value }) => ({ name, value }))) },
  });
  await sv.auth.setSession({
    access_token: (v as any).session.access_token,
    refresh_token: (v as any).session.refresh_token,
  });
  console.log(`admin = ${email}`);
  return cap.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function post(path: string, cookie: string, body: unknown) {
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  let json: any = null;
  try { json = await r.json(); } catch { /* non-json */ }
  return { status: r.status, json };
}
async function get(path: string, cookie: string) {
  const r = await fetch(`${BASE}${path}`, { headers: { cookie }, cache: "no-store" });
  let json: any = null;
  try { json = await r.json(); } catch { /* non-json */ }
  return { status: r.status, json };
}

const previewPath = (weekId: string, org: string, q = "") =>
  `/api/admin/team-parts/info/weeks/${weekId}/recognition-preview?club=${org}${q}`;

async function main() {
  const cookie = await cookieHeader();

  const { data: cfgRows } = await supabaseAdmin
    .from("cluster4_week_opening_configs")
    .select("week_id, organization_slug, config, min_points_a, exec_points_b, recognition_count_n")
    .eq("open_confirmed", true)
    .not("recognition_count_n", "is", null);
  const targets = ((cfgRows ?? []) as any[]).filter((r) =>
    (ORGANIZATIONS as readonly string[]).includes(r.organization_slug),
  );
  const { data: wkRows } = await supabaseAdmin
    .from("weeks")
    .select("id, season_key, week_number")
    .in("id", [...new Set(targets.map((t) => t.week_id))]);
  const label = new Map(((wkRows ?? []) as any[]).map((w) => [w.id, `${w.season_key} W${w.week_number}`]));

  // 조직별 experience 포인트 설정(강화 시 포인트) — 예상 델타 계산용.
  const { data: pcRows } = await supabaseAdmin
    .from("cluster4_line_point_configs")
    .select("organization_slug,config_key,point_a,point_b")
    .eq("hub", "experience");
  const cfgPt = new Map<string, { a: number; b: number }>();
  for (const r of (pcRows ?? []) as any[]) {
    cfgPt.set(`${r.organization_slug}:${r.config_key}`, { a: r.point_a ?? 0, b: r.point_b ?? 0 });
  }
  const enh = (org: string, key: string) => {
    const v = cfgPt.get(`${org}:${key}`) ?? cfgPt.get(`common:${key}`) ?? { a: 0, b: 0 };
    return Math.max(0, v.a) + Math.max(0, v.b);
  };

  console.log(`\n대상 (주차 × 조직) ${targets.length}건 · BASE=${BASE}\n`);
  console.log("─".repeat(110));

  for (const t of targets) {
    const org = t.organization_slug as string;
    const wk = t.week_id as string;
    const name = `${org} ${label.get(wk) ?? wk}`;
    const config = t.config ?? {};

    // ── (1) 기본 preview — 200 + DTO 계약 ────────────────────────────────────
    const base = await post(previewPath(wk, org), cookie, { config });
    ck(`${name} · preview 200`, base.status === 200, { status: base.status });
    if (base.status !== 200) continue;
    const d = base.json?.data;
    const shapeOk =
      base.json?.success === true &&
      typeof d?.featureAvailable === "boolean" &&
      typeof d?.minPointsA === "number" &&
      typeof d?.execPointsB === "number" &&
      (d?.recognitionCountN === null || typeof d?.recognitionCountN === "number") &&
      Array.isArray(d?.missing);
    ck(`${name} · DTO 키/타입 계약`, shapeOk, {
      keys: Object.keys(d ?? {}),
      types: {
        featureAvailable: typeof d?.featureAvailable,
        minPointsA: typeof d?.minPointsA,
        execPointsB: typeof d?.execPointsB,
        recognitionCountN: d?.recognitionCountN === null ? "null" : typeof d?.recognitionCountN,
        missing: Array.isArray(d?.missing) ? "array" : typeof d?.missing,
      },
    });
    ck(`${name} · N = round(A + 0.4×(B−A))`,
      d.recognitionCountN === Math.round(d.minPointsA + 0.4 * (d.execPointsB - d.minPointsA)),
      { A: d.minPointsA, B: d.execPointsB, N: d.recognitionCountN });
    ck(`${name} · B ≥ A`, d.execPointsB >= d.minPointsA, { A: d.minPointsA, B: d.execPointsB });

    // ── (2) 모드 파리티 — 일반 / mode=test / actAsTestUserId / demoUserId ─────
    const variants: Array<[string, string]> = [
      ["mode=test", "&mode=test"],
      ["actAsTestUserId", "&mode=test&actAsTestUserId=00000000-0000-0000-0000-000000000001"],
      ["demoUserId", "&demoUserId=00000000-0000-0000-0000-000000000002"],
    ];
    for (const [vname, q] of variants) {
      const v = await post(previewPath(wk, org, q), cookie, { config });
      const same =
        v.status === base.status && JSON.stringify(v.json?.data) === JSON.stringify(d);
      ck(`${name} · 일반 == ${vname}`, same, same ? undefined : { base: d, [vname]: v.json?.data });
    }

    // ── (3) 관리·확장 토글은 A/B/N 무영향 ────────────────────────────────────
    const exp = (config.practicalExperience ?? {}) as Record<string, Record<string, boolean>>;
    const teamIds = Object.keys(exp);
    if (teamIds.length > 0) {
      const flipAll = (type: string, val: boolean) => ({
        ...config,
        practicalExperience: Object.fromEntries(
          teamIds.map((tid) => [tid, { ...(exp[tid] ?? {}), [type]: val }]),
        ),
      });
      for (const excluded of ["management", "expansion"]) {
        const on = await post(previewPath(wk, org), cookie, { config: flipAll(excluded, true) });
        const off = await post(previewPath(wk, org), cookie, { config: flipAll(excluded, false) });
        const same =
          on.json?.data?.minPointsA === off.json?.data?.minPointsA &&
          on.json?.data?.execPointsB === off.json?.data?.execPointsB &&
          on.json?.data?.recognitionCountN === off.json?.data?.recognitionCountN;
        ck(`${name} · ${excluded === "management" ? "관리" : "확장"} 전체 토글 → A/B/N 불변`, same, {
          on: [on.json?.data?.minPointsA, on.json?.data?.execPointsB, on.json?.data?.recognitionCountN],
          off: [off.json?.data?.minPointsA, off.json?.data?.execPointsB, off.json?.data?.recognitionCountN],
        });
      }

      // ── (4) 도출·분석·견문 셀 1칸 해제 → 정확히 (강화포인트+4)/(강화포인트+7) 감소 ──
      for (const type of ["derive", "analysis", "research"]) {
        const target = teamIds.find((tid) => exp[tid]?.[type] === true);
        if (!target) continue;
        const off1 = {
          ...config,
          practicalExperience: { ...exp, [target]: { ...(exp[target] ?? {}), [type]: false } },
        };
        const r = await post(previewPath(wk, org), cookie, { config: off1 });
        const p = enh(org, type);
        const dA = d.minPointsA - (r.json?.data?.minPointsA ?? 0);
        const dB = d.execPointsB - (r.json?.data?.execPointsB ?? 0);
        ck(`${name} · ${type} 1칸 해제 → ΔA=${p}+4=${p + 4} · ΔB=${p}+7=${p + 7}`,
          dA === p + 4 && dB === p + 7, { dA, dB, 강화포인트: p });
      }
    }

    // ── (5) 화면 GET DTO 도 모드 무관 동일(weekRecognitionCount latch) ────────
    const g1 = await get(`/api/admin/team-parts/info/weeks/${wk}?club=${org}`, cookie);
    const g2 = await get(`/api/admin/team-parts/info/weeks/${wk}?club=${org}&mode=test`, cookie);
    ck(`${name} · 상세 GET 200 (일반·test)`, g1.status === 200 && g2.status === 200, {
      normal: g1.status, test: g2.status,
    });
    const n1 = g1.json?.data?.managedWeek?.weekRecognitionCount;
    const n2 = g2.json?.data?.managedWeek?.weekRecognitionCount;
    ck(`${name} · 저장된 N 은 모드 무관 동일(latch)`, n1 === n2, { normal: n1, test: n2 });
    ck(`${name} · 저장 N == DB latch(공표 snapshot 을 live 로 덮지 않음)`,
      n1 === t.recognition_count_n, { http: n1, db: t.recognition_count_n });
    console.log("─".repeat(110));
  }

  console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
