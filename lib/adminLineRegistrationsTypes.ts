// Browser-safe constants and types for the /admin/lines/register registry APIs.
// Must not import server-only modules here.
//
// 정책 (2026-06-07 additive Phase):
//   - 신규 등록 라인만 line_registrations 에 저장한다.
//   - 기존 4허브 SoT(cluster4_lines · experience/competency 마스터 · career_projects)는
//     수정/이관하지 않는다 — 통합 SoT 전환은 별도 Phase.
//
// 유닛 링크 정정 (2026-06-07): output link/image 구조가 아니라 **단일 텍스트 필드**
//   unit_link 사용 (URL 형식 강제 없음, 미입력 시 '-'). DB 의 output_links/output_images
//   컬럼은 deprecated — 신규 저장/조회 모두 미사용 (마이그레이션 #39 참조).

// 소속 허브 — cluster4_lines.part_type 과 동일 enum (값 호환을 위해 동일 토큰 사용).
export type LineRegistrationHub = "info" | "experience" | "competency" | "career";

export const LINE_REGISTRATION_HUBS = [
  "info",
  "experience",
  "competency",
  "career",
] as const;

export const LINE_REGISTRATION_HUB_LABEL: Record<LineRegistrationHub, string> = {
  info: "실무 정보",
  experience: "실무 경험",
  competency: "실무 역량",
  career: "실무 경력",
};

// 허브별 라인 종류 옵션 (한글 라벨 그대로 저장 — DB CHECK 와 동일 목록).
export const LINE_REGISTRATION_LINE_TYPES: Record<LineRegistrationHub, readonly string[]> = {
  info: ["일반"],
  experience: ["도출", "분석", "평가", "관리", "확장"],
  competency: ["원리", "기술", "관점", "자원"],
  career: ["일반"],
};

// 프로필 사진 토큰 — DB(manager_profile_key) 저장값. 표시 이미지는 아래 매핑 참조.
export const LINE_REGISTRATION_PROFILE_KEYS = [
  "잔다르크",
  "툼 레이더",
  "미즈 마블",
  "토르",
  "아이언맨",
  "캡틴 아메리카",
] as const;

export type LineRegistrationProfileKey =
  (typeof LINE_REGISTRATION_PROFILE_KEYS)[number];

// 원형 미리보기 표시 보정값 — 원본이 전부 4:5 전신/상반신 포스터라 cover 만으로는
// 얼굴이 작게 잡힘. object-fit:cover 유지 + objectPosition(크롭 기준) +
// zoom/zoomOrigin(얼굴 중심 확대)으로 얼굴을 원 안에 크게 프레이밍한다.
// zoomOrigin 은 [0,100]% 범위 유지 — cover 상태에서 이 범위면 확대 후에도
// 이미지가 원형 영역을 항상 가득 채운다 (빈 틈/삐져나옴 없음).
export type LineRegistrationProfileImageEntry = {
  src: string;
  objectPosition: string;
  zoom: number;
  zoomOrigin: string;
};

// 프로필 토큰 → public 이미지 단일 매핑 (profileImageMap — 경로/보정값 하드코딩 금지,
// 신규 표시 지점은 반드시 이 객체/lineRegistrationProfileImage 를 통해 해석한다).
// 보정값은 2026-06-07 실제 이미지 6장 기준 브라우저 튜닝 결과.
export const LINE_REGISTRATION_PROFILE_IMAGE_MAP: Record<
  LineRegistrationProfileKey,
  LineRegistrationProfileImageEntry
> = {
  잔다르크: {
    src: "/Joan of Arc.png",
    objectPosition: "center 20%",
    zoom: 1.8,
    zoomOrigin: "58% 17%",
  },
  "툼 레이더": {
    src: "/Tomb Raider.png",
    objectPosition: "center 25%",
    zoom: 2.0,
    zoomOrigin: "50% 6%",
  },
  "미즈 마블": {
    src: "/Ms Marvel.png",
    objectPosition: "center 10%",
    zoom: 2.0,
    zoomOrigin: "40% 0%",
  },
  토르: {
    src: "/Thor.png",
    objectPosition: "center 15%",
    zoom: 2.1,
    zoomOrigin: "39% 0%",
  },
  아이언맨: {
    src: "/Iron Man.png",
    objectPosition: "center 5%",
    zoom: 2.4,
    zoomOrigin: "57% 0%",
  },
  "캡틴 아메리카": {
    src: "/Captain America.png",
    objectPosition: "center 5%",
    zoom: 2.1,
    zoomOrigin: "39% 0%",
  },
};

