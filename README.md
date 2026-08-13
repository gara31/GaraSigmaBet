<div align="center">

<img src="https://c.termai.cc/i135/QkXlhm4.jpg" alt="kanaraa-baileys banner" width="100%" />

# @kanaraa/baileys

### Modded Baileys v7 — Pesan Interaktif, AI Rich Response & More

[![npm version](https://img.shields.io/npm/v/@kanaraa/baileys?color=CB3837&logo=npm&logoColor=white&style=for-the-badge)](https://www.npmjs.com/package/@kanaraa/baileys)
[![npm downloads](https://img.shields.io/npm/dm/@kanaraa/baileys?color=CB3837&logo=npm&logoColor=white&style=for-the-badge)](https://www.npmjs.com/package/@kanaraa/baileys)
[![ESM](https://img.shields.io/badge/ESM-only-F7DF1E?logo=javascript&logoColor=black&style=for-the-badge)](#)

---

**Build modifikasi dari [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys)**
dengan dukungan native untuk pesan interaktif, album, AI rich response, newsletter, status mention, dan berbagai utilitas tambahan.

Package ini adalah **distribusi/build repo** untuk `@kanaraa/baileys`.
Berisi file runtime yang sudah dikompilasi di `lib/` dan protobuf di `WAProto/`, dirancang untuk digunakan langsung dari npm.

</div>

---

## Daftar Isi

- [Fitur](#fitur)
- [Persyaratan](#persyaratan)
- [Isi Package](#isi-package)
- [Instalasi](#instalasi)
- [Quick Start](#quick-start)
- [Referensi API Socket](#referensi-api-socket)
- [Referensi Event](#referensi-event)
- [Utilitas](#utilitas)

---

## Fitur

| Fitur | Deskripsi | Status |
|---|---|---|
| **Pesan Interaktif** | Flow button native, list/select menu, carousel | Ya |
| **Album Messages** | Multi-image/video album dengan metadata | Ya |
| **AI Rich Response** | `sendTable`, `sendList`, `sendCodeBlock`, `sendRichMessage` | Ya |
| **Unified Response V2** | `sendTableV2`, `sendCodeBlockV2`, `sendLinkV2` | Ya |
| **Link Messages** | Link inline dengan kutipan dan verifikasi | Ya |
| **Payment Messages** | Pesan pembayaran, split payment, dengan catatan/stiker | Ya |
| **Produk & Katalog** | Pesan produk bisnis, katalog lengkap | Ya |
| **Event & Poll** | Builder pesan event dan hasil polling | Ya |
| **Newsletter Extras** | Follow massal, metadata, admin utilities | Ya |
| **Komunitas & Grup** | CRUD komunitas, undangan, persetujuan | Ya |
| **Status Mention** | `sendStatusMention()` untuk mention di status | Ya |
| **LID & Session** | Pemetaan LID↔PN, migrasi sesi | Ya |
| **TypeScript** | File `.d.ts` tersedia untuk semua API | Ya |

---

## Persyaratan

- **Node.js** `>= 20.0.0`
- **Proyek ESM** (`"type": "module"` di `package.json`)
- Auth store persisten untuk penggunaan produksi
- Opsional: `pino`, `qrcode-terminal`, `sharp`, `jimp`

> **Penting:** `@kanaraa/baileys` hanya mendukung ESM. Proyek CommonJS perlu migrasi atau dynamic import wrapper.

---

## Isi Package

| Path | Kegunaan |
|---|---|
| `lib/` | Runtime utama, tipe, socket layer, utilitas |
| `WAProto/` | Protobuf runtime yang sudah digenerate |
| `package.json` | Metadata package |

---

## Instalasi

### Via Terminal (langsung)

```bash
npm install @kanaraa/baileys
```

Package pendamping yang disarankan:

```bash
npm install pino qrcode-terminal
```

### Via package.json — Fork Baileys

Jika proyekmu menggunakan fork dari `@whiskeysockets/baileys` atau `@adiwajshing/baileys`, tambahkan alias berikut ke `package.json`:

**Fork `@whiskeysockets/baileys`**
```json
{
  "dependencies": {
    "@whiskeysockets/baileys": "npm:@kanaraa/baileys"
  }
}
```

**Fork `@adiwajshing/baileys`**
```json
{
  "dependencies": {
    "@adiwajshing/baileys": "npm:@kanaraa/baileys"
  }
}
```

Lalu jalankan:

```bash
npm install
```

### Via Terminal — Non Fork (alias custom)

```bash
npm install kanaraa-bail@npm:@kanaraa/baileys
```

### Menggunakan Alias (generic)

Tambahkan ke `package.json`:

```json
{
  "dependencies": {
    "baileys": "npm:@kanaraa/baileys@latest"
  }
}
```

Lalu jalankan:

```bash
npm install
```

---

## Quick Start

### 1. Setup Proyek

```bash
mkdir bot-ku && cd bot-ku
npm init -y
```

Pastikan `package.json` memiliki `"type": "module"`:

```json
{
  "name": "bot-ku",
  "type": "module",
  "dependencies": {
    "baileys": "npm:@kanaraa/baileys@latest"
  }
}
```

### 2. Install Dependensi

```bash
npm install @kanaraa/baileys pino qrcode-terminal
```

### 3. Buat `index.js`

```js
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
} from '@kanaraa/baileys'
import pino from 'pino'
import qrcode from 'qrcode-terminal'

const logger = pino({ level: 'silent' })

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./session')

  const sock = makeWASocket({
    auth: state,
    logger,
    browser: Browsers.ubuntu('Chrome'),
    syncFullHistory: false,
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) qrcode.generate(qr, { small: true })

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut
      if (shouldReconnect) startBot()
    }
    if (connection === 'open') console.log('Terhubung!')
  })

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const msg = messages[0]
    if (!msg?.message || msg.key.fromMe) return

    const text =
      msg.message.conversation || msg.message.extendedTextMessage?.text || ''

    if (text === '.ping') {
      await sock.sendMessage(msg.key.remoteJid, { text: 'Pong!' })
    }
  })
}

startBot()
```

### 4. Jalankan

```bash
node index.js
```

Scan QR code, tunggu hingga socket mencapai `connection: "open"`, lalu kirim `.ping` untuk tes.

### 5. Contoh Pairing Code

```js
const sock = makeWASocket({
  auth: state,
  logger,
  browser: Browsers.windows('Chrome'),
})

sock.ev.on('connection.update', async ({ connection }) => {
  if (connection === 'connecting') {
    const code = await sock.requestPairingCode('628xxxxxxxxx')
    console.log('Pairing code:', code)
  }
})
```

---

## Membaca Pesan Pengguna

Saat menerima pesan via `messages.upsert`, gunakan `getContentType` dan `normalizeMessageContent` untuk mendeteksi tipe dan isi pesan.

### Setup Awal

```js
import {
  getContentType,
  normalizeMessageContent,
  downloadMediaMessage,
} from '@kanaraa/baileys'

sock.ev.on('messages.upsert', async ({ messages }) => {
  const msg = messages[0]
  if (!msg?.message || msg.key.fromMe) return

  const jid = msg.key.remoteJid
  const content = normalizeMessageContent(msg.message) // handle viewOnce, ephemeral, dll
  const type = getContentType(content)

  // Ambil teks dari tipe apapun
  const text =
    content?.conversation ||
    content?.extendedTextMessage?.text ||
    content?.imageMessage?.caption ||
    content?.videoMessage?.caption ||
    content?.documentMessage?.caption ||
    ''
})
```

---

### Text Message

```js
if (type === 'conversation' || type === 'extendedTextMessage') {
  const text = content?.conversation || content?.extendedTextMessage?.text || ''
  console.log('Teks:', text)
}
```

### Image Message

```js
if (type === 'imageMessage') {
  const caption = content.imageMessage.caption || ''
  const mimetype = content.imageMessage.mimetype // 'image/jpeg'
  console.log('Gambar diterima, caption:', caption)
}
```

### Video Message

```js
if (type === 'videoMessage') {
  const caption = content.videoMessage.caption || ''
  const seconds = content.videoMessage.seconds // durasi
  console.log('Video diterima, caption:', caption)
}
```

### Audio Message

```js
if (type === 'audioMessage') {
  const isVoiceNote = content.audioMessage.ptt === true
  const seconds = content.audioMessage.seconds
  console.log(isVoiceNote ? 'Voice note' : 'Audio', 'durasi:', seconds, 'detik')
}
```

### Document Message

```js
if (type === 'documentMessage') {
  const fileName = content.documentMessage.fileName || 'unknown'
  const mimetype = content.documentMessage.mimetype
  const caption = content.documentMessage.caption || ''
  console.log('Dokumen:', fileName, '|', mimetype)
}
```

### Sticker Message

```js
if (type === 'stickerMessage') {
  const isAnimated = content.stickerMessage.isAnimated
  const isLottie = content.stickerMessage.isLottie
  console.log('Stiker diterima, animasi:', isAnimated)
}
```

### Location Message

```js
if (type === 'locationMessage') {
  const { degreesLatitude, degreesLongitude, name, address } = content.locationMessage
  console.log(`Lokasi: ${name} — ${degreesLatitude}, ${degreesLongitude}`)
}
```

### Contact Message

```js
if (type === 'contactMessage') {
  const { displayName, vcard } = content.contactMessage
  console.log('Kontak:', displayName)
  console.log('vCard:', vcard)
}
```

### Poll Message

```js
if (
  type === 'pollCreationMessage' ||
  type === 'pollCreationMessageV2' ||
  type === 'pollCreationMessageV3'
) {
  const poll = content[type]
  const name = poll.name
  const options = poll.options.map(o => o.optionName)
  console.log('Poll:', name, '| Opsi:', options)
}
```

### Buttons Response Message

```js
// Saat user memilih dari Buttons Message
if (type === 'buttonsResponseMessage') {
  const selectedId = content.buttonsResponseMessage.selectedButtonId
  const selectedText = content.buttonsResponseMessage.selectedDisplayText
  console.log(`Tombol dipilih: [${selectedId}] ${selectedText}`)
}
```

### List Response Message

```js
// Saat user memilih dari List / Select Menu
if (type === 'listResponseMessage') {
  const rowId = content.listResponseMessage.singleSelectReply.selectedRowId
  const title = content.listResponseMessage.title
  console.log(`List dipilih: [${rowId}] ${title}`)
}
```

### Template Button Reply Message

```js
// Saat user memilih dari Template Buttons
if (type === 'templateButtonReplyMessage') {
  const selectedId = content.templateButtonReplyMessage.selectedId
  const selectedText = content.templateButtonReplyMessage.selectedDisplayText
  console.log(`Template dipilih: [${selectedId}] ${selectedText}`)
}
```

### Interactive Response Message

```js
// Saat user memilih dari Interactive / Flow Buttons (termasuk nativeFlowMessage)
if (type === 'interactiveResponseMessage') {
  const raw = content.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson
  const parsed = raw ? JSON.parse(raw) : {}
  const selectedId = parsed.id
  console.log('Interaktif dipilih:', parsed)
}
```

---

### Deteksi Pesan Reply (Quoted)

```js
sock.ev.on('messages.upsert', async ({ messages }) => {
  const msg = messages[0]
  if (!msg?.message) return

  const content = normalizeMessageContent(msg.message)

  // contextInfo ada di dalam tipe pesan terkait
  const contextInfo =
    content?.extendedTextMessage?.contextInfo ||
    content?.imageMessage?.contextInfo ||
    content?.videoMessage?.contextInfo ||
    null

  if (contextInfo?.quotedMessage) {
    const quotedContent = normalizeMessageContent(contextInfo.quotedMessage)
    const quotedType = getContentType(quotedContent)
    const quotedText =
      quotedContent?.conversation ||
      quotedContent?.extendedTextMessage?.text ||
      quotedContent?.imageMessage?.caption || ''

    console.log(`Pesan ini reply ke [${quotedType}]: ${quotedText}`)
  }
})
```

---

### Download Media dari Pesan

Bisa digunakan untuk `imageMessage`, `videoMessage`, `audioMessage`, `stickerMessage`, `documentMessage`.

```js
sock.ev.on('messages.upsert', async ({ messages }) => {
  const msg = messages[0]
  if (!msg?.message) return

  const buffer = await downloadMediaMessage(
    msg,
    'buffer', // atau 'stream'
    {},
    {
      logger,
      reuploadRequest: sock.updateMediaMessage,
    }
  )
  console.log('Media didownload, ukuran:', buffer.length, 'bytes')
})
```

---

## Referensi API Socket

### Koneksi & Autentikasi

```js
const sock = makeWASocket({
  auth: state,
  logger,
  browser: Browsers.ubuntu('Chrome'),
  connectTimeoutMs: 20_000,
  defaultQueryTimeoutMs: 60_000,
  syncFullHistory: false,
})
```

### Kirim Pesan

```js
// Teks
await sock.sendMessage(jid, { text: 'Halo!' })

// Gambar
await sock.sendMessage(jid, {
  image: { url: './foto.jpg' },
  caption: 'Sebuah foto',
})

// Video
await sock.sendMessage(jid, {
  video: { url: './video.mp4' },
  caption: 'Sebuah video',
})

// Audio / Voice Note
await sock.sendMessage(jid, {
  audio: { url: './audio.ogg' },
  mimetype: 'audio/ogg; codecs=opus',
  ptt: true,
})

// Stiker
await sock.sendMessage(jid, {
  sticker: { url: './stiker.webp' },
})

// Dokumen
await sock.sendMessage(jid, {
  document: { url: './file.pdf' },
  fileName: 'dokumen.pdf',
  mimetype: 'application/pdf',
})

// Reaksi
await sock.sendMessage(jid, {
  react: { key: msg.key, text: '👍' },
})

// Polling
await sock.sendMessage(jid, {
  poll: {
    name: 'Vote!',
    values: ['Opsi A', 'Opsi B', 'Opsi C'],
    selectableCount: 1,
  },
})

// Hapus pesan
await sock.sendMessage(jid, { delete: msg.key })

// Edit pesan
await sock.sendMessage(jid, {
  text: 'Teks yang sudah diedit',
  edit: msg.key,
})
```

### Pack Sticker (Sticker Pack)

Kirim koleksi stiker dalam satu pack — bisa dari URL, buffer, atau file lokal.

```js
// Dari URL
await sock.sendMessage(jid, {
  stickerPackMessage: {
    name: 'Pack Keren',
    publisher: 'kanaraa',
    stickers: [
      { url: 'https://example.com/stiker1.webp', emojis: ['😂'] },
      { url: 'https://example.com/stiker2.webp', emojis: ['🔥'] },
      { url: 'https://example.com/stiker3.gif',  emojis: ['✨'], isAnimated: true },
    ],
  },
})

// Dari Buffer
import { readFile } from 'fs/promises'
const buf1 = await readFile('./stiker1.webp')
const buf2 = await readFile('./stiker2.webp')

await sock.sendMessage(jid, {
  stickerPackMessage: {
    name: 'Pack Lokal',
    publisher: 'Bot Ku',
    trayIcon: './tray.png', // opsional, ikon kecil pack (96x96)
    stickers: [
      { buffer: buf1, emojis: ['😎'] },
      { buffer: buf2, emojis: ['💯'], isAnimated: false },
    ],
  },
})
```

### PTV (Push-to-Video / Video Note)

Kirim video berbentuk lingkaran seperti video note Telegram.

```js
await sock.sendMessage(jid, {
  video: { url: './video.mp4' },
  ptv: true,
})
```

### Share / Request Nomor Telepon

```js
// Bagikan nomor telepon kamu ke lawan chat
await sock.sendMessage(jid, { sharePhoneNumber: true })

// Minta nomor telepon lawan chat
await sock.sendMessage(jid, { requestPhoneNumber: true })
```

### Keep in Chat (Simpan Pesan)

```js
await sock.sendMessage(jid, {
  keep: {
    key: msg.key,   // key pesan yang ingin disimpan
    type: 1,        // 1 = simpan, 2 = hapus dari simpan
  },
})
```

### Pin Pesan

```js
// Pin pesan selama 24 jam (86400 detik)
await sock.sendMessage(jid, {
  pin: msg.key,
  type: 1,         // 1 = pin, 2 = unpin
  time: 86400,     // durasi pin dalam detik (untuk pin)
})
```

### Limit Sharing (Batasi Forward)

```js
await sock.sendMessage(jid, {
  limitSharing: true,  // true = batasi, false = lepas batasan
})
```

### Scheduled Call (Jadwalkan Panggilan)

```js
await sock.sendMessage(jid, {
  call: {
    name: 'Meeting Mingguan',
    time: Date.now() + 3600_000, // 1 jam dari sekarang (ms)
    type: 1,   // 1 = audio, 2 = video
  },
})
```

### Group Invite (Undangan Grup)

```js
await sock.sendMessage(jid, {
  groupInvite: {
    jid: '120363xxxxxx@g.us',
    code: 'ABCDEFGH',          // kode invite
    name: 'Grup Saya',
    caption: 'Gabung yuk!',
    expiration: Math.floor(Date.now() / 1000) + 86400, // expired besok
  },
})
```

### Newsletter Admin Invite

```js
await sock.sendMessage(jid, {
  adminInvite: {
    jid: '120363xxxxxx@newsletter',
    name: 'Saluran Saya',
    caption: 'Jadi admin yuk!',
    expiration: Math.floor(Date.now() / 1000) + 86400,
  },
})
```

### Payment Invite

```js
await sock.sendMessage(jid, {
  paymentInvite: {
    type: 2,           // tipe layanan pembayaran
    expiry: 0,
  },
})
```

### Order Status

```js
await sock.sendMessage(jid, {
  orderStatus: {
    title: 'Status Pesanan',
    text: 'Silakan cek status pesanan Anda.',
    footer: 'Eval test',
    image: './image.jpg',        // wajib ada
    referenceId: 'LV-001',
    status: 'PROCESSING',        // PROCESSING | COMPLETED | CANCELLED
    subtotalValue: 50000,
    subtotalOffset: 100,
    taxValue: 2500,
    taxOffset: 100,
    currency: 'IDR',
  },
})
```

### Split Payment

Ajak lawan chat patungan/bayar bareng untuk satu order.

```js
await sock.sendMessage(jid, {
  splitPayment: {
    text: 'Yuk bayar split sama-sama',
    referenceId: 'LV-002',
    currency: 'IDR',
    value: 5000000,
    offset: 100,
    orderType: 'ORDER',
  },
})
```

### Event Message

```js
await sock.sendMessage(jid, {
  event: {
    name: 'Meetup Developer',
    description: 'Kumpul bareng developer lokal!',
    startDate: new Date('2025-08-01T10:00:00+07:00'),
    endDate: new Date('2025-08-01T13:00:00+07:00'),
    location: 'Jakarta, Indonesia',
    extraGuestsAllowed: true,
    isCancelled: false,
  },
})
```

### Poll Result Snapshot

```js
await sock.sendMessage(jid, {
  pollResult: {
    name: 'Hasil Vote Bahasa Favorit',
    values: [
      ['JavaScript', 42],
      ['Python', 38],
      ['Go', 20],
    ],
  },
})
```

### Native Flow Message (Tombol Fleksibel)

Versi fleksibel dari interactiveMessage dengan berbagai tipe tombol. Ada **8 tipe tombol
pendek** yang bisa langsung dipakai lewat `type` + `text` tanpa perlu mikirin format
`buttonParamsJson` manual: `reply`, `url`, `call`, `copy`, `location`, `address`, `reminder`,
dan `cancel_reminder`.

**Contoh lengkap 8 tipe tombol sekaligus:**

```js
await sock.sendMessage(jid, {
  nativeFlowMessage: {
    body: 'Contoh semua jenis tombol native flow',
    footer: 'Eval test - semua tombol',
    buttons: [
      { type: 'reply',           text: 'Quick Reply',    id: 'qr1' },
      { type: 'url',             text: 'Buka Website',   url: 'https://example.com' },
      { type: 'call',            text: 'Telepon Saya',   id: '628xxxxxxxxx' },
      { type: 'copy',            text: 'Copy Kode',      copy_code: 'PROMO2025' },
      { type: 'location',        text: 'Kirim Lokasi' },
      { type: 'address',         text: 'Pilih Alamat',   id: 'addr1' },
      { type: 'reminder',        text: 'Set Reminder',   id: 'remind1' },
      { type: 'cancel_reminder', text: 'Batalkan Reminder', id: 'remind1' },
    ],
  },
})
```

**Contoh sederhana — quick reply dengan gambar:**

```js
await sock.sendMessage(jid, {
  nativeFlowMessage: {
    image: './image.jpg',
    body: 'Ini contoh quick_reply pakai gambar',
    footer: 'Eval test',
    buttons: [
      { type: 'reply', text: 'Tombol 1', id: 'tes1' },
      { type: 'reply', text: 'Tombol 2', id: 'tes2' },
      { type: 'reply', text: 'Tombol 3', id: 'tes3' },
    ],
  },
})
```

**Contoh campuran — reply, url, dan copy dalam satu pesan:**

```js
await sock.sendMessage(jid, {
  nativeFlowMessage: {
    image: './image.jpg',
    body: 'Pilih salah satu opsi di bawah',
    footer: 'Eval test',
    buttons: [
      { type: 'reply', text: 'Konfirmasi',         id: 'confirm1' },
      { type: 'url',   text: 'Kunjungi Website',   url: 'https://example.com' },
      { type: 'copy',  text: 'Copy No. Rekening',  copy_code: '1234567890' },
    ],
  },
})
```

**List Menu Khusus (`single_select`) — via `generateWAMessageFromContent`:**

`single_select` bukan salah satu dari 8 tipe pendek di atas, jadi cara paling reliable buat
dipakai adalah bangun langsung `interactiveMessage`-nya lewat `generateWAMessageFromContent`,
lalu kirim pakai `relayMessage`. Ini juga jalur yang sama dipakai `sock.sendMessage()` di balik
layar, jadi hasilnya konsisten.

```js
const { generateWAMessageFromContent } = await import('@kanaraa/baileys')

const msg = generateWAMessageFromContent(
  jid,
  {
    viewOnceMessage: {
      message: {
        interactiveMessage: {
          header: { title: '', subtitle: '', hasMediaAttachment: false },
          body: { text: 'test single select' },
          footer: { text: 'Vøid' },
          nativeFlowMessage: {
            buttons: [
              {},
              {
                name: 'single_select',
                buttonParamsJson: JSON.stringify({
                  display_text: '\u0000',
                  title: 'Pilih Opsi',
                  sections: [
                    {
                      title: 'Kategori 1',
                      rows: [
                        { title: 'Opsi 1', description: 'deskripsi 1', id: 'opt1' },
                        { title: 'Opsi 2', description: 'deskripsi 2', id: 'opt2' },
                      ],
                    },
                    {
                      title: 'Kategori 2',
                      rows: [
                        { title: 'Opsi 3', description: 'deskripsi 3', id: 'opt3' },
                        { title: 'Opsi 4', description: 'deskripsi 4', id: 'opt4' },
                      ],
                    },
                  ],
                }),
              },
            ],
            messageParamsJson: '{}',
          },
        },
      },
    },
  },
  {}
)

await sock.relayMessage(jid, msg.message, { messageId: msg.key.id })
```

> `sock` di sini maksudnya socket bot kamu — ganti sesuai nama variabel yang kamu pakai sendiri
> (`gara`, `client`, `conn`, apapun). Begitu juga `jid`, ganti dengan JID tujuan pesan.

Beberapa hal yang perlu diperhatikan dari contoh di atas: array `buttons` sengaja diisi `{}`
kosong di posisi pertama sebelum objek `single_select`-nya — pola ini yang paling stabil dites
di lapangan. `header` di sini nggak wajib kosong seperti contoh — kalau mau nambahin gambar,
tinggal isi `header` dengan properti media, misalnya:

```js
header: {
  title: 'Pilih Menu',
  hasMediaAttachment: true,
  imageMessage: { url: './image.jpg' }, // atau isi hasil dari prepareWAMessageMedia
}
```

Jadi gambar di sini sifatnya opsional, tinggal disesuaikan sama kebutuhan pesan kamu — nggak
harus selalu ada.

**Tombol Khusus (`quick_reply`, `cta_url`, `cta_copy`) — via `generateWAMessageFromContent`:**

Pola yang sama juga bisa dipakai buat gabung beberapa jenis tombol native flow sekaligus dalam
satu pesan, di luar cara shorthand `type`/`text` yang sudah dibahas di atas:

```js
const { generateWAMessageFromContent } = await import('@kanaraa/baileys')

const msg = generateWAMessageFromContent(
  jid,
  {
    viewOnceMessage: {
      message: {
        interactiveMessage: {
          header: { title: '', subtitle: '', hasMediaAttachment: false },
          body: { text: 'test button nativeflow' },
          footer: { text: 'Vøid' },
          nativeFlowMessage: {
            buttons: [
              {},
              {
                name: 'quick_reply',
                buttonParamsJson: JSON.stringify({ display_text: '\u0000', id: 'qr1', icon: 'PROMOTION' })
              },
              {
                name: 'cta_url',
                buttonParamsJson: JSON.stringify({ display_text: '\u0000', url: 'https://github.com/kanaraa', merchant_url: 'https://github.com/kanaraa', icon: 'REVIEW' })
              },
              {
                name: 'cta_copy',
                buttonParamsJson: JSON.stringify({ display_text: '\u0000', copy_code: 'KANARAA2025', icon: 'DEFAULT' })
              },
            ],
            messageParamsJson: '{}',
          },
        },
      },
    },
  },
  {}
)

await sock.relayMessage(jid, msg.message, { messageId: msg.key.id })
```

> Sama seperti contoh sebelumnya: `sock` dan `jid` tinggal disesuaikan ke variabel socket & JID
> tujuan yang kamu pakai di bot kamu sendiri.

Sama seperti contoh sebelumnya, `header` di sini juga opsional buat ditambahin gambar — kalau
nggak butuh gambar, biarin seperti contoh (kosong), kalau butuh tinggal tambahin
`hasMediaAttachment: true` plus `imageMessage`/`videoMessage` sesuai media yang mau ditampilkan.
`icon` di tiap tombol juga cuma variasi tampilan (`PROMOTION`, `REVIEW`, `DEFAULT`, dan
seterusnya) — boleh dipakai boleh nggak, nggak ngaruh ke fungsi tombolnya.

**Dengan header gambar (versi shorthand biasa):**

```js
await sock.sendMessage(jid, {
  nativeFlowMessage: {
    title: 'Flash Sale!',
    body: 'Diskon 50% hari ini saja.',
    footer: 'Berlaku hingga tengah malam',
    image: 'https://example.com/banner.jpg',
    buttons: [
      { type: 'reply', text: 'Beli Sekarang', id: 'buy' },
      { type: 'url',   text: 'Lihat Katalog', url: 'https://example.com/katalog' },
    ],
  },
})
```

### Carousel Message

```js
await sock.sendMessage(jid, {
  carouselMessage: {
    body: 'Pilih produk favoritmu!',
    footer: 'Swipe untuk lihat lebih banyak',
    cards: [
      {
        title: 'Produk A',
        body: 'Deskripsi produk A yang keren.',
        footer: 'Rp 99.000',
        image: 'https://example.com/produk-a.jpg',
        buttons: [
          { type: 'reply', text: 'Pilih Produk A', id: 'produk_a' },
          { type: 'url',   text: 'Detail', url: 'https://example.com/a' },
        ],
      },
      {
        title: 'Produk B',
        body: 'Deskripsi produk B yang lebih keren.',
        footer: 'Rp 149.000',
        image: 'https://example.com/produk-b.jpg',
        buttons: [
          { type: 'reply', text: 'Pilih Produk B', id: 'produk_b' },
          { type: 'url',   text: 'Detail', url: 'https://example.com/b' },
        ],
      },
    ],
  },
})
```

### Cards (Carousel dengan helper)

```js
// Helper shorthand untuk carousel
await sock.sendMessage(jid, {
  cards: [
    {
      title: 'Item 1',
      body: 'Deskripsi item 1',
      footer: 'Rp 50.000',
      image: { url: 'https://example.com/img1.jpg' },
      buttons: [{ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Pilih', id: 'item1' }) }],
    },
    {
      title: 'Item 2',
      body: 'Deskripsi item 2',
      footer: 'Rp 75.000',
      video: { url: 'https://example.com/video2.mp4' },
      buttons: [{ name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: 'Pilih', id: 'item2' }) }],
    },
  ],
  text: 'Pilih item berikut:',
  footer: 'Kanaraa Shop',
})
```

### Button Reply (Balas Tombol secara Programatis)

```js
// Balas list
await sock.sendMessage(jid, {
  buttonReply: { title: 'Game', rowId: '.kuis' },
  type: 'list',
})

// Balas template button
await sock.sendMessage(jid, {
  buttonReply: { displayText: 'Konfirmasi', id: 'btn_confirm', index: 0 },
  type: 'template',
})

// Balas plain button
await sock.sendMessage(jid, {
  buttonReply: { id: 'btn_ok', displayText: 'OK' },
  type: 'plain',
})

// Balas interactive/flow button
await sock.sendMessage(jid, {
  buttonReply: {
    displayText: 'Menu',
    nativeFlows: {
      name: 'quick_reply',
      paramsJson: JSON.stringify({ id: 'menu' }),
      version: '1',
    },
  },
  type: 'interactive',
})
```

### Pesan Interaktif

```js
// Tombol Flow
await sock.sendMessage(jid, {
  interactiveMessage: {
    title: 'Selamat Datang!',
    footer: 'Powered by Kanaraa',
    buttons: [
      {
        name: 'quick_reply',
        buttonParamsJson: JSON.stringify({
          display_text: 'Menu',
          id: 'menu',
        }),
      },
      {
        name: 'cta_url',
        buttonParamsJson: JSON.stringify({
          display_text: 'Website',
          url: 'https://example.com',
        }),
      },
    ],
    header: 'Pilih opsi',
  },
})

// List Menu
await sock.sendMessage(jid, {
  interactiveMessage: {
    title: 'Pilih Kategori',
    footer: 'Powered by Kanaraa',
    buttons: [
      {
        name: 'single_select',
        buttonParamsJson: JSON.stringify({
          title: 'Menu',
          sections: [
            {
              title: 'Game',
              rows: [
                { title: 'Kuis', id: '.kuis' },
                { title: 'Tebak Gambar', id: '.tebakgambar' },
              ],
            },
          ],
        }),
      },
    ],
    header: 'Menu Bot',
  },
})
```

### AI Rich Response

```js
// Tabel
await sock.sendTable(
  jid,
  'Java vs JavaScript',
  ['Fitur', 'Java', 'JavaScript'],
  [
    ['Tipe', 'Compiled', 'Interpreted'],
    ['Typing', 'Static', 'Dynamic'],
    ['Kegunaan', 'Enterprise', 'Web, Full-stack'],
  ],
  quoted,
  { headerText: 'Perbandingan:', footer: 'Semoga membantu!' }
)

// List
await sock.sendList(
  jid,
  'Info Bot',
  [
    ['Nama', 'Kanaraa AI'],
    ['Versi', '7.0.0'],
    ['Developer', 'kanaraa'],
  ],
  quoted,
  { footer: '© Kanaraa AI' }
)

// Code Block
await sock.sendCodeBlock(
  jid,
  `const salam = "Halo Dunia"
function kataSalam(nama) {
    return salam + " " + nama
}
kataSalam("Kanaraa")`,
  quoted,
  {
    language: 'javascript',
    title: 'Contoh Kode',
    footer: 'Powered by Kanaraa',
  }
)
```

### Rich Message

```js
// Teks & Markdown
await sock.sendMessage(jid, {
  richMessage: {
    title: 'vøid',
    text: `# Halo Dunia\n## GARA\n\n---\n\n=={ Yellow Text }==\n\n---\n\n[Google](https://google.com)\n\n[](https://openai.com)\n\n[Shiroko|1429|1897]<https://example.com/image.png>`,
  }
}, { quoted: m })

// Tip / Metadata Text
await sock.sendMessage(jid, {
  richMessage: {
    title: 'vøid',
    tip: 'Ini adalah text tip (Metadata Text)',
  }
}, { quoted: m })

// Produk
await sock.sendMessage(jid, {
  richMessage: {
    title: 'vøid',
    product: [
      {
        title: 'Nama Produk',
        brand: 'GARA',
        price: 'Rp 1000',
        sale_price: 'Rp 0',
        url: 'https://wa.me/628xxx',
        icon: 'https://example.com/icon.png',
        image: 'https://example.com/image.jpg',
      }
    ],
  }
}, { quoted: m })

// Code Block
await sock.sendMessage(jid, {
  richMessage: {
    title: 'vøid',
    code: {
      language: 'javascript',
      code: `class GARA {\n\tstatic hello() {\n\t\treturn 'Hello World';\n\t}\n}`,
    },
  }
}, { quoted: m })

// Tabel
await sock.sendMessage(jid, {
  richMessage: {
    title: 'vøid',
    table: [
      ['Nama', 'Role'],
      ['GARA', 'Developer'],
      ['Fiora Sylvie', 'Assistant'],
    ],
  }
}, { quoted: m })

// Source / Sumber
await sock.sendMessage(jid, {
  richMessage: {
    title: 'vøid',
    source: [
      ['https://example.com/favicon.jpg', 'https://github.com/kanaraa/', 'GitHub'],
      ['https://example.com/favicon.jpg', 'https://example.com/', 'Website'],
    ],
  }
}, { quoted: m })

// Gambar
await sock.sendMessage(jid, {
  richMessage: {
    title: 'vøid',
    image: 'https://example.com/image.jpg',
  }
}, { quoted: m })

// Video
await sock.sendMessage(jid, {
  richMessage: {
    title: 'vøid',
    video: 'https://example.com/video.mp4|10', // url|durasi(detik)
  }
}, { quoted: m })

// Reels
await sock.sendMessage(jid, {
  richMessage: {
    title: 'vøid',
    reels: [
      {
        username: 'GARA',
        profile_url: 'https://example.com/avatar.jpg',
        thumbnail: 'https://example.com/thumb.jpg',
        url: 'https://example.com/',
        title: 'Demo Reel',
        like: 12000,
        share: 500,
        view: 999999,
        source: 'IG',
        verified: true,
      }
    ],
  }
}, { quoted: m })

// Post
await sock.sendMessage(jid, {
  richMessage: {
    title: 'vøid',
    post: [
      {
        profile_url: 'https://example.com/avatar.jpg',
        username: 'GARA',
        title: 'Demo Post',
        subtitle: 'vøid',
        caption: 'Caption post disini.',
        verified: true,
        url: 'https://example.com/',
        thumbnail: 'https://example.com/thumb.jpg',
        source: 'INSTAGRAM',
        footer: 'vøid',
        deeplink: 'https://example.com/',
        icon: 'https://example.com/icon.jpg',
        orientation: 'LANDSCAPE',
        post_type: 'PHOTO',
        comment: 1,
        share: 1,
        like: 1,
      }
    ],
  }
}, { quoted: m })

// Suggest / Pill
await sock.sendMessage(jid, {
  richMessage: {
    title: 'vøid',
    suggest: ['GARA', 'vøid', 'Fiora Sylvie'],
  }
}, { quoted: m })

// Gabungan (video + tip + suggest + text)
await sock.sendMessage(jid, {
  richMessage: {
    title: 'vøid',
    video: 'https://example.com/video.mp4|10',
    tip: 'Ini adalah text tip',
    suggest: ['gara', 'kanaraa', 'yuuki'],
    text: `- [Beli Script](https://wa.me/628xxx)\n- [Sewa Bot](https://wa.me/628xxx)\n- [Support](https://wa.me/628xxx)`,
  }
}, { quoted: m })
```

### Metode Newsletter

```js
await sock.newsletterFollow('id@newsletter')
await sock.newsletterUnfollow('id@newsletter')
await sock.newsletterMute('id@newsletter')
await sock.newsletterUnmute('id@newsletter')
await sock.newsletterCreate('Saluran Saya', 'Deskripsi')
await sock.newsletterUpdate('id@newsletter', { name: 'Nama Baru' })
const { subscribers } = await sock.newsletterSubscribers('id@newsletter')
await sock.newsletterMultipleFollow('id1@newsletter id2@newsletter')
```

### Metode Grup

```js
const meta = await sock.groupMetadata('id@g.us')
const grup = await sock.groupCreate('Grup Baru', ['628xxx@s.whatsapp.net'])
await sock.groupLeave('id@g.us')
await sock.groupUpdateSubject('id@g.us', 'Nama Baru')
await sock.groupUpdateDescription('id@g.us', 'Deskripsi Baru')
await sock.groupParticipantsUpdate('id@g.us', ['628xxx@s.whatsapp.net'], 'add')
const kode = await sock.groupInviteCode('id@g.us')
await sock.groupRevokeInvite('id@g.us')
await sock.groupSettingUpdate('id@g.us', 'announcement')
```

### Metode Komunitas

```js
const komunitas = await sock.communityCreate('Komunitas Kami', 'Deskripsi')
await sock.communityLinkGroup('groupid@g.us', 'communityid@g.us')
await sock.communityUnlinkGroup('groupid@g.us', 'communityid@g.us')
await sock.communityLeave('communityid@g.us')
```

### Pengaturan Privasi

```js
await sock.updateLastSeenPrivacy('all')       // 'all' | 'contacts' | 'nobody'
await sock.updateOnlinePrivacy('all')
await sock.updateProfilePicturePrivacy('contacts')
await sock.updateStatusPrivacy('contacts')
await sock.updateReadReceiptsPrivacy('all')   // 'all' | 'none'
await sock.updateGroupsAddPrivacy('all')
await sock.updateCallPrivacy('everyone')
```

---

## Referensi Event

```js
sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {})
sock.ev.on('creds.update', (update) => {})
sock.ev.on('messages.upsert', ({ messages, type }) => {})
sock.ev.on('messages.update', (updates) => {})
sock.ev.on('messages.delete', (keys) => {})
sock.ev.on('messages.reaction', (reactions) => {})
sock.ev.on('groups.update', (updates) => {})
sock.ev.on('group-participants.update', (update) => {})
sock.ev.on('contacts.upsert', (contacts) => {})
sock.ev.on('contacts.update', (updates) => {})
sock.ev.on('chats.upsert', (chats) => {})
sock.ev.on('chats.update', (updates) => {})
sock.ev.on('call', (calls) => {})
sock.ev.on('newsletter.update', (updates) => {})
sock.ev.on('settings.update', (settings) => {})
```

---

## Utilitas

```js
import {
  // Auth
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  initAuthCreds,
  BufferJSON,
  fetchLatestBaileysVersion,

  // JID
  jidEncode,
  jidDecode,
  jidNormalizedUser,
  areJidsSameUser,
  isJidGroup,
  isJidNewsletter,
  isJidBroadcast,

  // Koneksi
  DisconnectReason,
  Browsers,
} from '@kanaraa/baileys'
```

---

Repo dan seluruh kode di dalamnya dikelola oleh kanaraa. Gunakan sesuai kebutuhan proyekmu sendiri, dan pastikan penggunaannya tetap mengikuti Syarat Layanan WhatsApp.
