"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

// 사진 6 슬롯 URL 편집 + 썸네일 미리보기.
//   - slot 0 = sidebar (user_profiles.profile_photo_url)
//   - slot 1 = main   (user_cluster2.main_photo_url)
//   - slot 2~5 = sub  (user_cluster2.sub_photo_1_url ~ sub_photo_4_url)
// 업로드는 1차 범위 제외 — URL 입력만 지원.
// blob:/data:/file: 같은 local-only URL 은 렌더하지 않고 안내 표시한다.

// renderable 한 URL = 실제 fetch 가능한 http(s) absolute URL 또는 same-origin 경로
function isRenderableImageUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  const v = value.trim();
  if (!v) return false;
  return (
    v.startsWith("http://") || v.startsWith("https://") || v.startsWith("/")
  );
}

function isLocalPreviewUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  const v = value.trim();
  return (
    v.startsWith("blob:") || v.startsWith("data:") || v.startsWith("file:")
  );
}

type PhotosForm = {
  sidebarPhoto: string | null;
  mainPhoto: string | null;
  subPhotos: (string | null)[]; // length 4
};

type SlotKey = "sidebar" | "main" | "sub";

type SlotDef = {
  key: string;
  label: string;
  hint: string;
  kind: SlotKey;
  subIndex?: number; // sub 슬롯만 사용
};

const SLOT_DEFS: readonly SlotDef[] = [
  {
    key: "sidebar",
    label: "Sidebar (slot 0)",
    hint: "user_profiles.profile_photo_url",
    kind: "sidebar",
  },
  {
    key: "main",
    label: "Main (slot 1)",
    hint: "user_introductions.sub_photo_5",
    kind: "main",
  },
  {
    key: "sub_1",
    label: "Sub 1 (slot 2)",
    hint: "user_introductions.sub_photo_1",
    kind: "sub",
    subIndex: 0,
  },
  {
    key: "sub_2",
    label: "Sub 2 (slot 3)",
    hint: "user_introductions.sub_photo_2",
    kind: "sub",
    subIndex: 1,
  },
  {
    key: "sub_3",
    label: "Sub 3 (slot 4)",
    hint: "user_introductions.sub_photo_3",
    kind: "sub",
    subIndex: 2,
  },
  {
    key: "sub_4",
    label: "Sub 4 (slot 5)",
    hint: "user_introductions.sub_photo_4",
    kind: "sub",
    subIndex: 3,
  },
];

export default function PhotoSlots({
  value,
  onChange,
  disabled,
}: {
  value: PhotosForm;
  onChange: (next: PhotosForm) => void;
  disabled?: boolean;
}) {
  const readSlot = (slot: SlotDef): string => {
    if (slot.kind === "sidebar") return value.sidebarPhoto ?? "";
    if (slot.kind === "main") return value.mainPhoto ?? "";
    return value.subPhotos[slot.subIndex ?? 0] ?? "";
  };

  const writeSlot = (slot: SlotDef, raw: string) => {
    const next: PhotosForm = {
      sidebarPhoto: value.sidebarPhoto,
      mainPhoto: value.mainPhoto,
      subPhotos: [...value.subPhotos],
    };
    const trimmed = raw.trim();
    const v = trimmed === "" ? null : raw;
    if (slot.kind === "sidebar") next.sidebarPhoto = v;
    else if (slot.kind === "main") next.mainPhoto = v;
    else if (slot.subIndex !== undefined) {
      next.subPhotos[slot.subIndex] = v;
    }
    onChange(next);
  };

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {SLOT_DEFS.map((slot) => {
        const current = readSlot(slot);
        return (
          <div key={slot.key} className="flex flex-col gap-1.5">
            <Label className="text-xs">{slot.label}</Label>
            <Input
              type="url"
              value={current}
              onChange={(e) => writeSlot(slot, e.target.value)}
              placeholder="https://..."
              disabled={disabled}
            />
            <div className="text-[10px] text-muted-foreground">{slot.hint}</div>
            {isRenderableImageUrl(current) ? (
              <div
                className={cn(
                  "mt-1 flex h-24 items-center justify-center overflow-hidden rounded border bg-muted/30",
                )}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={current}
                  alt={slot.label}
                  className="h-full w-auto object-contain"
                />
              </div>
            ) : isLocalPreviewUrl(current) ? (
              <div className="mt-1 flex h-24 flex-col items-center justify-center rounded border border-amber-300 bg-amber-50 px-2 py-1 text-center text-[10px] text-amber-900">
                <div className="font-medium">
                  Local preview URL detected.
                </div>
                <div>Upload was not persisted to storage.</div>
                <div className="mt-0.5 break-all text-[9px] text-amber-900/70">
                  {current}
                </div>
              </div>
            ) : current ? (
              <div className="mt-1 flex h-24 flex-col items-center justify-center rounded border border-dashed bg-muted/10 px-2 py-1 text-center text-[10px] text-muted-foreground">
                <div className="font-medium">No valid image URL</div>
                <div className="mt-0.5 break-all text-[9px]">{current}</div>
              </div>
            ) : (
              <div className="mt-1 flex h-24 items-center justify-center rounded border border-dashed bg-muted/10 text-[10px] text-muted-foreground">
                no image
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