// DB 저장값(string | null) → 이미지 엔트리. 미선택/미등록 토큰은 null (placeholder 유지).
export function lineRegistrationProfileImage(
  key: string | null,
): LineRegistrationProfileImageEntry | null {
  if (!key) return null;
  return (
    (
      LINE_REGISTRATION_PROFILE_IMAGE_MAP as Record<
        string,
        LineRegistrationProfileImageEntry
      >
    )[key] ?? null
  );
}

// 소속 조직 — 허브 마스터의 organization_slug 도메인과 동일 (common = BS 공통).
// NULL(미지정) 등록은 허용하되 개설 브리지는 불가 (Phase 2C 결정).
export const LINE_REGISTRATION_ORGS = [
  "encre",
  "oranke",
  "phalanx",
  "common",
] as const;

export type LineRegistrationOrg = (typeof LINE_REGISTRATION_ORGS)[number];

export const LINE_REGISTRATION_ORG_LABEL: Record<LineRegistrationOrg, string> = {
  encre: "Encre",
  oranke: "Oranke",
  phalanx: "Phalanx",
  common: "공통",
};

export function isLineRegistrationOrg(value: unknown): value is LineRegistrationOrg {
  return (
    typeof value === "string" &&
    (LINE_REGISTRATION_ORGS as readonly string[]).includes(value)
  );
}

export type LineRegistrationMainTitleMode = "fixed" | "variable";

// 변동(variable) 모드일 때 DB 에 저장하는 메인 타이틀 sentinel.
export const VARIABLE_MAIN_TITLE_SENTINEL = "-";

// ── 메인 타이틀 종류 표시 정책 (2026-06-07) — 표시 SoT 는 허브 기준 ──
//   실무 정보/경력 = 변동(개설 때마다 작성 → 표시 '-') · 실무 경험/역량 = 고정(저장값 표시).
//   저장 컬럼 main_title_mode 는 입력 이력으로 보존(무수정) — 화면 표시는 허브 정책으로 계산.
//   2026-06-07 전수 점검: 기존 56행(experience 26·competency 30) 전부 fixed 로 정책과 일치.
export const HUB_MAIN_TITLE_MODE: Record<
  LineRegistrationHub,
  LineRegistrationMainTitleMode
> = {
  info: "variable",
  career: "variable",
  experience: "fixed",
  competency: "fixed",
};

export type LineRegistrationMainTitleDisplay = {
  mode: LineRegistrationMainTitleMode;
  modeLabel: "고정" | "변동";
  title: string;
};

// 허브 기준 표시값 계산 — variable 허브는 무조건 ("변동", "-"),
// fixed 허브는 ("고정", 저장된 main_title — 비어있으면 '-').
export function lineRegistrationDisplayMainTitle(
  hub: LineRegistrationHub,
  mainTitle: string | null,
): LineRegistrationMainTitleDisplay {
  const mode = HUB_MAIN_TITLE_MODE[hub];
  if (mode === "variable") {
    return { mode, modeLabel: "변동", title: VARIABLE_MAIN_TITLE_SENTINEL };
  }
  const title = mainTitle?.trim() ? mainTitle : VARIABLE_MAIN_TITLE_SENTINEL;
  return { mode, modeLabel: "고정", title };
}

// 변동 선택 시 입력칸 대신 노출하는 안내 문구.
export const VARIABLE_MAIN_TITLE_NOTICE =
  "고정된 메인 타이틀이 없으며, 개설 때 마다 입력하는 1차 정보가 됩니다.";

// 유닛 링크 미입력 시 DB 저장값.
export const EMPTY_UNIT_LINK_SENTINEL = "-";

