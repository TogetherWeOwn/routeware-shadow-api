import packageJson from "../../package.json";

/**
 * Single source of truth for the release version (TOG-5840).
 *
 * `package.json#version` is authoritative: the OpenAPI document
 * (`src/app.ts`) and anything else that reports a release version read it
 * from here, so bumping `package.json` moves the spec version with no other
 * edit. See `docs/VERSIONING.md` for the bump policy and `CHANGELOG.md` for
 * per-release notes.
 */
export const APP_VERSION: string = packageJson.version;
