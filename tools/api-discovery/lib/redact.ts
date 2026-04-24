const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "proxy-authorization"
]);

/** Every header name → value (Fetch `Headers` collapses duplicate names to last value). */
export function fullHeaders(
  headers: Headers | Record<string, string | undefined>
): Record<string, string> {
  const input = headers instanceof Headers ? headers : new Headers(headers as HeadersInit);
  const out: Record<string, string> = {};
  input.forEach((value, name) => {
    out[name] = value;
  });
  return out;
}

export function redactHeaders(
  headers: Headers | Record<string, string | undefined>
): Record<string, string> {
  const input = headers instanceof Headers ? headers : new Headers(headers as HeadersInit);
  const out: Record<string, string> = {};
  input.forEach((value, name) => {
    if (SENSITIVE_HEADER_NAMES.has(name.toLowerCase())) {
      return;
    }
    out[name] = value;
  });
  return out;
}
