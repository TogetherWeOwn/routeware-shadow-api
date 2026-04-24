export function applyBrowserHeaders(headers: Headers, upstreamOrigin: string): void {
  headers.set(
    "User-Agent",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
  );
  headers.set("Accept", "*/*");
  headers.set("Accept-Language", "en-US,en;q=0.9");
  headers.set("Accept-Encoding", "gzip, deflate, br");
  headers.set("Cache-Control", "no-cache");
  headers.set("Pragma", "no-cache");
  headers.set("Sec-CH-UA", '"Chromium";v="121", "Not(A:Brand";v="24"');
  headers.set("Sec-CH-UA-Mobile", "?0");
  headers.set("Sec-CH-UA-Platform", '"Windows"');
  headers.set("X-Requested-With", "XMLHttpRequest");
  headers.set("Referer", `${upstreamOrigin}/WebRW/`);
  headers.set("Origin", upstreamOrigin);
}