export type LineRegistrationDto = {
  id: string;
  lineName: string;
  hub: LineRegistrationHub;
  hubLabel: string;
  lineType: string;
  lineCode: string;
  mainTitleMode: LineRegistrationMainTitleMode;
  mainTitle: string;
  // 유닛 링크 — 단일 텍스트 (URL 형식 강제 없음). 미입력이면 '-'.
  unitLink: string;
  // 소속 조직 — null = 미지정 (개설 브리지 불가).
  organizationSlug: LineRegistrationOrg | null;
  organizationLabel: string | null;
  // 브리지 추적 — find-or-create 된 허브 마스터(career 는 career_projects) id / 수행 시각.
  bridgedMasterId: string | null;
  bridgedAt: string | null;
  // career 전용 — 비career 허브는 전부 null.
  partnerCompany: string | null;
  companyLogoUrl: string | null;
  managerName: string | null;
  managerPosition: string | null;
  managerJob: string | null;
  managerProfileKey: string | null;
  isActive: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ListLineRegistrationsResult = {
  rows: LineRegistrationDto[];
  total: number;
  limit: number;
  offset: number;
};

export type LineRegistrationCreateInput = {
  lineName: string;
  hub: LineRegistrationHub;
  lineType: string;
  lineCode: string;
  mainTitleMode: LineRegistrationMainTitleMode;
  mainTitle: string;
  unitLink: string;
  organizationSlug: LineRegistrationOrg | null;
  partnerCompany: string | null;
  companyLogoUrl: string | null;
  managerName: string | null;
  managerPosition: string | null;
  managerJob: string | null;
  managerProfileKey: string | null;
};

// 관리 기능(2E-6 선행) PATCH 입력 — 부분 수정. hub/bridged_* 는 수정 불가(파서에서 거부).
// hub 의존 검증(line_type 조합, career 필드 허용, 개설 라인 게이트)은 데이터 레이어에서 수행.
export type LineRegistrationPatchInput = {
  lineName?: string;
  lineCode?: string;
  lineType?: string;
  // mode 가 오면 main_title 페어링 강제: variable → '-' / fixed → main_title 필수.
  mainTitleMode?: LineRegistrationMainTitleMode;
  mainTitle?: string;
  unitLink?: string;
  organizationSlug?: LineRegistrationOrg | null;
  partnerCompany?: string | null;
  companyLogoUrl?: string | null;
  managerName?: string | null;
  managerPosition?: string | null;
  managerJob?: string | null;
  managerProfileKey?: string | null;
  isActive?: boolean;
};

export type ParseBodyResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isLineRegistrationHub(value: unknown): value is LineRegistrationHub {
  return (
    typeof value === "string" &&
    (LINE_REGISTRATION_HUBS as readonly string[]).includes(value)
  );
}

function requiredText(
  raw: unknown,
  field: string,
): ParseBodyResult<string> {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, status: 400, error: `${field} is required` };
  }
  return { ok: true, value: raw.trim() };
}

function optionalText(raw: unknown, field: string): ParseBodyResult<string | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") {
    return { ok: false, status: 400, error: `${field} must be a string or null` };
  }
  const trimmed = raw.trim();
  return { ok: true, value: trimmed.length ? trimmed : null };
}

