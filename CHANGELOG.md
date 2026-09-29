# Changelog

## Unreleased

- Added an opt-in `import_codex_config` setting on a codex provider. The account then follows the
  Codex CLI's own `$CODEX_HOME/config.toml`: the `model_provider` base URL, the token Codex would
  send, the configured `model`, and its declared context windows. `requires_openai_auth = false`
  also stops that account from sending this machine's OpenAI credentials, and a Codex file that
  cannot be read refuses the load instead of silently keeping the route it replaced.
- Added required local-plugin author/category metadata and an authenticated, generation-bound PNG
  icon capability for local and remote `rig-connect` catalog clients. This is a hard protocol 5
  cut: older Happy clients are incompatible, legacy manifests without `author`, `category`, or a
  valid bounded square PNG no longer load, and Happy must bump `@slopus/rig-connect` in lockstep
  before consuming the new catalog contract.
- Added protocol version 6 installation discovery for Happy onboarding, including stable Happy Agent data
  epochs, offline CLI inspection, explicit schema compatibility, and bounded browser-safe
  rig-connect discovery.
- Added strict local Happy Cloud enrollment records, independent default-denied capability consent,
  bounded opaque encrypted-payload storage, and live rig-connect reconciliation.
- Added parsed OSC 8 hyperlink metadata to Ghostty snapshot cells and preserved it through remote
  semantic-grid keyframes, patches, reconnect recovery, resize snapshots, and scrollback.

## 0.0.57 — 2026-07-25

- Added durable, first-class session archiving to the daemon, including archive and unarchive
  routes, filtered listings, restart persistence, user-message auto-unarchive, and global
  reconciliation events.
