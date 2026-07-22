/**
 * 실무 정보 = **고정 9종** 제품 계약 검증 (direct / lib 레벨).
 *
 *   · 라인 유니버스는 어떤 조직·모드에서도 항상 9개
 *   · info 등록은 신규 activity_types 를 만들지 않는다
 *   · 활동유형 미선택/9종 외 값 → 422, 활동유형×조직 중복 → 409
 *   · 등록 원장의 정식 라인명/코드는 9종에 "연결"되어 표시된다(정본 name/FK 는 무변)
 *
 *   HTTP/DOM 은 scripts/browser-verify-info-line-registration-http.mjs / -render.mjs 담당.
 *
 *   Usage: npx tsx --env-file=.env.local scripts/verify-info-line-registration-flow.ts
 *          (검증용 등록행은 종료 시 항상 삭제 — --keep 으로 보존 가능.)
 */

import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  INFO_ACTIVITY_TYPE_IDS,
  listInfoLineCatalog,
} from "@/lib/adminInfoLineCatalog";
import {
  INFO_ACTIVITY_TYPE_ALREADY_REGISTERED,
  INFO_ACTIVITY_TYPE_REQUIRED,
  INFO_ALL_ACTIVITY_TYPES_REGISTERED,
  INFO_ALL_REGISTERED_MESSAGE,
  assertInfoRegistrationPolicy,
  isInfoScopeFullyRegistered,
  listInfoRegistrationSlots,
} from "@/lib/adminInfoLineRegistrationPolicy";
import { createLineRegistration } from "@/lib/adminLineRegistrationsData";
import { deriveLineConfigKey } from "@/lib/adminLinePointConfigsData";
import type { OrganizationSlug } from "@/lib/organizations";

const KEEP = process.argv.includes("--keep");
const ACTOR_ID = "c28b2409-4118-49fc-a42e-68e18dbd194c";
const ORGS: OrganizationSlug[] = ["encre", "oranke", "phalanx"];
const NINE = [...INFO_ACTIVITY_TYPE_IDS];

let fail = 0;
const ck = (label: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) fail += 1;
};

const STAMP = process.env.VERIFY_STAMP ?? String(Date.now()).slice(-6);

async function activityTypeCount(): Promise<number> {
  const { count } = await supabaseAdmin
    .from("activity_types")
    .select("*", { count: "exact", head: true })
    .eq("cluster_id", "practical_info");
  return count ?? 0;
}

