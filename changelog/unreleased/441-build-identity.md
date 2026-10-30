- #441: Responses can expose an optional `X-Build-Version` deployment identity
  from the `BUILD_VERSION` binding. Deployment builds use separate, non-Latest
  `build/vYYYY.MDD.P` releases; the SemVer API version, health JSON and consumer
  release policy remain unchanged. Production publication remains disabled.
