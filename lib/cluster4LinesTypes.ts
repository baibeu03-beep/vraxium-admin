// Browser-safe types for public-facing cluster4 line APIs.
// Must not import server-only modules here.

import {
  type Cluster4OutputLink,
  outputLinksFromLegacy,
  parseOutputLinksInput,
} from "@/lib/cluster4OutputLinks";

export type { Cluster4OutputLink } from "@/lib/cluster4OutputLinks";

export type Cluster4LineStatus = "void" | "pending" | "success" | "fail";

export type Cluster4LinePartType =
  | "info"
  | "experience"
  | "competency"
  | "career";

export type Cluster4LineTargetMode = "user" | "rule";

export type Cluster4VisibleLineDto = {
  lineId: string;
  lineTargetId: string;
  partType: Cluster4LinePartType;
  targetMode: Cluster4LineTargetMode;
  mainTitle: string;
  outputLink1: string | null;
  outputLinks: Cluster4OutputLink[];
  submissionOpensAt: string;
  submissionClosesAt: string;
};

export type Cluster4LineSubmissionDto = {
  id: string;
  lineTargetId: string;
  subtitle: string | null;
  outputLink2: string | null;
  outputLink3: string | null;
  outputLink4: string | null;
  outputLink5: string | null;
  outputLinks: Cluster4OutputLink[];
  submittedAt: string;
  updatedAt: string;
};

export type Cluster4LineDetailDto = {
  status: Cluster4LineStatus;
  partType: Cluster4LinePartType;
  line: Cluster4VisibleLineDto | null;
  submission: Cluster4LineSubmissionDto | null;
};

export type Cluster4LineSubmissionInput = {
  subtitle: string | null;
  outputLink2: string | null;
  outputLink3: string | null;
  outputLink4: string | null;
  outputLink5: string | null;
  // 신규 canonical 구조. 저장 시 output_links jsonb 로 기록하고 레거시 컬럼에도 mirror 한다.
  outputLinks: Cluster4OutputLink[];
};

export type ParseSubmissionBodyResult =
  | { ok: true; value: Cluster4LineSubmissionInput }
  | { ok: false; status: number; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeTextField(
  raw: unknown,
  field: string,
): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") {
    return { ok: false, error: `${field} must be a string or null` };
  }
  const trimmed = raw.trim();
  return { ok: true, value: trimmed.length ? trimmed : null };
}

export function parseCluster4LineSubmissionBody(
  body: unknown,
): ParseSubmissionBodyResult {
  if (!isRecord(body)) {
    return { ok: false, status: 400, error: "Request body must be a JSON object" };
  }

  const subtitle = normalizeTextField(body.subtitle, "subtitle");
  if (!subtitle.ok) return { ok: false, status: 400, error: subtitle.error };
  const outputLink2 = normalizeTextField(body.output_link_2, "output_link_2");
  if (!outputLink2.ok) return { ok: false, status: 400, error: outputLink2.error };
  const outputLink3 = normalizeTextField(body.output_link_3, "output_link_3");
  if (!outputLink3.ok) return { ok: false, status: 400, error: outputLink3.error };
  const outputLink4 = normalizeTextField(body.output_link_4, "output_link_4");
  if (!outputLink4.ok) return { ok: false, status: 400, error: outputLink4.error };
  const outputLink5 = normalizeTextField(body.output_link_5, "output_link_5");
  if (!outputLink5.ok) return { ok: false, status: 400, error: outputLink5.error };

  // output_links 우선. 미제공 시 레거시 output_link_2~5 로부터 파생.
  const parsedLinks = parseOutputLinksInput(body.output_links);
  if (!parsedLinks.ok) return { ok: false, status: 400, error: parsedLinks.error };
  const outputLinks =
    parsedLinks.value.length > 0
      ? parsedLinks.value
      : outputLinksFromLegacy([
          outputLink2.value,
          outputLink3.value,
          outputLink4.value,
          outputLink5.value,
        ]);

  return {
    ok: true,
    value: {
      subtitle: subtitle.value,
      outputLink2: outputLink2.value,
      outputLink3: outputLink3.value,
      outputLink4: outputLink4.value,
      outputLink5: outputLink5.value,
      outputLinks,
    },
  };
}
