"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Save, Trash2, X } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  WORK_INFO_ACTIVITY_TYPE_IDS,
  classifyActivityType,
  type ActivityTypeClusterMap,
  type UserActivityDetailRow,
  type UserActivityModalKey,
  type UserActivityOutputLink,
} from "@/lib/userActivityDetailsTypes";
import {
  CAREER_ENHANCEMENT_STATUSES,
  CAREER_GRADES,
  type CareerEnhancementStatus,
  type CareerGrade,
  type CareerRecordRow,
} from "@/lib/careerRecordsTypes";
import type {
  Cluster4Bundle,
  Cluster4DeleteResource,
  Cluster4PatchBody,
} from "@/lib/adminCluster4Types";
import {
  evaluateCluster4HubEdit,
  modalKeyToPartType,
  partTypeToEditWindowResourceKey,
  type Cluster4HubEditDecision,
} from "@/lib/cluster4LinePermission";
import type { Cluster4LinePartType } from "@/lib/cluster4LinesTypes";

// 4개 모달(Work Info / Work Ability / Work Exp / Work Career) 을 묶는 활동 탭.
// 부모(Cluster4Editor) 의 bundle 을 받아 자체 form state 를 유지하고, 저장/삭제 시
// /api/admin/crews/[id]/cluster4 PATCH/DELETE 를 호출한 뒤 응답 bundle 로 부모를 갱신.
//
// (2026-05-22) 신규: 비어있는 상태에서도 admin 이 새 row 를 생성할 수 있도록 각
// sub-modal 에 "새 항목 추가" 버튼 + draft row 편집 UI 추가. draft 는 synthetic id
// (`__draft_*`) 로 React key 관리하며, build*PatchInput 에서 null 로 변환되어 server
// upsert (id 미지정) 경로로 라우팅된다. server 측 upsert 는 user_activity_details 의
// 경우 (user_id, week_id, activity_type_id) UNIQUE, career_records 의 경우
// (user_id, week_id, project_id) scope 로 idempotent insert 동작.

type Props = {
  bundle: Cluster4Bundle;
  legacyUserId: string;
  weekLabels: Map<string, string>;
  saveDisabled: boolean;
  onBundleUpdate: (next: Cluster4Bundle) => void;
  onBanner: (banner: { kind: "success" | "error"; message: string } | null) => void;
  devMode: boolean;
};

type ActivityFormRow = {
  id: string;
  user_id: string;
  week_id: string;
  activity_type_id: string;
  sub_title: string;
  growth_point: string;
  output_links_json: string; // JSON text — admin power-user 입력
  image_urls_json: string; // JSON text — string[]
  image_captions_json: string; // JSON text — string[]
  rating: string; // string for input, "" = null
  modal: UserActivityModalKey;
};

type CareerFormRow = {
  id: string;
  user_id: string;
  week_id: string;
  project_id: string;
  enhancement_status: string; // "" = null
  grade: string; // "" = null
  grade_points: string;
  career_code: string;
  project: CareerRecordRow["project"];
};

const SUB_TABS: { key: UserActivityModalKey | "work_career"; label: string }[] = [
  { key: "work_info", label: "Work Info" },
  { key: "work_exp", label: "Work Exp" },
  { key: "work_ability", label: "Work Ability" },
  { key: "work_career", label: "Work Career" },
];

const ACTIVITY_MODAL_LABEL: Record<UserActivityModalKey, string> = {
  work_info: "Work Info",
  work_ability: "Work Ability",
  work_exp: "Work Exp",
  work_career: "Work Career",
};

// ───────────── draft helpers ─────────────

const DRAFT_PREFIX = "__draft_";
const draftIdActivity = (modal: UserActivityModalKey) =>
  `${DRAFT_PREFIX}activity_${modal}`;
const DRAFT_ID_CAREER = `${DRAFT_PREFIX}career`;
const isDraftId = (id: string) => id.startsWith(DRAFT_PREFIX);

function createEmptyActivityDraft(
  modal: UserActivityModalKey,
  userId: string,
): ActivityFormRow {
  // Work Info 는 fixed 목록 첫 값, 그 외는 빈 문자열로 두고 입력 강제.
  const defaultActivityType = modal === "work_info" ? "wisdom" : "";
  return {
    id: draftIdActivity(modal),
    user_id: userId,
    week_id: "",
    activity_type_id: defaultActivityType,
    sub_title: "",
    growth_point: "",
    output_links_json: "[]",
    image_urls_json: "[]",
    image_captions_json: "[]",
    rating: "",
    modal,
  };
}

function createEmptyCareerDraft(userId: string): CareerFormRow {
  return {
    id: DRAFT_ID_CAREER,
    user_id: userId,
    week_id: "",
    project_id: "",
    enhancement_status: "",
    grade: "",
    grade_points: "",
    career_code: "",
    project: null,
  };
}

// Draft 의 activity_type_id 가 의도한 modal 과 일치하는지 사전 차단.
// 분류 우선순위: (1) Work Info 고정 ID 목록 (2) activity_types.cluster_id lookup
// (3) Legacy prefix (comp-/exp-/car-). cluster map 이 있으면 lookup 결과로
// 검증하고, 없거나 매칭 실패 시 prefix 규칙으로 폴백.
function validateDraftActivityType(
  modal: UserActivityModalKey,
  activityTypeId: string,
  clusterMap: ActivityTypeClusterMap,
): string | null {
  const trimmed = activityTypeId.trim();
  if (!trimmed) return "activity_type_id 를 입력해 주세요.";
  if (modal === "work_info") {
    if (!(WORK_INFO_ACTIVITY_TYPE_IDS as readonly string[]).includes(trimmed)) {
      return `Work Info activity_type_id 는 다음 중 하나여야 합니다: ${WORK_INFO_ACTIVITY_TYPE_IDS.join(", ")}.`;
    }
    return null;
  }
  const classified = classifyActivityType(trimmed, clusterMap);
  if (classified === modal) return null;
  if (modal === "work_ability") {
    return "Work Ability 의 activity_type_id 는 activity_types 에 cluster_id='practical_competency' 로 등록돼 있거나 'comp-' 로 시작해야 합니다.";
  }
  if (modal === "work_exp") {
    return "Work Exp 의 activity_type_id 는 activity_types 에 cluster_id='practical_experience' 로 등록돼 있거나 'exp-' 로 시작해야 합니다.";
  }
  return null;
}

