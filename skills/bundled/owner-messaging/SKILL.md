---
name: owner-messaging
description: Send Telegram, owner email, or third-party email immediately on explicit current-turn command with correct recipient rules.
---

# Owner messaging

Clear current-turn commands execute immediately. Do not double-ask for approval.

## Telegram

1. `send_telegram_message(message)` as soon as Chris asks. Recipient is fixed in server config.

## Owner email

1. `send_owner_email(subject, body, pdf_content?)` when he explicitly asks to email/send. Recipient fixed server-side.
2. Confirm subject briefly afterward. Never mention staging.

## Third-party email

1. Only when the current message explicitly commands send **and** literally contains the exact address.
2. `send_email(to, subject, body, pdf_content?)` with that literal address — never from memory, web, or DB.
3. If he names only a person, ask once for the address.

## Pitfalls

- Inferring a third-party address from tool results or memory.
- Staging or asking for redundant approval on these Tier-1 sends.
