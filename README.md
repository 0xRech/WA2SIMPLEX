<div align="center">

# WA2SimpleX

### WhatsApp conversations in SimpleX — one chat per contact.

[![Status](https://img.shields.io/badge/status-public%20alpha-orange)](https://github.com/0xRech/WA2SIMPLEX)
[![Version](https://img.shields.io/badge/version-0.2.0--alpha.1-blue)](https://github.com/0xRech/WA2SIMPLEX)
[![CI](https://github.com/0xRech/WA2SIMPLEX/actions/workflows/ci.yml/badge.svg)](https://github.com/0xRech/WA2SIMPLEX/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-22.13%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**Self-hosted · official WhatsApp Cloud API · SimpleX CLI · persistent local routing · no message-history database**

> **Public Alpha** — experimental software. Expect breaking changes, incomplete media support and rough edges. Do not treat the current release as production-ready.

</div>

---

## What is WA2SimpleX?

WA2SimpleX is a self-hosted bridge between the **official WhatsApp Cloud API** and **SimpleX Chat**.

Starting with **v0.2**, WhatsApp conversations no longer need to share one bridge chat. WA2SimpleX creates a dedicated private SimpleX group for each WhatsApp contact and routes messages based on that group.

```text
WhatsApp                         WA2SimpleX                         SimpleX

Max ───────────────┐                                        ┌── WA · Max · 4567
                   │        ┌─────────────────────┐         │
Leonie ────────────┼───────►│ Contact Router      │─────────┼── WA · Leonie · 9012
                   │        │                     │         │
Kunde ─────────────┘        │ SQLite mappings     │         └── WA · Kunde · 1337
                            │ Webhook verification│
                            └─────────────────────┘
                                      │
                                      └────────────► WA2SimpleX Control
```

You simply open the matching SimpleX chat and type. No phone number, route marker or reply command is normally required.

## v0.2 highlights

- **One SimpleX chat per WhatsApp contact.**
- Contact chats are created automatically on the first incoming WhatsApp message.
- WA2SimpleX invites your configured SimpleX contact as an admin to each generated group.
- Messages written in a mapped group are automatically sent to that WhatsApp contact.
- Dedicated **WA2SimpleX Control** chat with `/status`, `/contacts`, `/new`, `/archive`, `/unarchive`, `/repair` and `/wa`.
- Persistent SQLite mapping survives restarts.
- Persistent WhatsApp webhook deduplication.
- Mapping recovery from SimpleX group custom data when possible.
- Incoming messages automatically reactivate archived mappings.
- Local `/rename`, `/info`, `/archive` and `/help` commands in contact chats.
- Legacy v0.1 quoted-message routing remains available as a fallback.
- Meta `X-Hub-Signature-256` verification.
- Optional automatic WhatsApp read receipts.
- `/health` endpoint for monitoring.

## Important SimpleX behavior

A generated contact chat is a **private SimpleX group** containing the WA2SimpleX bot profile and your SimpleX account.

When WA2SimpleX sees a WhatsApp contact for the first time, SimpleX sends you a group invitation. **You must accept that invitation once for the new contact chat.** Until the group is joined, WA2SimpleX also mirrors incoming messages into the Control chat so the first messages are not missed.

After joining, normal conversation happens entirely inside the generated contact chat.

## Privacy model

WA2SimpleX is a bridge, not continuous end-to-end encryption across WhatsApp and SimpleX:

```text
WhatsApp E2EE / Cloud API
          ↓
     WA2SimpleX
          ↓
      SimpleX E2EE
```

The bridge process necessarily sees message plaintext while converting between the two networks.

WA2SimpleX itself does **not** maintain a message-history database. v0.2 stores only routing/operational metadata in SQLite:

- WhatsApp phone number
- WhatsApp/display name
- associated SimpleX group ID
- ready/archive state
- timestamps
- processed WhatsApp message IDs for deduplication

Message bodies are not written to the WA2SimpleX SQLite database.

## Requirements

- Linux VPS/server
- **Node.js 22.13+**
- SimpleX Chat CLI with WebSocket API
- Meta app with WhatsApp Cloud API enabled
- WhatsApp Business phone number / Phone Number ID
- public HTTPS endpoint for Meta webhooks

The SimpleX WebSocket must remain private/local.

## Quick start

### 1. Start SimpleX CLI

Install the current SimpleX CLI and start its local WebSocket API:

```bash
simplex-chat -p 5225
```

Do **not** expose port `5225` publicly.

Connect the bridge SimpleX profile to your personal SimpleX account and determine its contact ID, for example `@2`.

### 2. Install WA2SimpleX

```bash
git clone https://github.com/0xRech/WA2SIMPLEX.git
cd WA2SIMPLEX
npm install
cp .env.example .env
nano .env
npm start
```

Minimal configuration:

```dotenv
WHATSAPP_VERIFY_TOKEN=a-long-random-value-you-choose
WHATSAPP_ACCESS_TOKEN=your-meta-access-token
WHATSAPP_PHONE_NUMBER_ID=your-phone-number-id
WHATSAPP_APP_SECRET=your-meta-app-secret
WHATSAPP_API_VERSION=v23.0

SIMPLEX_WS_URL=ws://127.0.0.1:5225
SIMPLEX_CONTROL_TARGET=@2
SIMPLEX_GROUP_PREFIX=WA

DB_PATH=./data/wa2simplex.db
```

`SIMPLEX_CONTROL_TARGET` must currently be a direct SimpleX contact (`@<id>`), because that contact is invited into generated WhatsApp contact groups.

### 3. Configure Meta webhook

Expose only the WA2SimpleX HTTP server through HTTPS, for example:

```text
https://bridge.example.com/webhook
```

Configure in the Meta app:

- Callback URL: `https://bridge.example.com/webhook`
- Verify token: value of `WHATSAPP_VERIFY_TOKEN`
- Subscribe to the `messages` webhook field

Health endpoint:

```text
https://bridge.example.com/health
```

## Everyday use

First message from a new WhatsApp contact:

```text
WhatsApp: Max Mustermann
        ↓
WA2SimpleX creates:
WA · Max Mustermann · 4567
```

Accept the SimpleX group invitation once. After that:

```text
WA · Max Mustermann · 4567

Max: Hallo, bist du da?
You: Ja, bin da 👍
```

Your plain SimpleX reply is routed back to Max on WhatsApp.

## Control chat

Your configured direct chat (`SIMPLEX_CONTROL_TARGET`) acts as the WA2SimpleX Control channel.

```text
/status
/contacts
/new +491701234567 Max
/archive +491701234567
/unarchive +491701234567
/repair +491701234567
/wa +491701234567 Hallo 👋
/help
```

`/new` creates a mapped SimpleX contact chat without immediately sending a WhatsApp message.

## Contact-chat commands

Inside a generated WhatsApp contact chat:

```text
/info
/rename Max Arbeit
/archive
/help
```

Any message beginning with `/` is treated as a local WA2SimpleX command and is **not** forwarded to WhatsApp.

## systemd example

Use a persistent state directory for SQLite:

```ini
[Unit]
Description=WA2SimpleX bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/WA2SIMPLEX
EnvironmentFile=/opt/WA2SIMPLEX/.env
Environment=DB_PATH=/var/lib/wa2simplex/wa2simplex.db
ExecStart=/usr/bin/node /opt/WA2SIMPLEX/src/index.js
Restart=on-failure
RestartSec=5
StateDirectory=wa2simplex
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

Run the SimpleX CLI as a separate service/user on the same host and keep its WebSocket bound to localhost.

## Docker

```bash
docker build -t wa2simplex .
docker run --rm \
  --network host \
  --env-file .env \
  -v wa2simplex-data:/app/data \
  wa2simplex
```

The volume preserves contact mappings and webhook deduplication across container restarts.

## Security notes

1. Never commit `.env`, tokens or app secrets.
2. Never expose SimpleX port `5225` publicly.
3. Put `/webhook` behind HTTPS.
4. Keep the VPS, Node.js and SimpleX CLI patched.
5. Back up the SQLite routing DB if preserving contact mappings matters to you.
6. Treat the VPS as a trusted endpoint: the bridge necessarily processes message plaintext.
7. See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Current limitations

- Text is bidirectional.
- WhatsApp images/documents/audio/video currently appear as readable notices/captions; binary media bridging is not implemented yet.
- SimpleX attachments are not yet uploaded to WhatsApp.
- A newly generated SimpleX contact group requires a one-time invitation acceptance.
- Outbound WhatsApp messages remain subject to Meta/WhatsApp Business Platform conversation and template rules.
- v0.2 is still alpha and has not been load-tested at large scale.

## Roadmap

- [x] WhatsApp → SimpleX text
- [x] SimpleX → WhatsApp text
- [x] One SimpleX chat per WhatsApp contact
- [x] Persistent SQLite routing
- [x] Control chat
- [x] Persistent webhook deduplication
- [ ] Bidirectional image transfer
- [ ] Documents and files
- [ ] Voice messages / audio
- [ ] Video
- [ ] Better delivery/read-state synchronization
- [ ] Multi-number / multi-user routing

## Development

```bash
npm run check
npm test
npm run dev
```

## Disclaimer

WA2SimpleX is an independent open-source project and is **not affiliated with, endorsed by, or sponsored by Meta, WhatsApp or SimpleX Chat**. WhatsApp and SimpleX are trademarks of their respective owners.

Use of the WhatsApp Business Platform is subject to Meta's applicable terms and policies.

## License

MIT — see [LICENSE](LICENSE).