function toActivityForm(
  row: UserActivityDetailRow,
  clusterMap: ActivityTypeClusterMap,
): ActivityFormRow {
  return {
    id: row.id,
    user_id: row.user_id,
    week_id: row.week_id,
    activity_type_id: row.activity_type_id,
    sub_title: row.sub_title ?? "",
    growth_point: row.growth_point ?? "",
    output_links_json: JSON.stringify(row.output_links, null, 2),
    image_urls_json: JSON.stringify(row.image_urls, null, 2),
    image_captions_json: JSON.stringify(row.image_captions, null, 2),
    rating: row.rating === null || row.rating === undefined ? "" : String(row.rating),
    modal: classifyActivityType(row.activity_type_id, clusterMap),
  };
}

function toCareerForm(row: CareerRecordRow): CareerFormRow {
  return {
    id: row.id,
    user_id: row.user_id,
    week_id: row.week_id,
    project_id: row.project_id,
    enhancement_status: row.enhancement_status ?? "",
    grade: row.grade ?? "",
    grade_points: row.grade_points === null ? "" : String(row.grade_points),
    career_code: row.career_code ?? "",
    project: row.project,
  };
}

// safe JSON parse with error string.
function tryParseJson<T>(value: string, fallback: T): { ok: true; value: T } | { ok: false; error: string } {
  const trimmed = value.trim();
  if (trimmed === "") return { ok: true, value: fallback };
  try {
    const parsed = JSON.parse(trimmed) as T;
    return { ok: true, value: parsed };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Invalid JSON" };
  }
}

type ActivityPatchValue = NonNullable<Cluster4PatchBody["userActivityDetails"]>[number];
type CareerPatchValue = NonNullable<Cluster4PatchBody["careerRecords"]>[number];

// Partial-emit mode (2026-05-22):
//   - mode="all" → 모든 컨텐츠 필드를 payload 에 포함 (draft / 신규 INSERT 용).
//   - mode={...edits} → 편집된 필드만 payload 에 포함 (기존 row 의 partial UPDATE 용).
//     서버는 키가 빠진 필드를 건드리지 않고 기존 DB 값을 보존한다.
// 이미지 페어(image_urls / image_captions) 는 어느 한쪽이라도 편집되면 둘 다 emit
// (정합 깨짐 방지). 서버도 한쪽만 와도 처리 가능하지만, 클라이언트에서 페어로
// 묶어 보내면 의도가 명확해진다.
function buildActivityPatchInput(
  form: ActivityFormRow,
  mode: "all" | Partial<ActivityFormRow>,
):
  | { ok: true; value: ActivityPatchValue }
  | { ok: false; error: string } {
  const isAll = mode === "all";
  const edits = isAll ? null : mode;
  const editedKey = (key: keyof ActivityFormRow): boolean =>
    isAll ||
    (edits !== null &&
      Object.prototype.hasOwnProperty.call(edits, key) &&
      edits[key] !== undefined);

  // synthetic draft id 는 server 로 전달하지 않는다 (server 가 INSERT 분기로 라우팅).
  const persistedId = form.id && !isDraftId(form.id) ? form.id : null;

  // 식별 키 + modal hint 는 항상 포함.
  const value: ActivityPatchValue = {
    id: persistedId,
    week_id: form.week_id,
    activity_type_id: form.activity_type_id,
    modal: form.modal,
  };

  if (editedKey("sub_title")) {
    value.sub_title = form.sub_title || null;
  }
  if (editedKey("growth_point")) {
    value.growth_point = form.growth_point || null;
  }
  if (editedKey("output_links_json")) {
    const outputLinks = tryParseJson<UserActivityOutputLink[]>(
      form.output_links_json,
      [],
    );
    if (!outputLinks.ok) {
      return {
        ok: false,
        error: `output_links JSON 파싱 오류: ${outputLinks.error}`,
      };
    }
    value.output_links = outputLinks.value;
  }

  // image_urls / image_captions 는 페어로 묶어 emit.
  const imagesEdited =
    editedKey("image_urls_json") || editedKey("image_captions_json");
  if (imagesEdited) {
    const imageUrls = tryParseJson<string[]>(form.image_urls_json, []);
    if (!imageUrls.ok) {
      return { ok: false, error: `image_urls JSON 파싱 오류: ${imageUrls.error}` };
    }
    const imageCaptions = tryParseJson<string[]>(form.image_captions_json, []);
    if (!imageCaptions.ok) {
      return {
        ok: false,
        error: `image_captions JSON 파싱 오류: ${imageCaptions.error}`,
      };
    }
    value.image_urls = imageUrls.value;
    value.image_captions = imageCaptions.value;
  }

  // rating: work_exp 만 슬라이더 노출, 다른 modal 에서는 edits 에 들어올 일이 없음.
  if (editedKey("rating")) {
    if (form.rating.trim() === "") {
      value.rating = null;
    } else {
      const n = Number(form.rating);
      if (!Number.isFinite(n) || n < 0 || n > 10) {
        return { ok: false, error: "rating 은 0~10 사이여야 합니다." };
      }
      value.rating = n;
    }
  }

  return { ok: true, value };
}

function buildCareerPatchInput(form: CareerFormRow):
  | { ok: true; value: CareerPatchValue }
  | { ok: false; error: string } {
  let gradePoints: number | null = null;
  if (form.grade_points.trim() !== "") {
    const n = Number(form.grade_points);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      return { ok: false, error: "grade_points 는 0 이상의 정수여야 합니다." };
    }
    gradePoints = n;
  }

  const persistedId = form.id && !isDraftId(form.id) ? form.id : null;

  return {
    ok: true,
    value: {
      id: persistedId,
      week_id: form.week_id,
      project_id: form.project_id,
      enhancement_status:
        form.enhancement_status === ""
          ? null
          : (form.enhancement_status as CareerEnhancementStatus),
      grade: form.grade === "" ? null : (form.grade as CareerGrade),
      grade_points: gradePoints,
      career_code: form.career_code || null,
    },
  };
}

