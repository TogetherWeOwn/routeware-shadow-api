import { snapshotNextLinkHeader } from "./snapshotNextLink";

type CustomerChangesCursor = { since: string; since_id: number };

export const customerChangesNextLinkHeader = {
  ...snapshotNextLinkHeader,
  description:
    'Optional continuation: <relative-target>; rel="next" exactly when nextCursor is non-null. ' +
    "Replaces since and since_id together and retains the effective limit. " +
    "A full terminal page may link to an empty page (no lookahead). Omission means stop. " +
    "Resolve against the same origin and fixed /api/v1/customer-snapshot/changes path."
};

/** Separate composite feed contract; never copy request URLs, headers or unknown keys. */
export function customerChangesNextLink(
  nextCursor: CustomerChangesCursor | null,
  limit: number
): string | null {
  if (nextCursor === null) return null;
  const params = new URLSearchParams({
    since: nextCursor.since,
    since_id: String(nextCursor.since_id),
    limit: String(limit)
  });
  return `</api/v1/customer-snapshot/changes?${params.toString()}>; rel="next"`;
}
