import { snapshotNextLinkHeader } from "./snapshotNextLink";

type CustomerChangesCursor = { since: string; since_id: number };

export const customerChangesNextLinkHeader = {
  ...snapshotNextLinkHeader,
  description:
    'Optional continuation: <relative-target>; rel="next" exactly when nextCursor is non-null. ' +
    "Replaces since and since_id together and retains the effective limit, the normalized until bound and the validated fields selector. " +
    "A full terminal page may link to an empty page (no lookahead). Omission means stop. " +
    "Resolve against the same origin and fixed /api/v1/customer-snapshot/changes path."
};

/**
 * Separate composite feed contract; never copy request URLs, headers or
 * unknown keys. The caller passes the already-validated fields columns, or
 * nothing when the request omits the selector; an omitted selector keeps the
 * pre-existing three-key target byte-identical. A bounded page also passes
 * its normalized `until` so following the link cannot escape the window;
 * unbounded pages keep their previous target bytes.
 */
export function customerChangesNextLink(
  nextCursor: CustomerChangesCursor | null,
  limit: number,
  fields?: readonly string[],
  until?: string
): string | null {
  if (nextCursor === null) return null;
  const params = new URLSearchParams({
    since: nextCursor.since,
    since_id: String(nextCursor.since_id),
    limit: String(limit)
  });
  if (fields !== undefined) params.set("fields", fields.join(","));
  if (until !== undefined) params.set("until", until);
  return `</api/v1/customer-snapshot/changes?${params.toString()}>; rel="next"`;
}
