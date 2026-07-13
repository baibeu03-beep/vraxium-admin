"use client";

import { PreviewBlock, fmt } from "@/components/admin/fieldKit";
import { cn } from "@/lib/utils";
import type { TopCardSlot, TopCardType } from "@/lib/adminCluster3Types";

// portfolio_top_cards readonly viewer — output (5) / detail (10) 공용.
// cardType prop 으로 시각 라벨만 갈리고, row shape / 렌더 로직은 동일하다.
// Phase 1 read-only — 편집/저장 미구현.

function isRenderableImageUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  const v = value.trim();
  if (!v) return false;
  return (
    v.startsWith("http://") || v.startsWith("https://") || v.startsWith("/")
  );
}

function formatPeriod(args: {
  startY: number | null;
  startM: number | null;
  startD: number | null;
  endY: number | null;
  endM: number | null;
  endD: number | null;
}) {
  const join = (y: number | null, m: number | null, d: number | null) => {
    const parts = [y, m, d].filter((v) => typeof v === "number") as number[];
    if (parts.length === 0) return null;
    return parts.join(".");
  };
  const start = join(args.startY, args.startM, args.startD);
  const end = join(args.endY, args.endM, args.endD);
  if (!start && !end) return "—";
  return `${start ?? "—"}  →  ${end ?? "—"}`;
}

function StringArray({ values }: { values: string[] | null }) {
  const list = Array.isArray(values) ? values : [];
  if (list.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <ol className="list-decimal pl-4">
      {list.map((v, i) => (
        <li key={i} className="break-words">
          {fmt(v)}
        </li>
      ))}
    </ol>
  );
}

function ImageGrid({
  urls,
  captions,
}: {
  urls: string[] | null;
  captions: string[] | null;
}) {
  const list = Array.isArray(urls) ? urls : [];
  if (list.length === 0) {
    return (
      <div className="flex h-16 items-center justify-center rounded border border-dashed bg-muted/10 text-[10px] text-muted-foreground">
        empty
      </div>
    );
  }
  const caps = Array.isArray(captions) ? captions : [];
  return (
    <div className="grid grid-cols-2 gap-1 sm:grid-cols-3 md:grid-cols-4">
      {list.map((url, i) => (
        <div key={i} className="flex flex-col gap-0.5">
          <div className="flex h-16 items-center justify-center overflow-hidden rounded border bg-muted/30">
            {isRenderableImageUrl(url) ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={url}
                alt={`sub image ${i + 1}`}
                className="h-full w-full object-cover"
              />
            ) : (
              <span className="break-all px-1 text-center text-[9px] text-muted-foreground">
                {url || "—"}
              </span>
            )}
          </div>
          <div className="break-words text-[9px] text-muted-foreground">
            {fmt(caps[i])}
          </div>
        </div>
      ))}
    </div>
  );
}

function TopSlotCard({
  slot,
  cardType,
}: {
  slot: TopCardSlot;
  cardType: TopCardType;
}) {
  const row = slot.row;
  const empty = !row;
  // 회귀 방지: row 가 있다면 card_type 이 우리가 기대한 종류와 일치하는지 한 번 더 표시.
  const typeMismatch =
    row !== null && row.card_type !== cardType;

  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-md border p-3 text-xs",
        empty ? "border-dashed bg-muted/10" : "bg-background",
        typeMismatch && "border-amber-300 bg-amber-50",
      )}
    >
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold">
          {cardType === "output" ? "Output" : "Detail"} #{slot.cardIndex}
          <span className="ml-1 font-normal text-muted-foreground">
            (card_type={cardType})
          </span>
        </div>
        <span
          className={cn(
            "rounded-full border px-1.5 py-0.5 text-[10px]",
            empty
              ? "border-border bg-muted text-muted-foreground"
              : "border-emerald-200 bg-emerald-50 text-emerald-700",
          )}
        >
          {empty ? "empty" : "DB row"}
        </span>
      </div>

      {typeMismatch && row && (
        <div className="rounded border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-900">
          card_type 불일치: 기대 {cardType} / 실제 {row.card_type}
        </div>
      )}

      {empty ? (
        <div className="text-xs text-muted-foreground">
          portfolio_top_cards row 없음 (card_type=&apos;{cardType}&apos;,
          card_index={slot.cardIndex})
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <PreviewBlock title="main_title">{fmt(row.main_title)}</PreviewBlock>
          <PreviewBlock title="sub_title">{fmt(row.sub_title)}</PreviewBlock>
          <PreviewBlock title="role_description">
            {fmt(row.role_description)}
          </PreviewBlock>
          <PreviewBlock title="report">{fmt(row.report)}</PreviewBlock>
          <PreviewBlock title="insight">{fmt(row.insight)}</PreviewBlock>
          <PreviewBlock title="platform · contribution">
            {fmt(row.platform)} · contribution {fmt(row.contribution)}
          </PreviewBlock>
          <PreviewBlock title="period (start → end)">
            {formatPeriod({
              startY: row.period_start_year,
              startM: row.period_start_month,
              startD: row.period_start_day,
              endY: row.period_end_year,
              endM: row.period_end_month,
              endD: row.period_end_day,
            })}
          </PreviewBlock>
          <PreviewBlock title="roles (text[])">
            <StringArray values={row.roles} />
          </PreviewBlock>
          <PreviewBlock title="tools (text[])">
            <StringArray values={row.tools} />
          </PreviewBlock>
          <PreviewBlock title="main_image_url">
            <div className="flex gap-2">
              <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded border bg-muted/30">
                {isRenderableImageUrl(row.main_image_url) ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={row.main_image_url ?? ""}
                    alt="main"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="break-all px-1 text-center text-[9px] text-muted-foreground">
                    —
                  </span>
                )}
              </div>
              <div className="flex flex-1 flex-col gap-0.5 break-words">
                <div className="break-all text-[10px] text-muted-foreground">
                  {fmt(row.main_image_url)}
                </div>
                <div className="text-[10px]">
                  caption: {fmt(row.main_image_caption)}
                </div>
              </div>
            </div>
          </PreviewBlock>
          <PreviewBlock title="sub_image_urls (text[]) · captions">
            <ImageGrid
              urls={row.sub_image_urls}
              captions={row.sub_image_captions}
            />
          </PreviewBlock>
          <PreviewBlock title="metrics (text[])">
            <StringArray values={row.metrics} />
          </PreviewBlock>
          <PreviewBlock title="links (text[])">
            <StringArray values={row.links} />
          </PreviewBlock>
          <div className="mt-1 text-[10px] text-muted-foreground">
            id <code className="font-mono">{row.id}</code> · card_type{" "}
            <code className="font-mono">{row.card_type}</code> · updated{" "}
            <code className="font-mono">{row.updated_at ?? "—"}</code>
          </div>
        </div>
      )}
    </div>
  );
}

export default function TopCardsList({
  slots,
  cardType,
}: {
  slots: TopCardSlot[];
  cardType: TopCardType;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
      {slots.map((slot) => (
        <TopSlotCard
          key={`${cardType}-${slot.cardIndex}`}
          slot={slot}
          cardType={cardType}
        />
      ))}
    </div>
  );
}
