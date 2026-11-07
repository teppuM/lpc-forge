/**
 * Verdicts on parts whose animations were rebuilt by a tool and still want a
 * person's eye. Kept in this browser on this device, like saved characters, and
 * copied or saved as text when the person wants to hand them over.
 */
export type Verdict = "good" | "needs-work";

export type AnimationReview = {
  readonly verdict?: Verdict;
  readonly note?: string;
  readonly body?: string;
};

export type Reviews = Readonly<
  Record<string, Readonly<Record<string, AnimationReview>>>
>;

export type FlagState = "unchecked" | "good" | "needs-work";

const STORAGE_KEY = "lpc-forge-review";

export function readReviews(): Reviews {
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(STORAGE_KEY) ?? "{}",
    );
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Reviews)
      : {};
  } catch {
    return {};
  }
}

/** False when the browser would not keep it: private window, or out of room. */
export function writeReviews(reviews: Reviews): boolean {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(reviews));
    return true;
  } catch {
    return false;
  }
}

function withAnimation(
  reviews: Reviews,
  itemId: string,
  animation: string,
  entry: AnimationReview,
): Reviews {
  const part = { ...reviews[itemId] };
  if (entry.verdict || entry.note) part[animation] = entry;
  else delete part[animation];
  const next = { ...reviews, [itemId]: part };
  if (Object.keys(part).length === 0) delete next[itemId];
  return next;
}

/** Sets a verdict, or clears it when the same verdict is pressed again. */
export function toggleVerdict(
  reviews: Reviews,
  itemId: string,
  animation: string,
  verdict: Verdict,
  body: string,
): Reviews {
  const current = reviews[itemId]?.[animation];
  const entry: AnimationReview = {
    ...current,
    verdict: current?.verdict === verdict ? undefined : verdict,
    body,
  };
  return withAnimation(reviews, itemId, animation, entry);
}

export function setReviewNote(
  reviews: Reviews,
  itemId: string,
  animation: string,
  note: string,
  body: string,
): Reviews {
  const current = reviews[itemId]?.[animation];
  return withAnimation(reviews, itemId, animation, {
    ...current,
    note: note || undefined,
    body,
  });
}

/** The part's color of flag: any complaint wins, then all clear, then still to do. */
export function flagState(
  unchecked: readonly string[],
  review: Readonly<Record<string, AnimationReview>> | undefined,
): FlagState {
  const verdicts = unchecked.map((animation) => review?.[animation]?.verdict);
  if (verdicts.includes("needs-work")) return "needs-work";
  return verdicts.every((verdict) => verdict === "good") ? "good" : "unchecked";
}

export function isStillToCheck(
  unchecked: readonly string[],
  review: Readonly<Record<string, AnimationReview>> | undefined,
): boolean {
  return unchecked.some((animation) => !review?.[animation]?.verdict);
}

export type ReviewedPart = {
  readonly itemId: string;
  readonly name: string;
  readonly unchecked: readonly string[];
};

/** Plain text, one line per verdict, to paste into a message or keep as a file. */
export function reviewsToText(
  parts: readonly ReviewedPart[],
  reviews: Reviews,
  labelOf: (animation: string) => string,
): string {
  const lines: string[] = [];
  let done = 0;
  for (const { itemId, name, unchecked } of parts) {
    let any = false;
    for (const animation of unchecked) {
      const entry = reviews[itemId]?.[animation];
      if (!entry?.verdict && !entry?.note) continue;
      any = true;
      const verdict =
        entry.verdict === "good"
          ? "looks good"
          : entry.verdict === "needs-work"
            ? "needs work"
            : "note only";
      lines.push(
        [
          name,
          labelOf(animation),
          verdict,
          entry.body ?? "",
          entry.note ?? "",
          itemId,
        ].join(" | "),
      );
    }
    if (any) done += 1;
  }
  return [
    `LPC Forge review: ${done} of ${parts.length} flagged parts looked at`,
    "part | animation | verdict | body | note | id",
    ...lines,
  ].join("\n");
}
