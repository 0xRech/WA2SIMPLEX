# WhatsApp linked-device adapter (Rechgroup server extension)

This extension adds `WHATSAPP_PROVIDER=web` alongside the existing `cloud` provider.
It uses the community-maintained, unofficial `@whiskeysockets/baileys` package, pinned to
7.0.0-rc14 with an npm lockfile. WhatsApp protocol changes can require adapter updates.

## Configuration

```
WHATSAPP_PROVIDER=web
WHATSAPP_AUTH_PATH=./data/whatsapp/auth.db
WHATSAPP_QR_PATH=./data/whatsapp/pairing.txt
SIMPLEX_WS_URL=ws://127.0.0.1:5225
SIMPLEX_CONTROL_TARGET=
WHATSAPP_MARK_READ=false
```

Meta credentials, public HTTPS and a domain are not required in web mode. The HTTP webhook
returns 404 in this mode. Health remains local and reports `whatsappStatus` and
`routingConfigured` separately from process availability. Docker health does not certify
that WhatsApp pairing or the human SimpleX contact setup is complete.

An empty control target enables pairing-only operation: incoming content is not routed.
Once the user's personal SimpleX contact has been connected to the bridge profile,
set its actual `@<contactId>` and recreate the bridge container.

On this server:

```
wa2simplex-pair
wa2simplex-simplex contacts
```

Scan the QR with WhatsApp > Linked devices > Link a device. The QR is refreshed in a
private file, never included in application logs or served over HTTP. Ctrl+C exits the
terminal viewer without stopping the bridge. Credentials persist across container restarts.

`wa2simplex-simplex address` requests a SimpleX contact address for the bridge profile.
After connecting and accepting the contact, `wa2simplex-simplex contacts` shows the ID.
Edit `/srv/rechgroup/projects/wa2simplex/config/bridge.env`, set the intended owner as
`SIMPLEX_CONTROL_TARGET=@<ID>`, then run `wa2simplex-start`.

## Data and scope

- SQLite stores authentication keys transactionally with BufferJSON serialization.
  The auth database has mode 0600 and the process umask is 0077.
- No chat-history store is implemented. History synchronization is disabled and append
  events are ignored. Live incoming direct messages are processed in a bounded queue.
- Own messages, broadcasts, newsletters and view-once content are ignored. Group chats are supported as described below.
- LIDs are resolved through phone mappings; an unresolved LID is never treated as a number.
- Supported: direct text, images, video, audio, documents, stickers as incoming attachments,
  and static location text. Outgoing media uses the existing bridge MIME mapping.
- Reactions, edits, deletions, polls, calls and live locations are not synchronized.
- Incoming media is streamed with an enforced size limit before reaching the shared router.
- Logouts and replaced sessions require operator action. Transient disconnects retry with
  bounded backoff. Re-pairing must not erase a valid session without an explicit operator action.
- Backups now contain WhatsApp authentication keys as well as SimpleX state and settings.

## Validation and current limits

21 tests pass, including auth reopen/deletion, byte serialization, QR permissions, LID
mapping, history/own/group filtering, stream limits and the existing Cloud API tests.
Both provider HTTP paths were tested in containers. A live WhatsApp connection reached
QR pairing state on the server. Real-account pairing and SimpleX owner setup were completed on the Rechgroup server.
The operator confirmed successful bidirectional message tests. A real media roundtrip
has not been separately confirmed.

Development branch: `feature/whatsapp-web`.
The original Cloud API Docker image remains available as `rechgroup/wa2simplex:0.3.0-alpha.1`.


## WhatsApp groups

`WHATSAPP_GROUPS_ENABLED=true` enables group bridging for the web provider (default).
The first new incoming message from another member creates a separate SimpleX group
named `WA Gruppe · <subject> · <suffix>`. Accept its invitation once. Incoming text and
media captions identify the sender. Replies and files in that SimpleX group are sent
to the original WhatsApp group using the linked WhatsApp account.

WhatsApp participants are not invited to SimpleX. Membership changes, admin actions,
reactions, edits and history are not mirrored. WhatsApp permissions still apply, including
announcement-only groups. `/groups` lists already mapped groups; `/contacts` lists all
mapped chats. `/info`, `/archive`, `/rename` and `/repair #<SimpleX-group-ID>` work with
group routes. A subsequent WhatsApp subject refresh may update the local group title.

The existing SQLite `contacts.phone` column now holds either a telephone number or the
full group JID. No destructive migration is required, and existing direct mappings stay
unchanged. Recovery metadata version 3 includes chatId/kind and accepts legacy phone
metadata. LIDs and group JIDs are never converted into phone numbers. Cloud mode rejects
group destinations explicitly.

28 tests pass, covering routing separation, sender labels, group media, exact outbound
destinations, legacy metadata recovery and persistence. Deployment reconnects both
services successfully. A real group message/media roundtrip still needs operator testing.
Before rolling back to a version without group support, restore the matching pre-upgrade
database snapshot as well; older code does not understand group route keys.
