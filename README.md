# Baileys Custom Interactive Build

Base: **@whiskeysockets/baileys 7.0.0-rc13** (official, unmodified core).
Added: interactive / rich-message content types ported from **@gara31/void-baileys 3.0.8** (MIT).

This is an **unofficial community build**, not published or endorsed by WhiskeySockets. Not on npm — install locally (see below).

## What's different from official Baileys

- 100% plain JavaScript. No `.d.ts`, no `.d.ts.map`, no `.js.map` anywhere in the package.
- `Utils/messages.js` gained ~20 new content-type branches inside `generateWAMessageContent`
  (called by `sock.sendMessage(jid, content, options)`), listed below.
- All the *existing* official branches (poll, album, event, groupInvite, listReply, product,
  buttonReply, etc.) are **untouched** — you get official's newest/most correct behavior for
  everything that already existed, plus the new stuff on top.
- `sharp`, `fluent-ffmpeg`, and `adm-zip` are used by a few of the new branches (thumbnails,
  video preview frames, sticker-pack zipping). They're **lazy-loaded** and **optional** — the
  library works fine without them installed; you'll only get a clear error if you try to use a
  feature that needs one you haven't installed.

## Install

```bash
npm install ./void-baileys                # path to wherever you cloned/unzipped this repo
npm install sharp fluent-ffmpeg adm-zip    # optional, only if you use the features below
```

## New content types (pass as the `content` object to `sock.sendMessage(jid, content)`)

> ⚠️ Important quirk inherited from the source project: `generateWAMessageContent` is a plain
> `if / else if` chain and checks `text` **first**. If your content object has a bare top-level
> `text` key, it will always win and produce a normal text message — it will **not** fall
> through to `buttons`, `sections`, `carouselMessage`, etc. For those, put the body copy in the
> field the branch itself expects (e.g. `buttons` reads its own `text`/`footer` internally,
> `richMessage` uses `richMessage.text`) and don't also set a sibling top-level `text`.

| Key | Purpose |
|---|---|
| `buttonsMessage` | Raw buttons message wrapper (location/contact/etc. buttons) |
| `buttons` | Legacy quick-reply / call / URL buttons with `footer` |
| `templateButtons` | Template-style buttons |
| `interactiveButtons` | Modern native-flow interactive buttons (quick_reply, cta_url, single_select, etc.) |
| `nativeFlowMessage` | Low-level native flow button builder |
| `sections` | List message (title/buttonText/sections/rows) |
| `productList` | Product list message |
| `shop` | Shop/catalog surface message |
| `collection` | Collection message |
| `cards` | Card carousel (simple) |
| `carouselMessage` | Full carousel message |
| `richMessage` | AI-style rich response bubble — supports markdown-ish text, tables, code blocks, citations, hyperlinks, LaTeX via `[label](url)` / `[expr]<url>` syntax |
| `stickerPackMessage` | Build & send a sticker pack (zips stickers with `adm-zip`, needs `sharp`) |
| `adminInvite` | Newsletter admin invite |
| `keep` | Keep-in-chat message |
| `call` | Scheduled call creation message |
| `paymentInvite` | Payment invite message |
| `payment` | Request-payment message |
| `orderStatus` | Order status update (requires `image`) |
| `splitPayment` | Split payment interactive message |
| `ptv` | Send video as a round "video note" (PTV) |
| `order` | Order message |

## Example

```js
await sock.sendMessage(jid, {
  interactiveButtons: [
    { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Yes', id: 'yes' }) },
    { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'No', id: 'no' }) }
  ],
  title: 'Confirm?',
  text: 'Are you sure you want to continue?'
})

await sock.sendMessage(jid, {
  richMessage: {
    title: 'Bot',
    text: 'Here is a [source](https://example.com) for that.',
    footer: 'Generated'
  }
})
```

## High-level send helpers (`send`, `sendMedia`, `isIosSender`)

`lib/Utils/interactive-send.js` — exported from the package root. These are the same
`send`/`sendMedia`/`isIosSender` functions that used to live as hand-written `global.*`
functions in bot code; they're now part of the library itself, self-contained (no dependency
on `global`), and take the socket instance as an explicit first argument.

```js
import { send, sendMedia, isIosSender } from '@gara31/void-baileys'

await send(sock, jid, quotedMsg, 'Halo dunia', mentions)
await sendMedia(sock, jid, quotedMsg, imageBuffer, 'image/jpeg', 'caption here', mentions)
```

Behavior (unchanged from the original bot code):
- `isIosSender(quotedMsg)` — true if the quoted message's ID pattern matches an iOS-sent message.
- `send()` — sends a styled "interactive" text bubble (via `relayMessage` + a `viewOnceMessage`
  wrapping an `interactiveMessage`) on Android/Web senders; falls back to a plain
  `sock.sendMessage()` text for iOS senders, or automatically if building/sending the
  interactive payload throws.
- `sendMedia()` — same idea for image/video with a caption; falls back to a plain
  image/video message when there's no caption, the sender is iOS, or the interactive
  payload fails.

If your bot code did `global.send = ...` / `global.sendMedia = ...` manually before, just
import these three and assign them once instead — no other call sites need to change.

## Credits / licensing

- Baileys — WhiskeySockets — MIT — https://github.com/WhiskeySockets/Baileys
- void-baileys — gara31 — MIT (interactive/rich message logic ported into this build)

Please verify behavior against a real WhatsApp session before using in production; the ported
branches were validated for syntax and control-flow correctness against a mocked runtime
(no live WhatsApp connection was available in the build environment).