// POST /api/admin/lines/registrations body 파서.
//   - hub 필수 ("-" 미선택 상태는 400)
//   - line_type 은 허브별 허용 목록과 정확히 일치해야 함
//   - main_title_mode=fixed → main_title 필수 / variable → main_title 강제 "-"
//   - unit_link: 단일 텍스트(형식 강제 없음). 미입력/공백이면 "-" 저장.
//   - career 외 허브의 경력 전용 필드는 전부 null 로 강제 (입력이 와도 무시)
export function parseLineRegistrationCreateBody(
  body: unknown,
): ParseBodyResult<LineRegistrationCreateInput> {
  if (!isRecord(body)) {
    return { ok: false, status: 400, error: "Request body must be a JSON object" };
  }

  const lineName = requiredText(body.line_name, "line_name");
  if (!lineName.ok) return lineName;

  if (!isLineRegistrationHub(body.hub)) {
    return {
      ok: false,
      status: 400,
      error: "hub must be one of info|experience|competency|career (소속 허브를 선택해주세요)",
    };
  }
  const hub = body.hub;

  const lineType = requiredText(body.line_type, "line_type");
  if (!lineType.ok) return lineType;
  if (!LINE_REGISTRATION_LINE_TYPES[hub].includes(lineType.value)) {
    return {
      ok: false,
      status: 400,
      error: `line_type '${lineType.value}' 은(는) ${LINE_REGISTRATION_HUB_LABEL[hub]} 허브에서 선택할 수 없습니다`,
    };
  }

  const lineCode = requiredText(body.line_code, "line_code");
  if (!lineCode.ok) return lineCode;

  if (body.main_title_mode !== "fixed" && body.main_title_mode !== "variable") {
    return { ok: false, status: 400, error: "main_title_mode must be 'fixed' or 'variable'" };
  }
  const mainTitleMode = body.main_title_mode;
  let mainTitle: string;
  if (mainTitleMode === "variable") {
    mainTitle = VARIABLE_MAIN_TITLE_SENTINEL;
  } else {
    const parsed = requiredText(body.main_title, "main_title");
    if (!parsed.ok) return parsed;
    mainTitle = parsed.value;
  }

  // 유닛 링크 — 일반 텍스트 허용, 미입력/공백 → '-'.
  const unitLinkParsed = optionalText(body.unit_link, "unit_link");
  if (!unitLinkParsed.ok) return unitLinkParsed;
  const unitLink = unitLinkParsed.value ?? EMPTY_UNIT_LINK_SENTINEL;

  // 소속 조직 — 미지정(null) 허용. 지정 시 enum 검증 (브리지 가능 조건).
  const orgParsed = optionalText(body.organization_slug, "organization_slug");
  if (!orgParsed.ok) return orgParsed;
  if (orgParsed.value !== null && !isLineRegistrationOrg(orgParsed.value)) {
    return {
      ok: false,
      status: 400,
      error: "organization_slug must be one of encre|oranke|phalanx|common",
    };
  }
  const organizationSlug = orgParsed.value as LineRegistrationOrg | null;

  // career 전용 필드 — 비career 허브는 전부 null 강제.
  let partnerCompany: string | null = null;
  let companyLogoUrl: string | null = null;
  let managerName: string | null = null;
  let managerPosition: string | null = null;
  let managerJob: string | null = null;
  let managerProfileKey: string | null = null;
  if (hub === "career") {
    const pc = optionalText(body.partner_company, "partner_company");
    if (!pc.ok) return pc;
    partnerCompany = pc.value;
    const cl = optionalText(body.company_logo_url, "company_logo_url");
    if (!cl.ok) return cl;
    companyLogoUrl = cl.value;
    const mn = optionalText(body.manager_name, "manager_name");
    if (!mn.ok) return mn;
    managerName = mn.value;
    const mp = optionalText(body.manager_position, "manager_position");
    if (!mp.ok) return mp;
    managerPosition = mp.value;
    const mj = optionalText(body.manager_job, "manager_job");
    if (!mj.ok) return mj;
    managerJob = mj.value;
    const mk = optionalText(body.manager_profile_key, "manager_profile_key");
    if (!mk.ok) return mk;
    if (
      mk.value !== null &&
      !(LINE_REGISTRATION_PROFILE_KEYS as readonly string[]).includes(mk.value)
    ) {
      return {
        ok: false,
        status: 400,
        error: `manager_profile_key 는 ${LINE_REGISTRATION_PROFILE_KEYS.join("/")} 중 하나여야 합니다`,
      };
    }
    managerProfileKey = mk.value;
  }

  return {
    ok: true,
    value: {
      lineName: lineName.value,
      hub,
      lineType: lineType.value,
      lineCode: lineCode.value,
      mainTitleMode,
      mainTitle,
      unitLink,
      organizationSlug,
      partnerCompany,
      companyLogoUrl,
      managerName,
      managerPosition,
      managerJob,
      managerProfileKey,
    },
  };
}

