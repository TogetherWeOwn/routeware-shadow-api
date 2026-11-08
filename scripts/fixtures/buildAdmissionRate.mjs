// Sanitized synthetic baseline, never a sampled token/credential/quota probe.
export function rateHeaders(change = {}) {
  return {
    "x-ratelimit-limit": "1000",
    "x-ratelimit-remaining": "999",
    "x-ratelimit-used": "1",
    "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
    "x-ratelimit-resource": "core",
    ...change
  };
}
