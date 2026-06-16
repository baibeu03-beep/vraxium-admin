// 공통 수정 direct-function 검증 (env 불요 — 순수 함수만).
//   1) 아웃풋 링크 설명 ≤30 / 이미지 캡션 ≤20 (parse + form builder)
//   2) 실무 경험 관리(management) 자격 — 파트장/에이전트만, 일반 차단
//   3) line_code 형식 가드 (공백/특수문자 거부, "IF99A - NR0007" 차단)
//   4) edit-windows 작성항목 순서 — 실무 경험이 실무 역량보다 위
// 사용법: npx tsx scripts/verify-admin-common-fixes.ts
import {
  OUTPUT_LINK_LABEL_MAX_LENGTH,
  parseOutputLinksInput,
  buildOutputLinksFromForm,
} from "../lib/cluster4OutputLinks";
import {
  OUTPUT_IMAGE_CAPTION_MAX_LENGTH,
  parseOutputImagesInput,
  buildOutputImages,
} from "../lib/cluster4OutputImages";
import { canEditOverallManagement } from "../lib/experienceTeamOverallTypes";
import { parseLineRegistrationCreateBody } from "../lib/adminLineRegistrationsTypes";
import { EDITABLE_RESOURCES } from "../lib/adminEditWindowsTypes";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

console.log("\n[1] 아웃풋 링크 설명 ≤30");
check("상수=30", OUTPUT_LINK_LABEL_MAX_LENGTH === 30);
{
  const ok = parseOutputLinksInput([{ url: "https://a.com", label: "가".repeat(30) }]);
  check("30자 통과", ok.ok === true);
  const bad = parseOutputLinksInput([{ url: "https://a.com", label: "가".repeat(31) }]);
  check("31자 거부", bad.ok === false, JSON.stringify(bad));
  const form = buildOutputLinksFromForm([{ url: "https://a.com", label: "가".repeat(31) }]);
  check("form builder 31자 거부", form.ok === false, JSON.stringify(form));
  const formOk = buildOutputLinksFromForm([{ url: "https://a.com", label: "가".repeat(30) }]);
  check("form builder 30자 통과", formOk.ok === true);
}

console.log("\n[2] 아웃풋 이미지 캡션 ≤20");
check("상수=20", OUTPUT_IMAGE_CAPTION_MAX_LENGTH === 20);
{
  const ok = parseOutputImagesInput([{ url: "https://a.com/x.png", caption: "가".repeat(20) }]);
  check("20자 통과", ok.ok === true);
  const bad = parseOutputImagesInput([{ url: "https://a.com/x.png", caption: "가".repeat(21) }]);
  check("21자 거부", bad.ok === false, JSON.stringify(bad));
  let threw = false;
  try {
    buildOutputImages([{ url: "https://a.com/x.png", caption: "가".repeat(21) }]);
  } catch {
    threw = true;
  }
  check("buildOutputImages 21자 throw", threw);
}

console.log("\n[3] 실무 경험 관리(management) 자격");
check("파트장 허용", canEditOverallManagement({ statusLabel: "파트장", isPartLeader: true }) === true);
check("에이전트 허용", canEditOverallManagement({ statusLabel: "에이전트", isPartLeader: false }) === true);
check("일반 차단", canEditOverallManagement({ statusLabel: "일반", isPartLeader: false }) === false);
check("미상 라벨 차단(fail-closed)", canEditOverallManagement({ statusLabel: "크루", isPartLeader: false }) === false);

console.log("\n[4] line_code 형식 가드");
function makeBody(code: string) {
  return {
    line_name: "테스트 라인",
    hub: "info",
    line_type: "정보", // info 허용 line_type 중 하나여야 하므로 아래에서 실제값으로 교체
    line_code: code,
    main_title_mode: "variable",
    main_title: "-",
    organization_slug: "common",
  };
}
// info 허브 허용 line_type 을 동적으로 확보(검증 목적 — line_code 만 보는 테스트라 hub/type 통과 필요).
import { LINE_REGISTRATION_LINE_TYPES } from "../lib/adminLineRegistrationsTypes";
const infoType = LINE_REGISTRATION_LINE_TYPES.info[0];
{
  const good = parseLineRegistrationCreateBody({ ...makeBody("IFBS-NN0007"), line_type: infoType });
  check("정상 코드 통과", good.ok === true, JSON.stringify(good));
  const spaced = parseLineRegistrationCreateBody({ ...makeBody("IF99A - NR0007"), line_type: infoType });
  check("'IF99A - NR0007' 거부", spaced.ok === false && spaced.status === 400, JSON.stringify(spaced));
  const special = parseLineRegistrationCreateBody({ ...makeBody("IF@BS#NN"), line_type: infoType });
  check("특수문자 거부", special.ok === false, JSON.stringify(special));
  const legacy = parseLineRegistrationCreateBody({ ...makeBody("EXUL-1781413747360"), line_type: infoType });
  check("레거시 타임스탬프 코드 통과(오탐 없음)", legacy.ok === true, JSON.stringify(legacy));
}

console.log("\n[5] edit-windows 작성항목 순서 (실무 경험 > 실무 역량)");
{
  const exp = EDITABLE_RESOURCES.find((r) => r.key === "cluster4.work_exp");
  const abil = EDITABLE_RESOURCES.find((r) => r.key === "cluster4.work_ability");
  check("두 항목 존재", Boolean(exp && abil));
  check(
    "실무 경험 order < 실무 역량 order",
    Boolean(exp && abil && exp.order < abil.order),
    `exp=${exp?.order} abil=${abil?.order}`,
  );
}

console.log(`\n결과: pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
