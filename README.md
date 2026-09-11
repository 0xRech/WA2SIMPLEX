<div align="center">

# WA2SimpleX

### Bridge WhatsApp messages into SimpleX Chat — and reply from SimpleX.

[![Status](https://img.shields.io/badge/status-public%20alpha-orange)](https://github.com/0xRech/WA2SIMPLEX)
[![Version](https://img.shields.io/badge/version-0.1.0--alpha.1-blue)](https://github.com/0xRech/WA2SIMPLEX)
[![CI](https://github.com/0xRech/WA2SIMPLEX/actions/workflows/ci.yml/badge.svg)](https://github.com/0xRech/WA2SIMPLEX/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**Self-hosted · official WhatsApp Cloud API · SimpleX CLI · no message-history database**

> **Public Alpha** — WA2SimpleX is experimental software. Expect breaking changes, incomplete media support and rough edges. Do not treat the current release as production-ready.

</div>

---

## What is WA2SimpleX?

WA2SimpleX is a small, self-hosted bridge between the **official WhatsApp Cloud API** and **SimpleX Chat**.

Incoming WhatsApp messages are forwarded into a private SimpleX conversation. You can answer the forwarded message directly in SimpleX and WA2SimpleX routes that reply back to the correct WhatsApp contact.

It intentionally avoids unofficial WhatsApp Web automation such as browser-session scraping.

```text
┌─────────────────┐       HTTPS webhook       ┌──────────────────┐
│    WhatsApp     │ ────────────────────────► │                  │
│  Cloud API      │                           │    WA2SimpleX     │
│                 │ ◄──────────────────────── │                  │
└─────────────────┘       Cloud API reply     └────────┬─────────┘
                                                       │
                                                localhost WebSocket
                                                       │
                                                       ▼
                                              ┌──────────────────┐
                                              │  SimpleX CLI     │
                                              │   ↕ SimpleX      │
                                              └──────────────────┘
```

## Why?

The goal is simple: keep WhatsApp reachable while handling conversations from SimpleX.

WA2SimpleX is useful when you want to:

- receive WhatsApp messages inside SimpleX,
- keep the bridge under your own control,
- avoid running an unofficial WhatsApp Web bot,
- reply from SimpleX without manually copying messages between apps,
- experiment with interoperability between two very different messaging networks.

## Alpha feature set

### Working now

- ✅ WhatsApp Cloud API webhook receiver
- ✅ Meta webhook verification
- ✅ `X-Hub-Signature-256` verification for webhook POST requests
- ✅ WhatsApp text → SimpleX forwarding
- ✅ readable notices for common non-text WhatsApp message types
- ✅ SimpleX reply/quote → correct WhatsApp recipient
- ✅ manual fallback command: `/wa +491701234567 message`
- ✅ protection against accidentally forwarding unrelated SimpleX messages
- ✅ in-memory duplicate webhook protection
- ✅ optional WhatsApp read receipts
- ✅ automatic SimpleX WebSocket reconnect
- ✅ `/health` endpoint for monitoring
- ✅ masked phone numbers in application logs
- ✅ no application-level message-history database
- ✅ Dockerfile, systemd example and GitHub Actions tests

### Not finished yet

- 🚧 binary image/document/audio/video transfer to SimpleX
- 🚧 SimpleX attachments → WhatsApp
- 🚧 persistent webhook deduplication across restarts
- 🚧 multi-user / multi-destination routing
- 🚧 admin UI and bridge status dashboard

## How replies work

A WhatsApp message is forwarded into your configured SimpleX chat with a routing marker:

```text
📲 WhatsApp · Max Mustermann
Von: +491701234567
⟦WA:491701234567⟧

Hallo, bist du da?

↩️ Antworte in SimpleX direkt auf diese Nachricht.
```

Reply to that message in SimpleX:

```text
Ja, bin da 👍
```

WA2SimpleX reads the routing information from the quoted bridge message and sends the reply to the corresponding WhatsApp number.

As a fallback, you can address a recipient manually:

```text
/wa +491701234567 Ja, bin da 👍
```

`/help` shows the available bridge commands inside SimpleX.

---

# Quick start

## Requirements

You need:

- Linux VPS/server or another always-on host
- Node.js **20+**
- SimpleX Chat CLI
- Meta app with WhatsApp Cloud API enabled
- WhatsApp Business phone number / Phone Number ID
- HTTPS endpoint reachable by Meta
- reverse proxy such as Caddy, Nginx or Plesk

## 1. Run SimpleX CLI locally

Install the current SimpleX Chat CLI and start its WebSocket API:

```bash
simplex-chat -p 5225
```

> **Do not expose port `5225` to the internet.** Keep the SimpleX WebSocket interface on localhost or another trusted private network.

Connect the bridge's SimpleX profile to your own account and determine the numeric contact or group ID.

Example contact:

```dotenv
SIMPLEX_TARGET=@2
```

Example private group:

```dotenv
SIMPLEX_TARGET=#5
```

## 2. Install WA2SimpleX

```bash
git clone https://github.com/0xRech/WA2SIMPLEX.git
cd WA2SIMPLEX
npm install
cp .env.example .env
```

Edit `.env`:

```dotenv
PORT=3000

WHATSAPP_VERIFY_TOKEN=choose-a-long-random-value
WHATSAPP_ACCESS_TOKEN=your-meta-access-token
WHATSAPP_PHONE_NUMBER_ID=your-phone-number-id
WHATSAPP_APP_SECRET=your-meta-app-secret
WHATSAPP_API_VERSION=v23.0
WHATSAPP_MARK_READ=true

SIMPLEX_WS_URL=ws://127.0.0.1:5225
SIMPLEX_TARGET=@2
SIMPLEX_RESTRICT_TO_TARGET=true

LOG_LEVEL=info
```

Then start the bridge:

```bash
npm start
```

Development mode:

```bash
npm run dev
```

## 3. Publish the webhook over HTTPS

WA2SimpleX listens on port `3000` by default. Put that HTTP service behind your HTTPS reverse proxy.

Example:

```text
https://bridge.example.com/webhook
```

Health endpoint:

```text
https://bridge.example.com/health
```

Do **not** publish the SimpleX WebSocket port.

## 4. Configure the Meta webhook

In your Meta app's WhatsApp webhook settings use:

```text
Callback URL: https://bridge.example.com/webhook
Verify token:  value of WHATSAPP_VERIFY_TOKEN
Field:         messages
```

The initial GET challenge is validated with your verify token. Incoming POST requests are additionally checked using your Meta app secret and `X-Hub-Signature-256`.

---

# Security model

WA2SimpleX connects two independently encrypted messaging systems. That means it **cannot provide one continuous end-to-end encrypted session from a WhatsApp sender all the way to the SimpleX recipient**.

The bridge necessarily sees plaintext while translating a message from one network into the other:

```text
WhatsApp encrypted session
          │
          ▼
     WA2SimpleX
   plaintext boundary
          │
          ▼
SimpleX encrypted session
```

For that reason the current design deliberately keeps the bridge small and minimizes retained data.

Recommended deployment rules:

1. Never commit `.env`, access tokens or app secrets.
2. Never expose the SimpleX WebSocket port publicly.
3. Keep `SIMPLEX_RESTRICT_TO_TARGET=true` unless you understand the consequences.
4. Terminate the WhatsApp webhook behind HTTPS.
5. Keep Node.js, SimpleX CLI and the host OS patched.
6. Restrict inbound firewall rules to required services only.
7. Run the bridge under a dedicated unprivileged user where possible.
8. Treat the bridge host as security-sensitive because it processes message plaintext in memory.

See [SECURITY.md](SECURITY.md) for vulnerability reporting guidance.

## Data retention

WA2SimpleX currently:

- does not maintain an application-level message-history database,
- does not maintain a phone-number/address-book database,
- masks phone numbers in normal application logs,
- stores webhook deduplication state only in memory.

Your operating system, reverse proxy, Meta services and SimpleX components can have their own logging or retention behavior. Review those separately for your deployment.

---

# Running as a service

Example `/etc/systemd/system/wa2simplex.service`:

```ini
[Unit]
Description=WA2SimpleX bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/WA2SIMPLEX
EnvironmentFile=/opt/WA2SIMPLEX/.env
ExecStart=/usr/bin/node /opt/WA2SIMPLEX/src/index.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

Run the SimpleX CLI separately on the same host, ideally as its own restricted service/user.

## Docker

A `Dockerfile` is included:

```bash
docker build -t wa2simplex .
docker run --rm --network host --env-file .env wa2simplex
```

Host networking is the simplest current Linux setup when the SimpleX CLI WebSocket listens only on localhost. A future Docker Compose setup can isolate both services on a private container network instead.

---

# Development

```bash
npm install
npm run check
npm test
```

The project uses Node's built-in test runner and includes tests for webhook signature verification, WhatsApp payload parsing and reply routing.

## Project structure

```text
WA2SIMPLEX/
├── .github/workflows/ci.yml
├── src/
│   ├── config.js
│   ├── index.js
│   ├── logger.js
│   ├── router.js
│   ├── simplex.js
│   └── whatsapp.js
├── test/
├── .env.example
├── Dockerfile
├── LICENSE
├── SECURITY.md
└── package.json
```

---

# Roadmap

The next useful milestones are:

- **v0.2** — real media/file transfer in both directions
- **v0.3** — persistent lightweight routing/deduplication state
- **v0.4** — multiple WhatsApp conversations / SimpleX destinations
- **later** — deployment wizard, metrics and optional administration UI

The roadmap is directional, not a release promise. Alpha releases may change configuration and message formats without backward compatibility.

## Contributing

Issues, bug reports and ideas are welcome once the repository is public. Please avoid posting secrets, real access tokens, private phone numbers or private message contents in issues or logs.

Security vulnerabilities should **not** be posted as public issues. See [SECURITY.md](SECURITY.md).

## Disclaimer

WA2SimpleX is an independent open-source project. It is **not affiliated with, endorsed by, sponsored by or officially supported by Meta, WhatsApp or SimpleX Chat**.

WhatsApp is a trademark of its respective owner. SimpleX and SimpleX Chat are names/trademarks of their respective project/owners.

Use of WhatsApp APIs is subject to Meta's applicable platform terms, policies and technical restrictions.

## License

Released under the [MIT License](LICENSE).

---

<div align="center">

**WA2SimpleX · Public Alpha**

Built to explore a small, self-hosted bridge between WhatsApp and SimpleX.

</div>