async function main() {
  const createdRegistrations: string[] = [];

  try {
    // ── 1. 라인 유니버스는 항상 9개 ─────────────────────────────────────────
    console.log("\n[1] 라인 유니버스 = 고정 9종");
    const atBefore = await activityTypeCount();
    ck("activity_types(practical_info) 9행", atBefore === 9, `${atBefore}`);
    for (const org of [...ORGS, null]) {
      const rows = await listInfoLineCatalog(org);
      ck(
        `${org ?? "통합"}: 카탈로그 ${rows.length}개`,
        rows.length === 9,
        rows.map((r) => r.lineId).join(","),
      );
      ck(
        `${org ?? "통합"}: 표시 순서 정본`,
        JSON.stringify(rows.map((r) => r.lineId)) === JSON.stringify(NINE),
      );
    }

    // ── 2. 정본 라인명은 등록 원장으로 덮이지 않는다 ─────────────────────────
    console.log("\n[2] 정본 name 보존 + 등록 원장은 registeredLine* 로만");
    const encre = await listInfoLineCatalog("encre");
    const etc = encre.find((r) => r.lineId === "etc_a")!;
    ck("etc_a 표시명 = 정본 '기타A'", etc.lineName === "기타A", etc.lineName);
    ck("etc_a 등록 원장명 = '기타'(별도 필드)", etc.registeredLineName === "기타", String(etc.registeredLineName));
    ck(
      "9종 모두 등록 원장 코드 연결(IFBS-*)",
      encre.every((r) => (r.registeredLineCode ?? "").startsWith("IFBS-")),
      encre.map((r) => r.registeredLineCode).join(","),
    );

    // ── 3. 활동유형 필수 검증 ───────────────────────────────────────────────
    console.log("\n[3] 활동유형 필수(422)");
    for (const [label, value] of [
      ["미선택(null)", null],
      ["빈 문자열", "   "],
      ["9종 외 값", "info_made_up"],
      ["다른 클러스터 값", "comp-1"],
    ] as Array<[string, string | null]>) {
      // 미만석 범위(encre)로 검증한다 — common 은 9종 만석이라 만석 판정이 먼저 나온다.
      const v = await assertInfoRegistrationPolicy({
        pointActivityTypeId: value,
        organizationSlug: "encre",
      });
      ck(
        `${label} → 422 ${INFO_ACTIVITY_TYPE_REQUIRED}`,
        v?.status === 422 && v.code === INFO_ACTIVITY_TYPE_REQUIRED,
        JSON.stringify(v),
      );
    }

    // ── 4. 만석(409) · 활동유형 × 조직 중복(409) ────────────────────────────
    console.log("\n[4] 만석 · 활동유형×조직 중복");
    ck("common = 9종 만석", await isInfoScopeFullyRegistered("common"));
    ck("encre = 만석 아님", !(await isInfoScopeFullyRegistered("encre")));
    const full = await assertInfoRegistrationPolicy({
      pointActivityTypeId: "wisdom",
      organizationSlug: "common", // 9종 만석 범위
    });
    ck(
      `common 신규 등록 → 409 ${INFO_ALL_ACTIVITY_TYPES_REGISTERED}`,
      full?.status === 409 && full.code === INFO_ALL_ACTIVITY_TYPES_REGISTERED,
      JSON.stringify(full),
    );
    ck(
      "만석 문구 = 사유만",
      full?.message === INFO_ALL_REGISTERED_MESSAGE &&
        full.message ===
          "실무 정보 라인은 이미 9개 모두 등록되어 있습니다. 새로운 실무 정보 라인은 추가할 수 없습니다.",
      String(full?.message),
    );
    ck("만석 문구에 대안 안내 없음", !(full?.message ?? "").includes("수정해주세요"));
    // 수정(PATCH) 경로는 만석이어도 통과해야 한다 — 개별 중복만 판정한다.
    const dup = await assertInfoRegistrationPolicy({
      pointActivityTypeId: "wisdom",
      organizationSlug: "common",
      excludeRegistrationId: "00000000-0000-0000-0000-000000000000",
    });
    ck(
      "수정 경로(excludeId): 만석 통과 → 개별 중복 409",
      dup?.status === 409 && dup.code === INFO_ACTIVITY_TYPE_ALREADY_REGISTERED,
      JSON.stringify(dup),
    );
    const orgScoped = await assertInfoRegistrationPolicy({
      pointActivityTypeId: "wisdom",
      organizationSlug: "encre", // 다른 조직 범위 = 별개 슬롯(정책상 허용)
    });
    ck("encre/wisdom 은 별개 슬롯 → 통과", orgScoped === null, JSON.stringify(orgScoped));

    // ── 5. 슬롯 점유 현황(폼이 쓰는 것과 동일 기준) ─────────────────────────
    console.log("\n[5] 슬롯 점유 현황");
    const commonSlots = await listInfoRegistrationSlots("common");
    ck("common 슬롯 9개", commonSlots.length === 9);
    ck("common 9종 전부 점유", commonSlots.every((s) => s.registered));
    const encreSlots = await listInfoRegistrationSlots("encre");
    ck("encre 슬롯 9개 · 전부 미점유", encreSlots.length === 9 && encreSlots.every((s) => !s.registered));

    // ── 6. 정상 등록(조직 전용) — 유니버스는 그대로 9개 ─────────────────────
    console.log("\n[6] 정상 등록 → 9개 유지 · 신규 activity type 없음");
    const reg = await createLineRegistration(
      {
        lineName: `검증 앙크르 위즈덤 ${STAMP}`,
        hub: "info",
        lineType: "일반",
        lineCode: `IFVR-EC${STAMP}`,
        mainTitleMode: "variable",
        mainTitle: "-",
        unitLink: "-",
        estimatedDurationMinutes: 30,
        organizationSlug: "encre",
        partnerCompany: null,
        companyLogoUrl: null,
        managerName: null,
        managerPosition: null,
        managerJob: null,
        managerProfileKey: null,
        pointActivityTypeId: "wisdom",
      } as Parameters<typeof createLineRegistration>[0],
      ACTOR_ID,
    );
    createdRegistrations.push(reg.id);
    ck("등록 성공", Boolean(reg.id), `${reg.lineCode} → ${reg.pointActivityTypeId}`);

    const atAfter = await activityTypeCount();
    ck("activity_types 증가 없음(9행 유지)", atAfter === 9, `${atAfter}`);

    const encreAfter = await listInfoLineCatalog("encre");
    ck("encre 카탈로그 여전히 9개", encreAfter.length === 9, `${encreAfter.length}`);
    const wisdomEncre = encreAfter.find((r) => r.lineId === "wisdom")!;
    ck(
      "encre wisdom 에 조직 전용 등록명/코드 연결",
      wisdomEncre.registeredLineName === reg.lineName &&
        wisdomEncre.registeredLineCode === reg.lineCode,
      `${wisdomEncre.registeredLineName} / ${wisdomEncre.registeredLineCode}`,
    );
    ck("encre wisdom 표시명은 정본 '위즈덤' 유지", wisdomEncre.lineName === "위즈덤", wisdomEncre.lineName);

    const orankeAfter = await listInfoLineCatalog("oranke");
    const wisdomOranke = orankeAfter.find((r) => r.lineId === "wisdom")!;
    ck("oranke 는 common 등록명 유지(누수 없음)", wisdomOranke.registeredLineCode === "IFBS-NN0001", String(wisdomOranke.registeredLineCode));
    ck("oranke 카탈로그 9개", orankeAfter.length === 9);

    // 같은 조직에 같은 활동유형 재등록 → 409
    const again = await assertInfoRegistrationPolicy({
      pointActivityTypeId: "wisdom",
      organizationSlug: "encre",
    });
    ck("encre/wisdom 재등록 → 409", again?.status === 409, JSON.stringify(again));

    // ── 7. 포인트 config_key = 선택한 정본 활동유형 ─────────────────────────
    console.log("\n[7] 포인트 config_key");
    const derived = deriveLineConfigKey({
      hub: "info",
      lineType: reg.lineType,
      lineCode: reg.lineCode,
      infoActivityTypeId: reg.pointActivityTypeId,
    });
    ck("config_key = wisdom(정본)", derived?.configKey === "wisdom", String(derived?.configKey));

    // ── 8. 기존 9종 FK 비회귀 ──────────────────────────────────────────────
    console.log("\n[8] 기존 9종 비회귀");
    const { count: legacyLines } = await supabaseAdmin
      .from("cluster4_lines")
      .select("*", { count: "exact", head: true })
      .eq("part_type", "info")
      .in("activity_type_id", NINE);
    ck("기존 info 개설 라인 보존", (legacyLines ?? 0) > 0, `${legacyLines}건`);
    const { data: allInfoLines } = await supabaseAdmin
      .from("cluster4_lines")
      .select("activity_type_id")
      .eq("part_type", "info");
    const foreign = (allInfoLines ?? [])
      .map((l: { activity_type_id: string | null }) => l.activity_type_id)
      .filter((id): id is string => Boolean(id) && !NINE.includes(id));
    ck("9종 외 activity_type 을 쓰는 info 개설 라인 0건", foreign.length === 0, foreign.join(","));
  } finally {
    if (KEEP) {
      console.log(`\n[정리] --keep — 검증 등록행 유지: ${createdRegistrations.join(", ")}`);
    } else {
      for (const id of createdRegistrations) {
        await supabaseAdmin.from("line_registrations").delete().eq("id", id);
      }
      console.log("\n[정리] 검증용 등록행 삭제 완료");
      const at = await activityTypeCount();
      ck("정리 후 activity_types 9행", at === 9, `${at}`);
      for (const org of ORGS) {
        const rows = await listInfoLineCatalog(org);
        ck(`${org} 정리 후 카탈로그 9개`, rows.length === 9);
      }
    }
  }

  console.log(fail === 0 ? "\n✅ ALL PASS" : `\n❌ ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
