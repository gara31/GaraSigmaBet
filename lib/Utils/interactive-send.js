import { generateWAMessageContent, generateWAMessageFromContent, getDevice } from './messages.js';

/**
 * True if the message being quoted/replied-to was sent from an iOS device.
 * iOS WhatsApp has historically had weaker/inconsistent support for the
 * "interactiveMessage" wrapper trick used by send()/sendMedia() below, so
 * both functions fall back to a plain sendMessage() for iOS senders.
 *
 * Self-contained: does not read or write any global state.
 */
export const isIosSender = (quotedMsg) => {
    try {
        const id = quotedMsg?.key?.id;
        if (!id)
            return false;
        return getDevice(id) === 'ios';
    }
    catch {
        return false;
    }
};

/**
 * Send a text message, styled as a borderless "interactive" bubble on
 * platforms that support it (Android/Web), falling back to a normal text
 * message for iOS senders or if anything goes wrong building the
 * interactive payload.
 *
 * This does not use sock.sendMessage()'s regular text path for the
 * interactive case: it builds the raw message with generateWAMessageFromContent
 * and sends it with sock.relayMessage, mirroring how Baileys' own
 * sendMessage() works internally.
 *
 * @param {import('../Socket/index.js').WASocket} sock - an active Baileys socket (the object returned by makeWASocket)
 * @param {string} jid - destination chat JID
 * @param {object} quotedMsg - the message being replied to (a full WAMessage object, used for the ios check + quoting)
 * @param {string} text - the text to send
 * @param {string[]} [mentions] - JIDs to mention
 */
export const send = async (sock, jid, quotedMsg, text, mentions = []) => {
    try {
        if (isIosSender(quotedMsg)) {
            await sock.sendMessage(jid, { text: String(text ?? ''), ...(mentions.length > 0 ? { mentions } : {}) }, { quoted: quotedMsg });
            return;
        }
        const built = generateWAMessageFromContent(jid, {
            viewOnceMessage: {
                message: {
                    interactiveMessage: {
                        body: { text: '' },
                        footer: { text: String(text ?? '') },
                        nativeFlowMessage: { buttons: [] },
                        ...(mentions.length > 0 ? { contextInfo: { mentionedJid: mentions } } : {})
                    }
                }
            }
        }, {
            quoted: quotedMsg,
            userJid: quotedMsg?.key?.participant ?? quotedMsg?.key?.remoteJid ?? jid
        });
        await sock.relayMessage(jid, built.message, { messageId: built.key.id });
    }
    catch (error) {
        console.error('[send] fallback to simple text:', error.message);
        await sock.sendMessage(jid, { text: String(text ?? ''), ...(mentions.length > 0 ? { mentions } : {}) }, { quoted: quotedMsg });
    }
};

/**
 * Send an image or video (as buffer, url, or existing Buffer), styled as an
 * interactive bubble when there's a caption and the sender isn't on iOS;
 * otherwise falls back to a plain image/video message.
 *
 * @param {import('../Socket/index.js').WASocket} sock
 * @param {string} jid
 * @param {object} quotedMsg
 * @param {Buffer|string} src - a Buffer, or a URL string to fetch
 * @param {string} mime - mime type, e.g. 'image/jpeg' or 'video/mp4'
 * @param {string} caption
 * @param {string[]} [mentions]
 */
export const sendMedia = async (sock, jid, quotedMsg, src, mime, caption, mentions = []) => {
    try {
        const isVideo = mime?.startsWith('video');
        let buf;
        if (Buffer.isBuffer(src)) {
            buf = src;
        }
        else {
            const res = await fetch(src);
            if (!res.ok)
                throw new Error('Gagal fetch media');
            buf = Buffer.from(await res.arrayBuffer());
        }
        const hasCaption = String(caption ?? '').trim().length > 0;
        if (isIosSender(quotedMsg) || !hasCaption) {
            const payload = isVideo
                ? { video: buf, mimetype: mime ?? 'video/mp4', caption: String(caption ?? '') }
                : { image: buf, mimetype: mime ?? 'image/jpeg', caption: String(caption ?? '') };
            await sock.sendMessage(jid, { ...payload, ...(mentions.length > 0 ? { mentions } : {}) }, { quoted: quotedMsg });
            return;
        }
        const generated = await generateWAMessageContent(isVideo ? { video: buf, mimetype: mime ?? 'video/mp4' } : { image: buf, mimetype: mime ?? 'image/jpeg' }, { upload: sock.waUploadToServer });
        const mediaMsg = isVideo
            ? (generated?.videoMessage ?? null)
            : (generated?.imageMessage ?? null);
        const header = mediaMsg
            ? (isVideo
                ? { videoMessage: mediaMsg, hasMediaAttachment: true }
                : { imageMessage: mediaMsg, hasMediaAttachment: true })
            : { title: '' };
        const built = generateWAMessageFromContent(jid, {
            viewOnceMessage: {
                message: {
                    interactiveMessage: {
                        header,
                        body: { text: '' },
                        footer: { text: String(caption ?? '') },
                        nativeFlowMessage: { buttons: [] },
                        contextInfo: {
                            stanzaId: quotedMsg.key.id,
                            participant: quotedMsg.key.participant || quotedMsg.key.remoteJid,
                            quotedMessage: quotedMsg.message,
                            ...(mentions.length > 0 ? { mentionedJid: mentions } : {})
                        }
                    }
                }
            }
        }, {
            quoted: quotedMsg,
            userJid: quotedMsg.key.participant ?? quotedMsg.key.remoteJid ?? jid
        });
        await sock.relayMessage(jid, built.message, { messageId: built.key.id });
    }
    catch (error) {
        console.error('[sendMedia] error:', error.message);
        throw error;
    }
};