// PATCH /api/admin/lines/registrations/[id] body 파서 (부분 수정).
//   - hub / bridged_master_id / bridged_at 수정 시도는 400.
//   - main_title_mode 가 오면 페어링 강제: variable → main_title '-' 고정 / fixed → main_title 필수.
//   - main_title 만 오면(모드 미변경) fixed 행에서의 값 수정으로 해석 — 데이터 레이어에서 모드 확인.
//   - organization_slug: enum 검증. null 허용 여부(bridged 행 금지)는 데이터 레이어에서.
export function parseLineRegistrationPatchBody(
  body: unknown,
): ParseBodyResult<LineRegistrationPatchInput> {
  if (!isRecord(body)) {
    return { ok: false, status: 400, error: "Request body must be a JSON object" };
  }
  for (const forbidden of ["hub", "bridged_master_id", "bridged_at"]) {
    if (body[forbidden] !== undefined) {
      return { ok: false, status: 400, error: `${forbidden} 는 수정할 수 없습니다` };
    }
  }

  const patch: LineRegistrationPatchInput = {};

  if (body.line_name !== undefined) {
    const r = requiredText(body.line_name, "line_name");
    if (!r.ok) return r;
    patch.lineName = r.value;
  }
  if (body.line_code !== undefined) {
    const r = requiredText(body.line_code, "line_code");
    if (!r.ok) return r;
    patch.lineCode = r.value;
  }
  if (body.line_type !== undefined) {
    const r = requiredText(body.line_type, "line_type");
    if (!r.ok) return r;
    patch.lineType = r.value;
  }

  if (body.main_title_mode !== undefined) {
    if (body.main_title_mode !== "fixed" && body.main_title_mode !== "variable") {
      return { ok: false, status: 400, error: "main_title_mode must be 'fixed' or 'variable'" };
    }
    patch.mainTitleMode = body.main_title_mode;
    if (body.main_title_mode === "variable") {
      patch.mainTitle = VARIABLE_MAIN_TITLE_SENTINEL;
    } else {
      const r = requiredText(body.main_title, "main_title");
      if (!r.ok) return r;
      patch.mainTitle = r.value;
    }
  } else if (body.main_title !== undefined) {
    const r = requiredText(body.main_title, "main_title");
    if (!r.ok) return r;
    patch.mainTitle = r.value;
  }

  if (body.unit_link !== undefined) {
    const r = optionalText(body.unit_link, "unit_link");
    if (!r.ok) return r;
    patch.unitLink = r.value ?? EMPTY_UNIT_LINK_SENTINEL;
  }

  if (body.organization_slug !== undefined) {
    const r = optionalText(body.organization_slug, "organization_slug");
    if (!r.ok) return r;
    if (r.value !== null && !isLineRegistrationOrg(r.value)) {
      return {
        ok: false,
        status: 400,
        error: "organization_slug must be one of encre|oranke|phalanx|common",
      };
    }
    patch.organizationSlug = r.value as LineRegistrationOrg | null;
  }

  for (const [bodyKey, patchKey] of [
    ["partner_company", "partnerCompany"],
    ["company_logo_url", "companyLogoUrl"],
    ["manager_name", "managerName"],
    ["manager_position", "managerPosition"],
    ["manager_job", "managerJob"],
  ] as const) {
    if (body[bodyKey] !== undefined) {
      const r = optionalText(body[bodyKey], bodyKey);
      if (!r.ok) return r;
      patch[patchKey] = r.value;
    }
  }
  if (body.manager_profile_key !== undefined) {
    const r = optionalText(body.manager_profile_key, "manager_profile_key");
    if (!r.ok) return r;
    if (
      r.value !== null &&
      !(LINE_REGISTRATION_PROFILE_KEYS as readonly string[]).includes(r.value)
    ) {
      return {
        ok: false,
        status: 400,
        error: `manager_profile_key 는 ${LINE_REGISTRATION_PROFILE_KEYS.join("/")} 중 하나여야 합니다`,
      };
    }
    patch.managerProfileKey = r.value;
  }

  if (body.is_active !== undefined) {
    if (typeof body.is_active !== "boolean") {
      return { ok: false, status: 400, error: "is_active must be a boolean" };
    }
    patch.isActive = body.is_active;
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, status: 400, error: "Request body must include at least one writable field" };
  }
  return { ok: true, value: patch };
}
