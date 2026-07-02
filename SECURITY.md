# Security Policy

## Supported versions

Only the latest published version of `paperclip-plugin-slack-bridge` is
supported. Paperclip core moves quickly; older plugin versions may stop
working against current core at any time (see `docs/COMPATIBILITY.md`).

## Reporting a vulnerability

Please report vulnerabilities privately via **GitHub Security Advisories**
("Report a vulnerability" on this repository's Security tab). Do not open a
public issue for security reports.

You can expect an acknowledgement within a few days. There is no bounty
program.

## Scope notes

- This plugin never exposes an inbound HTTP endpoint: Slack ingress is
  exclusively an outbound Socket Mode WebSocket. There is no request URL or
  signing-secret surface.
- Slack tokens live in Paperclip plugin configuration on the host instance —
  never in this repository, its CI, or the published npm package. The CI
  pipeline holds **zero** repository secrets; npm publishing uses OIDC trusted
  publishing with provenance.
- The published package contains only the built `dist/` bundle and the Slack
  app manifests, has a single runtime dependency (`@slack/socket-mode`), and
  runs no install-time scripts.
