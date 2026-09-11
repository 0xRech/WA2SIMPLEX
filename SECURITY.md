# Security Policy

WA2SimpleX processes messages between WhatsApp and SimpleX and therefore sits on a sensitive trust boundary. Security reports are welcome and should be handled privately whenever possible.

## Supported versions

WA2SimpleX is currently in **public alpha**. Only the latest code on the default branch is considered actively maintained during the alpha phase.

| Version | Supported |
| --- | --- |
| latest `main` / current alpha | ✅ |
| older alpha snapshots | ❌ best effort only |

## Reporting a vulnerability

Please **do not open a public GitHub issue** for vulnerabilities that could expose credentials, message contents, phone numbers, authentication material, remote-code-execution paths or other sensitive data.

Preferred reporting path:

1. Use GitHub's private vulnerability reporting feature for this repository if it is available.
2. If private vulnerability reporting is not available, contact the maintainer through a private contact method listed on the maintainer's GitHub profile.
3. Include a concise description, affected component/version, reproduction steps and the impact you believe is possible.
4. Remove or redact real WhatsApp access tokens, Meta app secrets, private SimpleX data, phone numbers and message contents from screenshots/logs unless they are strictly required to understand the issue.

Please allow reasonable time to investigate and patch a confirmed issue before publishing technical details.

## Sensitive configuration

Never commit or publish:

- `.env`
- `WHATSAPP_ACCESS_TOKEN`
- `WHATSAPP_APP_SECRET`
- private webhook verification values
- private SimpleX profile/database material
- real message contents or phone numbers from production use

If a credential is accidentally exposed, rotate/revoke it immediately. Removing it from the latest Git commit is not sufficient because it may remain in Git history, forks, caches or logs.

## Deployment security

For current alpha deployments:

- keep the SimpleX WebSocket API private and bound to localhost/trusted networking,
- put the WhatsApp webhook behind HTTPS,
- keep `SIMPLEX_RESTRICT_TO_TARGET=true` unless you intentionally change the routing model,
- use an unprivileged service account,
- keep dependencies and the host operating system patched,
- review reverse-proxy and system logs for unintended retention of sensitive metadata.

## Encryption boundary

WA2SimpleX bridges two separate encrypted networks. The bridge must process message plaintext in memory to translate between WhatsApp and SimpleX. It therefore does **not** create one continuous end-to-end encrypted channel across both systems.

This limitation is part of the architecture and should be considered when choosing where and how to deploy the bridge.
