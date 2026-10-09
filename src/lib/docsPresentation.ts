import type { ApiReferenceConfiguration } from "@scalar/hono-api-reference";

// Scalar serializes callbacks into the page: keep the slug closure-free and uninstrumented.
// https://scalar.com/products/api-references/configuration
export const scalarDocsConfiguration: Partial<ApiReferenceConfiguration> = {
  pageTitle: "Routeware Shadow API",
  url: "/openapi.json",
  theme: "none",
  showSidebar: true,
  hideTestRequestButton: false,
  authentication: { preferredSecurityScheme: "bearerAuth" },
  persistAuth: true,
  defaultHttpClient: { targetKey: "shell", clientKey: "curl" },
  generateOperationSlug: /* istanbul ignore next */ (operation) =>
    operation.operationId || `${operation.method}${operation.path}`,
  // Official theme tokens; the logo lives in our HTML, not a Scalar DOM selector.
  // https://scalar.com/products/api-references/themes
  customCss: `
    .light-mode {
      --scalar-color-accent: #075985;
      --scalar-background-accent: #e0f2fe;
      --scalar-background-1: #ffffff;
      --scalar-background-2: #f0f9ff;
    }
    .dark-mode {
      --scalar-color-accent: #7dd3fc;
      --scalar-background-accent: #0c4a6e;
      --scalar-background-1: #0f172a;
      --scalar-background-2: #172554;
    }
    .sidebar {
      --scalar-sidebar-background-1: var(--scalar-background-2);
      --scalar-sidebar-color-active: var(--scalar-color-accent);
      --scalar-sidebar-item-hover-color: var(--scalar-color-accent);
    }
    .routeware-docs-header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 12px 24px;
      padding: 16px 24px;
      background: #0c4a6e;
      color: #f0f9ff;
      font: 14px/1.5 system-ui, sans-serif;
    }
    .routeware-docs-brand { display: flex; align-items: center; gap: 12px; }
    .routeware-docs-brand strong { display: block; font-size: 18px; }
    .routeware-docs-logo { display: inline-flex; flex-shrink: 0; }
    .routeware-docs-header nav { display: flex; flex-wrap: wrap; gap: 16px; }
    .routeware-docs-header a { color: #f0f9ff; text-underline-offset: 4px; }
    .routeware-docs-header a:focus-visible { outline: 2px solid #7dd3fc; outline-offset: 4px; }
    .routeware-docs-header p { flex-basis: 100%; margin: 0; }
  `
};

// A replaceable logo slot, with a local mark and visible text (no image/CDN request).
const docsHeader = `
<header class="routeware-docs-header" data-scalar-scroll-header>
  <div class="routeware-docs-brand">
    <span class="routeware-docs-logo" aria-hidden="true">
      <svg width="36" height="36" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="36" height="36" rx="8" fill="#e0f2fe"/>
        <path d="M11 27V9h8a5 5 0 0 1 0 10h-8m8 0 7 8" stroke="#075985" stroke-width="3" stroke-linejoin="round"/>
      </svg>
    </span>
    <div><strong>Routeware Shadow API</strong><span>Interactive API reference</span></div>
  </div>
  <nav aria-label="Try-it examples">
    <a href="#tag/meta/health">Try health</a>
    <a href="#tag/customer-snapshot/listCustomerSnapshot">Browse snapshot rows</a>
    <a href="/openapi.json">OpenAPI JSON</a>
  </nav>
  <p>Start with public health. To browse cached snapshot rows, authorize with your SHADOW_API_READ_TOKEN. Test Request is available on every operation; imports and syncs change data.</p>
</header>`;

export async function withDocsBranding(response: Response): Promise<Response> {
  const html = await response.text();
  return new Response(html.replace("<body>", `<body>${docsHeader}`), response);
}
