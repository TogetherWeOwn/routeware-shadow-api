export {};

declare global {
  interface Env {
    /** Optional deployment identity, not the SemVer API contract. */
    BUILD_VERSION?: string;
  }
}