export default function ActivityTab({
  bundle,
  legacyUserId,
  weekLabels,
  saveDisabled,
  onBundleUpdate,
  onBanner,
  devMode,
}: Props) {
  const [activeSub, setActiveSub] = useState<UserActivityModalKey | "work_career">(
    "work_info",
  );
  // bundle 은 외부 source-of-truth. 사용자의 미저장 편집은 row id 별 patch 로 보관해
  // bundle 갱신과 자연스럽게 머지. effect 없이 setState 회피 + 다른 row 의 미저장
  // 입력을 잃지 않도록 함.
  const [activityEdits, setActivityEdits] = useState<
    Map<string, Partial<ActivityFormRow>>
  >(() => new Map());
  const [careerEdits, setCareerEdits] = useState<
    Map<string, Partial<CareerFormRow>>
  >(() => new Map());
  // 신규 생성 draft. sub-modal 별 최대 1개. career 는 별도 단일 slot.
  const [activityDrafts, setActivityDrafts] = useState<
    Partial<Record<UserActivityModalKey, ActivityFormRow>>
  >({});
  const [careerDraft, setCareerDraft] = useState<CareerFormRow | null>(null);
  const [savingRowId, setSavingRowId] = useState<string | null>(null);

  const targetUserId = bundle.userId ?? "";

  // ────────────────────────────────────────────────────────────────────────
  // Cluster4 4허브 권한: legacy `Boolean(bundle.userId)` 가 아닌 cluster4_line_targets
  // + user_edit_windows 기준으로 hub 단위 canEdit 을 계산한다.
  //
  // Hub-level decision:
  //   - bundle.cluster4LineTargets 중 partType 매칭 row 중 가장 "유리한" 하나를 선택
  //     (window 가 열린 row 우선; 없으면 closes_at 가 가장 늦은 row).
  //   - + bundle.cluster4HubEditWindows[resource_key] 와 함께 evaluateCluster4HubEdit.
  //   - override 가 active 이면 target 부재여도 canEdit=true (운영자 명시적 부여).
  //
  // 결정은 (1) "새 항목 추가" 버튼 활성 (2) 기존 row 의 저장/삭제/입력 disabled
  // 에 동일하게 적용된다. parent 의 saveDisabled (loading/saving + !bundle.userId) 는
  // 그대로 위에 덮어쓰는 별도 UX 게이트.
  // ────────────────────────────────────────────────────────────────────────
  const nowMs = useMemo(() => Date.now(), [bundle]);

  const hubDecisions = useMemo<
    Record<Cluster4LinePartType, Cluster4HubEditDecision>
  >(() => {
    const result = {} as Record<Cluster4LinePartType, Cluster4HubEditDecision>;
    const partTypes: Cluster4LinePartType[] = [
      "info",
      "competency",
      "experience",
      "career",
    ];

    for (const partType of partTypes) {
      const candidates = bundle.cluster4LineTargets.filter(
        (t) => t.partType === partType,
      );
      // 우선순위: 현재 window 가 열려 있는 target → 가장 늦게 닫히는 target → null.
      const inWindow = candidates.find((t) => {
        const opens = new Date(t.line.submissionOpensAt).getTime();
        const closes = new Date(t.line.submissionClosesAt).getTime();
        return (
          t.line.isActive &&
          (!Number.isFinite(opens) || nowMs >= opens) &&
          (!Number.isFinite(closes) || nowMs <= closes)
        );
      });
      const picked =
        inWindow ??
        [...candidates].sort(
          (a, b) =>
            new Date(b.line.submissionClosesAt).getTime() -
            new Date(a.line.submissionClosesAt).getTime(),
        )[0] ??
        null;

      const resourceKey = partTypeToEditWindowResourceKey(partType);
      const editWindow = bundle.cluster4HubEditWindows[resourceKey];

      result[partType] = evaluateCluster4HubEdit({
        target: picked
          ? {
              target_mode: picked.targetMode,
              target_user_id: picked.targetUserId,
              line: {
                is_active: picked.line.isActive,
                submission_opens_at: picked.line.submissionOpensAt,
                submission_closes_at: picked.line.submissionClosesAt,
              },
            }
          : null,
        editWindow,
        profileUserId: bundle.userId,
        now: nowMs,
      });
    }

    return result;
  }, [
    bundle.cluster4LineTargets,
    bundle.cluster4HubEditWindows,
    bundle.userId,
    nowMs,
  ]);

  const canEditModal = useCallback(
    (modal: UserActivityModalKey | "work_career"): boolean => {
      if (!bundle.userId) return false;
      const partType = modalKeyToPartType(modal);
      return hubDecisions[partType].canEdit;
    },
    [bundle.userId, hubDecisions],
  );

  // Hub-level "새 항목 추가" 게이트. saveDisabled (loading/saving) 위에 hub canEdit 을 덮는다.
  const canAddForModal = useCallback(
    (modal: UserActivityModalKey | "work_career"): boolean => {
      return !saveDisabled && canEditModal(modal);
    },
    [saveDisabled, canEditModal],
  );

  // devMode 일 때 한 번씩 결정 근거를 출력. 디버깅 / 운영 confirmation 용.
  useEffect(() => {
    if (!devMode || !bundle.userId) return;
    const partTypes: Cluster4LinePartType[] = [
      "info",
      "competency",
      "experience",
      "career",
    ];
    for (const partType of partTypes) {
      const decision = hubDecisions[partType];
      const resourceKey = partTypeToEditWindowResourceKey(partType);
      const window = bundle.cluster4HubEditWindows[resourceKey];
      const target = bundle.cluster4LineTargets.find(
        (t) => t.partType === partType,
      );
      // eslint-disable-next-line no-console
      console.log("[ActivityTab canEdit]", {
        partType,
        targetId: target?.lineTargetId ?? null,
        targetUserId: target?.targetUserId ?? null,
        profileUserId: bundle.userId,
        targetMode: target?.targetMode ?? null,
        submissionOpensAt: target?.line.submissionOpensAt ?? null,
        submissionClosesAt: target?.line.submissionClosesAt ?? null,
        lineWindowCanEdit: decision.lineWindowCanEdit,
        editWindowResourceKey: resourceKey,
        editWindowOpen: decision.editWindowOpen,
        editWindowExpiresAt: window?.expiresAt ?? null,
        finalCanEdit: decision.canEdit,
        reason: decision.reason,
      });
    }
  }, [
    devMode,
    bundle.userId,
    bundle.cluster4LineTargets,
    bundle.cluster4HubEditWindows,
    hubDecisions,
  ]);

  const weekOptions = useMemo<Array<{ id: string; label: string }>>(() => {
    return Array.from(weekLabels.entries()).map(([id, label]) => ({ id, label }));
  }, [weekLabels]);

  const getWeekLabel = useCallback(
    (id: string | null | undefined) => {
      if (!id) return "-";
      return weekLabels.get(String(id)) ?? String(id);
    },
    [weekLabels],
  );

  const activityForm = useMemo<ActivityFormRow[]>(() => {
    return bundle.userActivityDetails.map((row) => {
      const base = toActivityForm(row, bundle.activityTypesClusterMap);
      const patch = activityEdits.get(row.id);
      return patch ? { ...base, ...patch } : base;
    });
  }, [bundle.userActivityDetails, bundle.activityTypesClusterMap, activityEdits]);

  const careerForm = useMemo<CareerFormRow[]>(() => {
    return bundle.careerRecords.map((row) => {
      const base = toCareerForm(row);
      const patch = careerEdits.get(row.id);
      return patch ? { ...base, ...patch } : base;
    });
  }, [bundle.careerRecords, careerEdits]);

  // Work Career 도 user_activity_details 에 row 를 가질 수 있어서 (프론트
  // Cluster4Card 4번째 모달이 동일 테이블에 저장) 더 이상 short-circuit 하지 않는다.
  // work_career 탭은 ActivitySubPane(user_activity_details) + CareerSubPane(career_records)
  // 를 같이 렌더한다.
  const visibleActivityRows = useMemo<ActivityFormRow[]>(() => {
    const existing = activityForm.filter((row) => row.modal === activeSub);
    const draft = activityDrafts[activeSub];
    return draft ? [draft, ...existing] : existing;
  }, [activityForm, activeSub, activityDrafts]);

  const visibleCareerRows = useMemo<CareerFormRow[]>(() => {
    return careerDraft ? [careerDraft, ...careerForm] : careerForm;
  }, [careerDraft, careerForm]);

  const setActivityRow = (rowId: string, patch: Partial<ActivityFormRow>) => {
    if (isDraftId(rowId)) {
      setActivityDrafts((current) => {
        const next = { ...current };
        for (const modal of Object.keys(next) as UserActivityModalKey[]) {
          if (next[modal]?.id === rowId) {
            next[modal] = { ...next[modal]!, ...patch };
            break;
          }
        }
        return next;
      });
      return;
    }
    setActivityEdits((current) => {
      const next = new Map(current);
      const existing = next.get(rowId) ?? {};
      next.set(rowId, { ...existing, ...patch });
      return next;
    });
  };

  const setCareerRow = (rowId: string, patch: Partial<CareerFormRow>) => {
    if (isDraftId(rowId)) {
      setCareerDraft((current) => (current ? { ...current, ...patch } : null));
      return;
    }
    setCareerEdits((current) => {
      const next = new Map(current);
      const existing = next.get(rowId) ?? {};
      next.set(rowId, { ...existing, ...patch });
      return next;
    });
  };

  const clearActivityEdits = (rowId: string) =>
    setActivityEdits((current) => {
      if (!current.has(rowId)) return current;
      const next = new Map(current);
      next.delete(rowId);
      return next;
    });

  const clearCareerEdits = (rowId: string) =>
    setCareerEdits((current) => {
      if (!current.has(rowId)) return current;
      const next = new Map(current);
      next.delete(rowId);
      return next;
    });

  const handleAddActivityDraft = (modal: UserActivityModalKey) => {
    if (!targetUserId) return;
    if (!canAddForModal(modal)) return;
    if (activityDrafts[modal]) return; // 이미 활성 draft 있음
    setActivityDrafts((current) => ({
      ...current,
      [modal]: createEmptyActivityDraft(modal, targetUserId),
    }));
    onBanner(null);
  };

  const handleCancelActivityDraft = (modal: UserActivityModalKey) => {
    setActivityDrafts((current) => {
      if (!current[modal]) return current;
      const next = { ...current };
      delete next[modal];
      return next;
    });
    onBanner(null);
  };

  const handleAddCareerDraft = () => {
    if (!targetUserId) return;
    if (!canAddForModal("work_career")) return;
    if (careerDraft) return;
    setCareerDraft(createEmptyCareerDraft(targetUserId));
    onBanner(null);
  };

  const handleCancelCareerDraft = () => {
    setCareerDraft(null);
    onBanner(null);
  };

  const handleSaveActivityRow = async (rowId: string) => {
    if (saveDisabled) return;
    const isDraft = isDraftId(rowId);

    let target: ActivityFormRow | undefined;
    let draftModal: UserActivityModalKey | undefined;

    if (isDraft) {
      for (const modal of Object.keys(activityDrafts) as UserActivityModalKey[]) {
        if (activityDrafts[modal]?.id === rowId) {
          target = activityDrafts[modal];
          draftModal = modal;
          break;
        }
      }
    } else {
      target = activityForm.find((row) => row.id === rowId);
    }
    if (!target) return;

    // hub-level 권한 재확인 (button disabled 와 defense-in-depth).
    // legacy "Boolean(bundle.userId)" 게이트 대신 cluster4_line_targets +
    // user_edit_windows 기준의 결정을 사용한다.
    if (!canEditModal(target.modal)) {
      onBanner({
        kind: "error",
        message: `${target.modal} 허브 편집 권한이 없습니다 (라인 target / edit window 모두 미부여).`,
      });
      return;
    }

    // draft 만 추가 검증 (week / activity_type_id 필수 + cluster_id 또는 prefix 규칙).
    if (isDraft) {
      if (!target.week_id) {
        onBanner({ kind: "error", message: "week 를 선택해 주세요." });
        return;
      }
      const typeError = validateDraftActivityType(
        target.modal,
        target.activity_type_id,
        bundle.activityTypesClusterMap,
      );
      if (typeError) {
        onBanner({ kind: "error", message: typeError });
        return;
      }
    }

    // draft → 전체 필드 emit (INSERT). 기존 row → activityEdits 의 변경 키만 emit
    // (partial UPDATE). 편집 없이 "저장" 누른 경우 mode 가 빈 객체가 되어 서버에서
    // no-op 으로 처리됨.
    const mode: "all" | Partial<ActivityFormRow> = isDraft
      ? "all"
      : activityEdits.get(rowId) ?? {};
    const built = buildActivityPatchInput(target, mode);
    if (!built.ok) {
      onBanner({ kind: "error", message: built.error });
      return;
    }

    setSavingRowId(rowId);
    onBanner(null);
    try {
      const response = await fetch(
        `/api/admin/crews/${encodeURIComponent(legacyUserId)}/cluster4`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userActivityDetails: [built.value] }),
        },
      );
      const json = await response.json();
      if (!response.ok || !json.success) {
        throw new Error(json?.error ?? "Failed to save.");
      }
      onBundleUpdate(json.data as Cluster4Bundle);
      if (isDraft && draftModal) {
        const slot = draftModal;
        setActivityDrafts((current) => {
          if (!current[slot]) return current;
          const next = { ...current };
          delete next[slot];
          return next;
        });
      } else {
        clearActivityEdits(rowId);
      }
      onBanner({
        kind: "success",
        message: isDraft ? "신규 항목이 추가되었습니다." : "저장되었습니다.",
      });
    } catch (error) {
      onBanner({
        kind: "error",
        message: error instanceof Error ? error.message : "Failed to save.",
      });
    } finally {
      setSavingRowId(null);
    }
  };

  const handleSaveCareerRow = async (rowId: string) => {
    if (saveDisabled) return;
    const isDraft = isDraftId(rowId);
    const target = isDraft
      ? careerDraft
      : careerForm.find((row) => row.id === rowId);
    if (!target) return;

    // career_records 는 cluster4.work_career 권한 한 개에 묶인다.
    if (!canEditModal("work_career")) {
      onBanner({
        kind: "error",
        message:
          "work_career 허브 편집 권한이 없습니다 (라인 target / edit window 모두 미부여).",
      });
      return;
    }

    if (isDraft) {
      if (!target.week_id) {
        onBanner({ kind: "error", message: "week 를 선택해 주세요." });
        return;
      }
      if (!target.project_id.trim()) {
        onBanner({ kind: "error", message: "project_id 를 입력해 주세요." });
        return;
      }
    }

    const built = buildCareerPatchInput(target);
    if (!built.ok) {
      onBanner({ kind: "error", message: built.error });
      return;
    }

    setSavingRowId(rowId);
    onBanner(null);
    try {
      const response = await fetch(
        `/api/admin/crews/${encodeURIComponent(legacyUserId)}/cluster4`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ careerRecords: [built.value] }),
        },
      );
      const json = await response.json();
      if (!response.ok || !json.success) {
        throw new Error(json?.error ?? "Failed to save.");
      }
      onBundleUpdate(json.data as Cluster4Bundle);
      if (isDraft) {
        setCareerDraft(null);
      } else {
        clearCareerEdits(rowId);
      }
      onBanner({
        kind: "success",
        message: isDraft
          ? "신규 Career Record 가 추가되었습니다."
          : "저장되었습니다.",
      });
    } catch (error) {
      onBanner({
        kind: "error",
        message: error instanceof Error ? error.message : "Failed to save.",
      });
    } finally {
      setSavingRowId(null);
    }
  };

  const handleDelete = async (
    resource: Cluster4DeleteResource,
    id: string,
    confirmMessage: string,
  ) => {
    if (saveDisabled) return;

    // hub-level 권한 가드. ActivityTab 이 책임지는 두 리소스만 처리; 그 외는
    // (별도 탭에서 호출되는 경우) 그대로 통과시킨다.
    if (resource === "careerRecord" && !canEditModal("work_career")) {
      onBanner({
        kind: "error",
        message: "work_career 허브 편집 권한이 없습니다.",
      });
      return;
    }
    if (resource === "userActivityDetail") {
      // user_activity_details 는 modal 분류가 row 별로 다르다. 행 데이터에서 modal 을
      // 역추적 — 없으면 (race condition) 일단 통과 시키고 서버 검증에 맡긴다.
      const row = activityForm.find((item) => item.id === id);
      if (row && !canEditModal(row.modal)) {
        onBanner({
          kind: "error",
          message: `${row.modal} 허브 편집 권한이 없습니다.`,
        });
        return;
      }
    }

    const ok = window.confirm(`${confirmMessage}\n\nid: ${id}`);
    if (!ok) return;

    const paramKeyMap: Record<Cluster4DeleteResource, string> = {
      seasonReputation: "seasonReputationId",
      weeklyReputation: "weeklyReputationId",
      weeklyReview: "weeklyReviewId",
      weeklyColleague: "weeklyColleagueId",
      userActivityDetail: "userActivityDetailId",
      careerRecord: "careerRecordId",
    };

    setSavingRowId(id);
    onBanner(null);
    try {
      const response = await fetch(
        `/api/admin/crews/${encodeURIComponent(legacyUserId)}/cluster4?${paramKeyMap[resource]}=${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      const json = await response.json();
      if (!response.ok || !json.success) {
        throw new Error(json?.error ?? "Failed to delete.");
      }
      onBundleUpdate(json.data as Cluster4Bundle);
      onBanner({ kind: "success", message: "삭제되었습니다." });
    } catch (error) {
      onBanner({
        kind: "error",
        message: error instanceof Error ? error.message : "Failed to delete.",
      });
    } finally {
      setSavingRowId(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">활동</CardTitle>
        <p className="text-xs text-muted-foreground">
          Cluster4-card 4개 모달(Work Info / Ability / Exp / Career)의 운영 편집 영역입니다.
          작성기간 게이트는 사용자에게만 적용되며, 운영자는 작성기간과 무관하게 수정/삭제할 수
          있습니다.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-1 border-b">
          {SUB_TABS.map((tab) => {
            const isActive = activeSub === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveSub(tab.key)}
                className={cn(
                  "relative -mb-px rounded-t-md border border-b-0 px-3 py-1.5 text-xs",
                  isActive
                    ? "border-foreground bg-background font-semibold text-foreground"
                    : "border-transparent bg-muted/40 text-muted-foreground hover:bg-muted",
                )}
                aria-pressed={isActive}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {activeSub !== "work_career" ? (
          <ActivitySubPane
            modal={activeSub}
            rows={visibleActivityRows}
            saveDisabled={saveDisabled}
            savingRowId={savingRowId}
            tableAvailable={bundle.tablesAvailable.userActivityDetails}
            getWeekLabel={getWeekLabel}
            weekOptions={weekOptions}
            canAdd={canAddForModal(activeSub)}
            hubCanEdit={canEditModal(activeSub)}
            hubDecision={hubDecisions[modalKeyToPartType(activeSub)]}
            draftActive={!!activityDrafts[activeSub]}
            onAddDraft={() => handleAddActivityDraft(activeSub)}
            onCancelDraft={() => handleCancelActivityDraft(activeSub)}
            onChange={(rowId, patch) => setActivityRow(rowId, patch)}
            onSave={(rowId) => void handleSaveActivityRow(rowId)}
            onDelete={(rowId, label) =>
              void handleDelete(
                "userActivityDetail",
                rowId,
                `${label} 행을 삭제할까요?`,
              )
            }
            devMode={devMode}
          />
        ) : (
          <div className="flex flex-col gap-6">
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-foreground">
                카드 내용{" "}
                <span className="font-mono text-xs text-muted-foreground">
                  user_activity_details
                </span>
              </h3>
              <ActivitySubPane
                modal="work_career"
                rows={visibleActivityRows}
                saveDisabled={saveDisabled}
                savingRowId={savingRowId}
                tableAvailable={bundle.tablesAvailable.userActivityDetails}
                getWeekLabel={getWeekLabel}
                weekOptions={weekOptions}
                canAdd={canAddForModal("work_career")}
                hubCanEdit={canEditModal("work_career")}
                hubDecision={hubDecisions.career}
                draftActive={!!activityDrafts.work_career}
                onAddDraft={() => handleAddActivityDraft("work_career")}
                onCancelDraft={() => handleCancelActivityDraft("work_career")}
                onChange={(rowId, patch) => setActivityRow(rowId, patch)}
                onSave={(rowId) => void handleSaveActivityRow(rowId)}
                onDelete={(rowId, label) =>
                  void handleDelete(
                    "userActivityDetail",
                    rowId,
                    `${label} 행을 삭제할까요?`,
                  )
                }
                devMode={devMode}
              />
            </section>

            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold text-foreground">
                프로젝트 기록{" "}
                <span className="font-mono text-xs text-muted-foreground">
                  career_records
                </span>
              </h3>
              <CareerSubPane
                rows={visibleCareerRows}
                saveDisabled={saveDisabled}
                savingRowId={savingRowId}
                tableAvailable={bundle.tablesAvailable.careerRecords}
                getWeekLabel={getWeekLabel}
                weekOptions={weekOptions}
                canAdd={canAddForModal("work_career")}
                hubCanEdit={canEditModal("work_career")}
                hubDecision={hubDecisions.career}
                draftActive={!!careerDraft}
                onAddDraft={handleAddCareerDraft}
                onCancelDraft={handleCancelCareerDraft}
                onChange={(rowId, patch) => setCareerRow(rowId, patch)}
                onSave={(rowId) => void handleSaveCareerRow(rowId)}
                onDelete={(rowId, label) =>
                  void handleDelete(
                    "careerRecord",
                    rowId,
                    `${label} 행을 삭제할까요?`,
                  )
                }
                devMode={devMode}
              />
            </section>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ───────────── Work Info / Ability / Exp pane ─────────────

function ActivitySubPane({
  modal,
  rows,
  saveDisabled,
  savingRowId,
  tableAvailable,
  getWeekLabel,
  weekOptions,
  canAdd,
  hubCanEdit,
  hubDecision,
  draftActive,
  onAddDraft,
  onCancelDraft,
  onChange,
  onSave,
  onDelete,
  devMode,
}: {
  modal: UserActivityModalKey | "work_career";
  rows: ActivityFormRow[];
  saveDisabled: boolean;
  savingRowId: string | null;
  tableAvailable: boolean;
  getWeekLabel: (id: string | null | undefined) => string;
  weekOptions: Array<{ id: string; label: string }>;
  canAdd: boolean;
  hubCanEdit: boolean;
  hubDecision: Cluster4HubEditDecision;
  draftActive: boolean;
  onAddDraft: () => void;
  onCancelDraft: () => void;
  onChange: (rowId: string, patch: Partial<ActivityFormRow>) => void;
  onSave: (rowId: string) => void;
  onDelete: (rowId: string, label: string) => void;
  devMode: boolean;
}) {
  // 기존 saveDisabled (loading/saving) 위에 hub 권한을 덮는다. hubCanEdit=false 이면
  // 입력 / 저장 / 삭제 모두 disabled.
  const rowDisabled = saveDisabled || !hubCanEdit;
  if (!tableAvailable) {
    return (
      <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
        <span className="font-mono text-xs">user_activity_details</span> 테이블을 조회할 수
        없습니다.
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-md border border-dashed bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
        <p>
          {ACTIVITY_MODAL_LABEL[modal]} 에 해당하는 user_activity_details row 가 없습니다.
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onAddDraft}
          disabled={!canAdd}
        >
          <Plus className="h-4 w-4" />새 항목 추가
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {!draftActive && (
        <div className="flex items-center justify-end">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onAddDraft}
            disabled={!canAdd}
          >
            <Plus className="h-4 w-4" />새 항목 추가
          </Button>
        </div>
      )}
      {rows.map((row) => {
        const isDraft = isDraftId(row.id);
        const headerLabel = isDraft
          ? `${ACTIVITY_MODAL_LABEL[modal]} · 신규 항목`
          : `${row.activity_type_id} · ${getWeekLabel(row.week_id)}`;
        return (
          <div
            key={row.id}
            className={cn(
              "rounded-lg border bg-card shadow-sm",
              isDraft && "border-primary/40 bg-primary/5",
            )}
          >
            <div className="flex flex-wrap items-start justify-between gap-2 border-b px-4 py-3">
              <div className="flex flex-col gap-0.5">
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  {isDraft && (
                    <span className="rounded bg-primary px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary-foreground">
                      신규
                    </span>
                  )}
                  {isDraft ? (
                    <span>{ACTIVITY_MODAL_LABEL[modal]}</span>
                  ) : (
                    <>
                      <span className="font-mono">{row.activity_type_id}</span>
                      <span className="text-xs font-normal text-muted-foreground">
                        · {getWeekLabel(row.week_id)}
                      </span>
                    </>
                  )}
                </div>
                {devMode && !isDraft && (
                  <div className="font-mono text-[10px] text-muted-foreground">
                    id: {row.id}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => onSave(row.id)}
                  disabled={rowDisabled || savingRowId === row.id}
                >
                  <Save className="h-4 w-4" />
                  {savingRowId === row.id
                    ? "저장 중..."
                    : isDraft
                      ? "추가"
                      : "저장"}
                </Button>
                {isDraft ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={onCancelDraft}
                    disabled={savingRowId === row.id}
                  >
                    <X className="h-4 w-4" />
                    취소
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      onDelete(
                        row.id,
                        `${row.activity_type_id} · ${getWeekLabel(row.week_id)}`,
                      )
                    }
                    disabled={rowDisabled || savingRowId === row.id}
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                    삭제
                  </Button>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3 px-4 py-3 sm:grid-cols-2">
              {isDraft && (
                <>
                  <div className="flex flex-col gap-1.5">
                    <FieldLabel>week (작성 주차)</FieldLabel>
                    <Select
                      value={row.week_id || "__none__"}
                      onValueChange={(value: string | null) =>
                        onChange(row.id, {
                          week_id: value === "__none__" ? "" : (value ?? ""),
                        })
                      }
                      disabled={rowDisabled}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="주차 선택" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">— 선택</SelectItem>
                        {weekOptions.map((opt) => (
                          <SelectItem key={opt.id} value={opt.id}>
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <FieldLabel>activity_type_id</FieldLabel>
                    {modal === "work_info" ? (
                      <Select
                        value={row.activity_type_id || "__none__"}
                        onValueChange={(value: string | null) =>
                          onChange(row.id, {
                            activity_type_id:
                              value === "__none__" ? "" : (value ?? ""),
                          })
                        }
                        disabled={rowDisabled}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="활동 종류 선택" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">— 선택</SelectItem>
                          {WORK_INFO_ACTIVITY_TYPE_IDS.map((id) => (
                            <SelectItem key={id} value={id}>
                              {id}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        value={row.activity_type_id}
                        onChange={(event) =>
                          onChange(row.id, {
                            activity_type_id: event.target.value,
                          })
                        }
                        disabled={rowDisabled}
                        placeholder={
                          modal === "work_ability"
                            ? "activity_types.id (cluster_id=practical_competency) 또는 comp- 로 시작"
                            : "activity_types.id (cluster_id=practical_experience) 또는 exp- 로 시작"
                        }
                        className="h-9 font-mono"
                      />
                    )}
                  </div>
                </>
              )}

              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <FieldLabel>sub_title</FieldLabel>
                <textarea
                  value={row.sub_title}
                  onChange={(event) =>
                    onChange(row.id, { sub_title: event.target.value })
                  }
                  disabled={rowDisabled}
                  rows={2}
                  maxLength={300}
                  className="resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                />
                <div className="self-end text-[10px] text-muted-foreground">
                  {row.sub_title.length}/300
                </div>
              </div>

              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <FieldLabel>growth_point</FieldLabel>
                <textarea
                  value={row.growth_point}
                  onChange={(event) =>
                    onChange(row.id, { growth_point: event.target.value })
                  }
                  disabled={rowDisabled}
                  rows={3}
                  maxLength={2000}
                  className="resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                />
                <div className="self-end text-[10px] text-muted-foreground">
                  {row.growth_point.length}/2000
                </div>
              </div>

              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <FieldLabel>output_links (JSON array of {`{desc, url}`})</FieldLabel>
                <textarea
                  value={row.output_links_json}
                  onChange={(event) =>
                    onChange(row.id, { output_links_json: event.target.value })
                  }
                  disabled={rowDisabled}
                  rows={3}
                  spellCheck={false}
                  className="resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <FieldLabel>image_urls (JSON array of strings, ≤4)</FieldLabel>
                <textarea
                  value={row.image_urls_json}
                  onChange={(event) =>
                    onChange(row.id, { image_urls_json: event.target.value })
                  }
                  disabled={rowDisabled}
                  rows={3}
                  spellCheck={false}
                  className="resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <FieldLabel>image_captions (JSON array)</FieldLabel>
                <textarea
                  value={row.image_captions_json}
                  onChange={(event) =>
                    onChange(row.id, { image_captions_json: event.target.value })
                  }
                  disabled={rowDisabled}
                  rows={3}
                  spellCheck={false}
                  className="resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
                />
              </div>

              {modal === "work_exp" && (
                <div className="flex flex-col gap-1.5">
                  <FieldLabel>rating (0~10, 비우면 NULL)</FieldLabel>
                  <Input
                    type="number"
                    min={0}
                    max={10}
                    step={1}
                    inputMode="numeric"
                    value={row.rating}
                    onChange={(event) =>
                      onChange(row.id, { rating: event.target.value })
                    }
                    disabled={rowDisabled}
                    className="h-9"
                  />
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ───────────── Work Career pane ─────────────

function CareerSubPane({
  rows,
  saveDisabled,
  savingRowId,
  tableAvailable,
  getWeekLabel,
  weekOptions,
  canAdd,
  hubCanEdit,
  hubDecision,
  draftActive,
  onAddDraft,
  onCancelDraft,
  onChange,
  onSave,
  onDelete,
  devMode,
}: {
  rows: CareerFormRow[];
  saveDisabled: boolean;
  savingRowId: string | null;
  tableAvailable: boolean;
  getWeekLabel: (id: string | null | undefined) => string;
  weekOptions: Array<{ id: string; label: string }>;
  canAdd: boolean;
  hubCanEdit: boolean;
  hubDecision: Cluster4HubEditDecision;
  draftActive: boolean;
  onAddDraft: () => void;
  onCancelDraft: () => void;
  onChange: (rowId: string, patch: Partial<CareerFormRow>) => void;
  onSave: (rowId: string) => void;
  onDelete: (rowId: string, label: string) => void;
  devMode: boolean;
}) {
  const rowDisabled = saveDisabled || !hubCanEdit;
  if (!tableAvailable) {
    return (
      <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
        <span className="font-mono text-xs">career_records</span> 테이블을 조회할 수
        없습니다.
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-md border border-dashed bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
        <p>
          career_records row 가 없습니다. 운영자는 아래 버튼으로 새 Career Record 를
          추가할 수 있습니다.
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onAddDraft}
          disabled={!canAdd}
        >
          <Plus className="h-4 w-4" />
          Career Record 추가
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {!draftActive && (
        <div className="flex items-center justify-end">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onAddDraft}
            disabled={!canAdd}
          >
            <Plus className="h-4 w-4" />
            Career Record 추가
          </Button>
        </div>
      )}
      {rows.map((row) => {
        const isDraft = isDraftId(row.id);
        const project = row.project;
        const projectLabel = isDraft
          ? "신규 Career Record"
          : project
            ? `${project.company_name ?? "-"} · ${project.project_name ?? "-"}`
            : "(project not found)";
        return (
          <div
            key={row.id}
            className={cn(
              "rounded-lg border bg-card shadow-sm",
              isDraft && "border-primary/40 bg-primary/5",
            )}
          >
            <div className="flex flex-wrap items-start justify-between gap-2 border-b px-4 py-3">
              <div className="flex flex-col gap-0.5">
                <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  {isDraft && (
                    <span className="rounded bg-primary px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary-foreground">
                      신규
                    </span>
                  )}
                  <span>{projectLabel}</span>
                </div>
                {!isDraft && (
                  <div className="text-[11px] text-muted-foreground">
                    {getWeekLabel(row.week_id)}
                    {project?.line_code && (
                      <span className="ml-2 font-mono">[{project.line_code}]</span>
                    )}
                  </div>
                )}
                {devMode && !isDraft && (
                  <div className="font-mono text-[10px] text-muted-foreground">
                    id: {row.id} · project_id: {row.project_id}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={() => onSave(row.id)}
                  disabled={rowDisabled || savingRowId === row.id}
                >
                  <Save className="h-4 w-4" />
                  {savingRowId === row.id
                    ? "저장 중..."
                    : isDraft
                      ? "추가"
                      : "저장"}
                </Button>
                {isDraft ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={onCancelDraft}
                    disabled={savingRowId === row.id}
                  >
                    <X className="h-4 w-4" />
                    취소
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      onDelete(
                        row.id,
                        `${projectLabel} · ${getWeekLabel(row.week_id)}`,
                      )
                    }
                    disabled={rowDisabled || savingRowId === row.id}
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                    삭제
                  </Button>
                )}
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 px-4 py-3 sm:grid-cols-2">
              {isDraft && (
                <>
                  <div className="flex flex-col gap-1.5">
                    <FieldLabel>week (작성 주차)</FieldLabel>
                    <Select
                      value={row.week_id || "__none__"}
                      onValueChange={(value: string | null) =>
                        onChange(row.id, {
                          week_id: value === "__none__" ? "" : (value ?? ""),
                        })
                      }
                      disabled={rowDisabled}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="주차 선택" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">— 선택</SelectItem>
                        {weekOptions.map((opt) => (
                          <SelectItem key={opt.id} value={opt.id}>
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <FieldLabel>project_id (career_projects.id, UUID)</FieldLabel>
                    <Input
                      value={row.project_id}
                      onChange={(event) =>
                        onChange(row.id, { project_id: event.target.value })
                      }
                      disabled={rowDisabled}
                      placeholder="career_projects.id UUID 입력"
                      className="h-9 font-mono text-xs"
                    />
                  </div>
                </>
              )}

              {!isDraft && project && (
                <div className="flex flex-col gap-1 sm:col-span-2">
                  <FieldLabel>프로젝트 정보 (read-only)</FieldLabel>
                  <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs">
                    <div>
                      <span className="text-muted-foreground">company</span>{" "}
                      {project.company_name ?? "-"}
                    </div>
                    <div>
                      <span className="text-muted-foreground">project</span>{" "}
                      {project.project_name ?? "-"}
                    </div>
                    {project.job_position && (
                      <div>
                        <span className="text-muted-foreground">job_position</span>{" "}
                        {project.job_position}
                      </div>
                    )}
                    {project.supervisor_name && (
                      <div>
                        <span className="text-muted-foreground">supervisor</span>{" "}
                        {project.supervisor_name}
                        {project.supervisor_position
                          ? ` (${project.supervisor_position})`
                          : ""}
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                <FieldLabel>enhancement_status</FieldLabel>
                <Select
                  value={row.enhancement_status || "__none__"}
                  onValueChange={(value: string | null) =>
                    onChange(row.id, {
                      enhancement_status: value === "__none__" ? "" : (value ?? ""),
                    })
                  }
                  disabled={rowDisabled}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="—" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">— (null)</SelectItem>
                    {CAREER_ENHANCEMENT_STATUSES.map((status) => (
                      <SelectItem key={status} value={status}>
                        {status}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <FieldLabel>grade</FieldLabel>
                <Select
                  value={row.grade || "__none__"}
                  onValueChange={(value: string | null) =>
                    onChange(row.id, {
                      grade: value === "__none__" ? "" : (value ?? ""),
                    })
                  }
                  disabled={rowDisabled}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="—" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">— (null)</SelectItem>
                    {CAREER_GRADES.map((grade) => (
                      <SelectItem key={grade} value={grade}>
                        {grade}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-1.5">
                <FieldLabel>grade_points</FieldLabel>
                <Input
                  type="number"
                  min={0}
                  step={1}
                  inputMode="numeric"
                  value={row.grade_points}
                  onChange={(event) =>
                    onChange(row.id, { grade_points: event.target.value })
                  }
                  disabled={rowDisabled}
                  className="h-9"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <FieldLabel>career_code</FieldLabel>
                <Input
                  value={row.career_code}
                  onChange={(event) =>
                    onChange(row.id, { career_code: event.target.value })
                  }
                  disabled={rowDisabled}
                  maxLength={50}
                  className="h-9"
                />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  );
}
