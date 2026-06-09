<div align="center">

<img src="https://c.termai.cc/i135/QkXlhm4.jpg" alt="void-baileys banner" width="100%" />

# @gara31/void-baileys

### Modded Baileys v7 — Pesan Interaktif, Album, AI Rich Response & Lebih

[![npm version](https://img.shields.io/npm/v/@gara31/void-baileys?color=CB3837&logo=npm&logoColor=white&style=for-the-badge)](https://www.npmjs.com/package/@gara31/void-baileys)
[![npm downloads](https://img.shields.io/npm/dm/@gara31/void-baileys?color=CB3837&logo=npm&logoColor=white&style=for-the-badge)](https://www.npmjs.com/package/@gara31/void-baileys)
[![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](LICENSE)
[![ESM](https://img.shields.io/badge/ESM-only-F7DF1E?logo=javascript&logoColor=black&style=for-the-badge)](#)

---

**Build modifikasi dari [WhiskeySockets/Baileys](https://github.com/WhiskeySockets/Baileys)**  
dengan dukungan native untuk pesan interaktif, album, AI rich response, newsletter, status mention, dan berbagai utilitas tambahan.

Package ini adalah **distribusi/build repo** untuk `@gara31/void-baileys`.  
Berisi file runtime yang sudah dikompilasi di `lib/` dan protobuf di `WAProto/`, dirancang untuk digunakan langsung dari npm.

</div>

---

## Daftar Isi

- [Fitur](#-fitur)
- [Persyaratan](#-persyaratan)
- [Isi Package](#-isi-package)
- [Instalasi](#-instalasi)
- [Quick Start](#-quick-start)
- [Referensi API Socket](#-referensi-api-socket)
- [Referensi Event](#-referensi-event)
- [Utilitas](#-utilitas)
- [Penghargaan](#-penghargaan)
- [Lisensi](#-lisensi)

---

## ✨ Fitur

| Fitur | Deskripsi | Status |
|---|---|---|
| **Pesan Interaktif** | Flow button native, list/select menu, carousel | ✅ |
| **Album Messages** | Multi-image/video album dengan metadata | ✅ |
| **AI Rich Response** | `sendTable`, `sendList`, `sendCodeBlock`, `sendRichMessage` | ✅ |
| **Unified Response V2** | `sendTableV2`, `sendCodeBlockV2`, `sendLinkV2` | ✅ |
| **Link Messages** | Link inline dengan kutipan dan verifikasi | ✅ |
| **Payment Messages** | Pesan pembayaran dengan catatan/stiker | ✅ |
| **Produk & Katalog** | Pesan produk bisnis, katalog lengkap | ✅ |
| **Event & Poll** | Builder pesan event dan hasil polling | ✅ |
| **Newsletter Extras** | Follow massal, metadata, admin utilities | ✅ |
| **Komunitas & Grup** | CRUD komunitas, undangan, persetujuan | ✅ |
| **Status Mention** | `sendStatusMention()` untuk mention di status | ✅ |
| **LID & Session** | Pemetaan LID↔PN, migrasi sesi | ✅ |
| **TypeScript** | File `.d.ts` tersedia untuk semua API | ✅ |

---

## ✅ Persyaratan

- **Node.js** `>= 20.0.0`
- **Proyek ESM** (`"type": "module"` di `package.json`)
- Auth store persisten untuk penggunaan produksi
- Opsional: `pino`, `qrcode-terminal`, `sharp`, `jimp`

> **Penting:** `@gara31/void-baileys` hanya mendukung ESM. Proyek CommonJS perlu migrasi atau dynamic import wrapper.

---

## 📁 Isi Package

| Path | Kegunaan |
|---|---|
| `lib/` | Runtime utama, tipe, socket layer, utilitas |
| `WAProto/` | Protobuf runtime yang sudah digenerate |
| `package.json` | Metadata package |

---

## 📦 Instalasi

### Via Terminal (langsung)

```bash
npm install @gara31/void-baileys
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
    "@whiskeysockets/baileys": "npm:@gara31/void-baileys"
  }
}
```

**Fork `@adiwajshing/baileys`**
```json
{
  "dependencies": {
    "@adiwajshing/baileys": "npm:@gara31/void-baileys"
  }
}
```

Lalu jalankan:

```bash
npm install
```

### Via Terminal — Non Fork (alias custom)

```bash
npm install void-bail@npm:@gara31/void-baileys
```

### Menggunakan Alias (generic)

Tambahkan ke `package.json`:

```json
{
  "dependencies": {
    "baileys": "npm:@gara31/void-baileys@latest"
  }
}
```

Lalu jalankan:

```bash
npm install
```

---

## 🛠️ Quick Start

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
    "baileys": "npm:@gara31/void-baileys@latest"
  }
}
```

### 2. Install Dependensi

```bash
npm install @gara31/void-baileys pino qrcode-terminal
```

### 3. Buat `index.js`

```js
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
} from '@gara31/void-baileys'
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

## 📨 Membaca Pesan Pengguna

Saat menerima pesan via `messages.upsert`, gunakan `getContentType` dan `normalizeMessageContent` untuk mendeteksi tipe dan isi pesan.

### Setup Awal

```js
import {
  getContentType,
  normalizeMessageContent,
  downloadMediaMessage,
} from '@gara31/void-baileys'

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
// Saat user memilih dari Interactive / Flow Buttons
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

## 📡 Referensi API Socket

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

### Pesan Interaktif

```js
// Tombol Flow
await sock.sendMessage(jid, {
  interactiveMessage: {
    title: 'Selamat Datang!',
    footer: 'Powered by Void',
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
    footer: 'Powered by Void',
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

### Album Messages

```js
await sock.sendMessage(jid, {
  albumMessage: [
    { image: { url: './foto1.jpg' }, caption: 'Pertama' },
    { image: { url: './foto2.jpg' }, caption: 'Kedua' },
    { video: { url: './klip.mp4' }, caption: 'Video' },
  ],
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
    ['Nama', 'Void AI'],
    ['Versi', '7.0.0'],
    ['Developer', 'gara31'],
  ],
  quoted,
  { footer: '© Void AI' }
)

// Code Block
await sock.sendCodeBlock(
  jid,
  `const salam = "Halo Dunia"
function kataSalam(nama) {
    return salam + " " + nama
}
kataSalam("Void")`,
  quoted,
  {
    language: 'javascript',
    title: 'Contoh Kode',
    footer: 'Powered by Void',
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
      ['https://example.com/favicon.jpg', 'https://github.com/gara31/', 'GitHub'],
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
    suggest: ['gara', 'void', 'yuuki'],
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

## 📡 Referensi Event

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

## 🔧 Utilitas

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
} from '@gara31/void-baileys'
```

---

## Credits

<div align="center">

### Powered by NIXCODE — Advanced WhatsApp Message Builder

</div>

Fitur **AI Rich Response** yang tersedia di package ini — mulai dari `richMessage`, `sendTable`, `sendCodeBlock`, hingga seluruh ekosistem unified response — dibangun di atas fondasi luar biasa yang diciptakan oleh **Nixel** melalui proyeknya **NIXCODE MessageBuilder**.

Library NIXCODE adalah karya yang benar-benar melampaui batas kemampuan standar Baileys. Arsitektur fluent chaining-nya, sistem `extractIE` untuk parsing hyperlink/citation/latex secara inline, `Toolkit` class yang elegan, hingga dukungan multi-format media — semua itu adalah hasil kerja keras, riset mendalam, dan dedikasi tinggi yang patut diacungi. Tanpa fondasi ini, fitur-fitur rich response di `@gara31/void-baileys` tidak akan pernah ada.

Terima kasih banyak, **Nixel** — karyamu bukan sekadar library, tapi sebuah kontribusi nyata bagi komunitas developer WhatsApp bot Indonesia. 🙏

> **NIXCODE MessageBuilder** dibuat oleh Nixel  
>  Saluran resmi & update terbaru: [**wa.me/channel/0029VbCV1ck8fewpdNb2TY2k**](https://whatsapp.com/channel/0029VbCV1ck8fewpdNb2TY2k)  

Jika kamu menemukan library ini berguna, jangan lupa follow saluran NIXCODE di atas untuk mendapatkan update, fitur baru, dan rilis terbaru langsung dari pembuatnya.

---

## 📄 Lisensi

MIT © [gara31](https://github.com/gara31)

> **Peringatan:** Library ini untuk keperluan edukasi. Pastikan penggunaannya sesuai dengan Syarat Layanan WhatsApp.

---

<div align="center">

**Dibuat dengan 💚 oleh gara31**

</div>
