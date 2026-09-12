'use strict';

import { Boom } from "@hapi/boom";
import { randomBytes } from "crypto";
import { promises as fs } from "fs";
import { PassThrough, Readable } from "stream";
import sharp from "sharp";
import ffmpeg from "fluent-ffmpeg";
import { proto } from "../../WAProto/index.js";
import {
  CALL_AUDIO_PREFIX,
  CALL_VIDEO_PREFIX,
  MEDIA_KEYS,
  URL_REGEX,
  WA_DEFAULT_EPHEMERAL,
} from "../Defaults/index.js";
import { WAMessageStatus, WAProto } from "../Types/index.js";
import {
  isJidGroup,
  isJidNewsletter,
  isJidStatusBroadcast,
  jidNormalizedUser,
} from "../WABinary/index.js";
import { sha256 } from "./crypto.js";
import {
  generateMessageID,
  generateMessageIDV2,
  getKeyAuthor,
  unixTimestampSeconds,
} from "./generics.js";
import {
  downloadContentFromMessage,
  encryptedStream,
  generateThumbnail,
  getAudioDuration,
  getAudioWaveform,
  getRawMediaUploadData,
  getStream,
  toBuffer,
} from "./messages-media.js";

export const Toolkit = {
  async resize(input, width, height, fit = 'cover') {
    const buf = Buffer.isBuffer(input) ? input : await Toolkit.fetchBuffer(input);
    return sharp(buf).resize(width, height, { fit, position: 'center', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  },

  async fetchBuffer(url, options = {}, { silent = true } = {}) {
    try {
      const res = await fetch(url, options);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (silent) return Buffer.alloc(0);
      throw err;
    }
  },

  getMp4DurationSync(buf) {
    try {
      if (!Buffer.isBuffer(buf) || buf.length < 8) return 0;
      let offset = 0;
      while (offset < buf.length - 8) {
        const size = buf.readUInt32BE(offset);
        if (size < 8 || offset + size > buf.length) break;
        const type = buf.toString('ascii', offset + 4, offset + 8);
        if (type === 'moov') {
          let moovOffset = offset + 8;
          const moovEnd = offset + size;
          while (moovOffset < moovEnd - 8) {
            const childSize = buf.readUInt32BE(moovOffset);
            if (childSize < 8 || moovOffset + childSize > moovEnd) break;
            const childType = buf.toString('ascii', moovOffset + 4, moovOffset + 8);
            if (childType === 'mvhd') {
              const version = buf.readUInt8(moovOffset + 8);
              if (version === 0) {
                const timescale = buf.readUInt32BE(moovOffset + 20);
                const duration = buf.readUInt32BE(moovOffset + 24);
                return timescale ? duration / timescale : 0;
              }
              if (version === 1) {
                const timescale = buf.readUInt32BE(moovOffset + 32);
                const duration = Number(buf.readBigUInt64BE(moovOffset + 36));
                return timescale ? duration / timescale : 0;
              }
            }
            moovOffset += childSize;
          }
        }
        offset += size;
      }
      return 0;
    } catch { return 0; }
  },

  async getMp4Duration(input) {
    try {
      const buf = Buffer.isBuffer(input) ? input : await Toolkit.fetchBuffer(input);
      if (!buf || !buf.length) return 0;
      return Toolkit.getMp4DurationSync(buf);
    } catch { return 0; }
  },

  getMp4Preview(videoBuffer, { time, result = 'buffer', resize = true, width = 300, height = 150, silent = true } = {}) {
    return new Promise((resolve, reject) => {
      const fail = (err) => {
        if (silent) return resolve(result === 'base64' ? '' : Buffer.alloc(0));
        return reject(err);
      };
      try {
        if (!Buffer.isBuffer(videoBuffer) || !videoBuffer.length) return fail(new Error('Invalid buffer'));
        const inputStream = new Readable({ read() {} });
        inputStream.push(videoBuffer);
        inputStream.push(null);
        const outputStream = new PassThrough();
        const chunks = [];
        outputStream.on('data', (chunk) => chunks.push(chunk));
        outputStream.on('end', async () => {
          try {
            let output = Buffer.concat(chunks);
            if (!output.length) return fail(new Error('Empty output'));
            if (resize) output = await Toolkit.resize(output, width, height);
            return resolve(result === 'base64' ? output.toString('base64') : output);
          } catch (err) { return fail(err); }
        });
        outputStream.on('error', fail);
        time ??= Math.min(Toolkit.getMp4DurationSync(videoBuffer) * 0.2, 10);
        ffmpeg(inputStream)
          .outputOptions([`-ss ${time}`, '-vframes 1', '-vcodec png', '-f image2pipe'])
          .on('error', (err) => fail(new Error(`ffmpeg error: ${err.message}`)))
          .pipe(outputStream, { end: true });
      } catch (err) { return fail(err); }
    });
  },

  async resolveMedia(input, as = 'url') {
    if (!input) return null;
    if (as === 'buffer') {
      if (Buffer.isBuffer(input)) return input;
      if (typeof input === 'string' && input.startsWith('data:')) return Buffer.from(input.split(',')[1], 'base64');
      if (typeof input === 'string') return Toolkit.fetchBuffer(input);
    }
    if (as === 'base64') {
      const buf = await Toolkit.resolveMedia(input, 'buffer');
      return buf ? buf.toString('base64') : null;
    }
    if (typeof input === 'string' && !input.startsWith('data:')) return input;
    if (Buffer.isBuffer(input)) return `data:application/octet-stream;base64,${input.toString('base64')}`;
    return input;
  },

  async waitAllPromises(obj) {
    if (obj instanceof Promise) return Toolkit.waitAllPromises(await obj);
    if (Array.isArray(obj)) return Promise.all(obj.map(Toolkit.waitAllPromises));
    if (obj !== null && typeof obj === 'object') {
      const entries = await Promise.all(Object.entries(obj).map(async ([k, v]) => [k, await Toolkit.waitAllPromises(v)]));
      return Object.fromEntries(entries);
    }
    return obj;
  },

  extractIE(text, opts) {
    return extractIE(text, opts);
  }
};

function extractIE(text, { extract = true, hyperlink = true, citation = true, latex = true } = {}) {
  if (!extract) {
    return { text, ie: [], inline_entities: [] };
  }

  let ie = [], result = '', last = 0,
    citation_index = 1, hyperlink_index = 0, latex_index = 0,
    stack = [];

  for (let i = 0; i < text.length; i++) {
    if (text[i] === '[' && text[i - 1] !== '\\') {
      stack.push(i);
    } else if (text[i] === ']' && (text[i + 1] === '(' || text[i + 1] === '<')) {
      let start = stack.pop();
      if (start == null) continue;
      let open = text[i + 1],
        close = open === '(' ? ')' : '>',
        type = open === '(' ? 'link' : 'latex',
        end = i + 2, depth = 1;
      while (end < text.length && depth) {
        if (text[end] === open && text[end - 1] !== '\\') depth++;
        else if (text[end] === close && text[end - 1] !== '\\') depth--;
        end++;
      }
      if (depth) continue;
      let raw = text.slice(start + 1, i).trim(),
        url = text.slice(i + 2, end - 1).trim(),
        key, tag, data;

      if (type === 'latex') {
        if (!latex) continue;
        let [txt = '', width = null, height = null, font_height = null, padding = null] = raw.split('|');
        key = `NIXEL_LATEX_${latex_index++}`;
        tag = `{{${key}}}${txt || 'image'}{{/${key}}}`;
        data = { type: 'latex', ie: { key, text: txt, url, width, height, font_height, padding } };
      } else if (raw) {
        if (!hyperlink) continue;
        const isTrusted = !url.startsWith('!');
        const resolvedUrl = isTrusted ? url : url.slice(1);
        key = `NIXEL_HYPERLINK_${hyperlink_index++}`;
        tag = `{{${key}}}${resolvedUrl}{{/${key}}}`;
        data = { type: 'hyperlink', ie: { key, text: raw, url: resolvedUrl, is_trusted: isTrusted } };
      } else {
        if (!citation) continue;
        key = `NIXEL_CITATION_${citation_index - 1}`;
        tag = `{{${key}}}${url}{{/${key}}}`;
        data = { type: 'citation', ie: { reference_id: citation_index++, key, text: '', url } };
      }
      result += text.slice(last, start) + tag;
      last = end;
      ie.push(data);
      i = end - 1;
    }
  }
  result += text.slice(last);

  const inline_entities = ie.map(({ type, ie: e }) => {
    if (type === 'hyperlink') return {
      key: e.key,
      metadata: { display_name: e.text, is_trusted: e.is_trusted !== false, url: e.url, __typename: 'GenAIInlineLinkItem' }
    };
    if (type === 'citation') return {
      key: e.key,
      metadata: {
        reference_id: e.reference_id,
        reference_url: e.url,
        reference_title: e.url,
        reference_display_name: e.url,
        sources: [],
        __typename: 'GenAISearchCitationItem'
      }
    };
    if (type === 'latex') return {
      key: e.key,
      metadata: {
        latex_expression: e.text,
        latex_image: { url: e.url, width: Number(e.width) || 100, height: Number(e.height) || 100 },
        font_height: Number(e.font_height) || 83.333333333333,
        padding: Number(e.padding) || 15,
        __typename: 'GenAILatexItem'
      }
    };
  });

  return { text: result, ie, inline_entities };
}

export const waitAllPromises = (obj) => Toolkit.waitAllPromises(obj);

async function processLocationThumbnail(input, options = {}) {
  const { maxWidth = 300, maxHeight = 300, quality = 80 } = options;
  let buffer;
  if (typeof input === 'string' && (input.startsWith('http://') || input.startsWith('https://'))) {
    const stream = await getStream(input);
    buffer = await toBuffer(stream);
  } else if (typeof input === 'string') {
    buffer = await fs.readFile(input);
  } else if (Buffer.isBuffer(input)) {
    buffer = input;
  } else {
    throw new Error('thumbnail must be URL, path or Buffer');
  }
  return sharp(buffer)
    .resize(maxWidth, maxHeight, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality })
    .toBuffer();
}

const MIMETYPE_MAP = {
  image: "image/jpeg",
  video: "video/mp4",
  document: "application/pdf",
  audio: "audio/ogg; codecs=opus",
  sticker: "image/webp",
  "product-catalog-image": "image/jpeg",
};

const MessageTypeProto = {
  image: WAProto.Message.ImageMessage,
  video: WAProto.Message.VideoMessage,
  audio: WAProto.Message.AudioMessage,
  sticker: WAProto.Message.StickerMessage,
  document: WAProto.Message.DocumentMessage,
};

export const hasNonNullishProperty = (message, key) =>
  typeof message === 'object' &&
  message !== null &&
  key in message &&
  message[key] !== null &&
  message[key] !== undefined;

function hasOptionalProperty(obj, key) {
  return typeof obj === 'object' && obj !== null && key in obj && obj[key] !== null;
}

export const extractUrlFromText = (text) => text.match(URL_REGEX)?.[0];

export const generateLinkPreviewIfRequired = async (text, getUrlInfo, logger) => {
  const url = extractUrlFromText(text);
  if (!!getUrlInfo && url) {
    try {
      const urlInfo = await getUrlInfo(url);
      return urlInfo;
    } catch (error) {
      logger?.warn({ trace: error.stack }, "url generation failed");
    }
  }
};

const assertColor = async (color) => {
  let assertedColor;
  if (typeof color === "number") {
    assertedColor = color > 0 ? color : 0xffffffff + Number(color) + 1;
  } else {
    let hex = color.trim().replace("#", "");
    if (hex.length <= 6) {
      hex = "FF" + hex.padStart(6, "0");
    }
    assertedColor = parseInt(hex, 16);
    return assertedColor;
  }
};

export const prepareWAMessageMedia = async (message, options) => {
  const logger = options.logger;
  let mediaType;
  for (const key of MEDIA_KEYS) {
    if (key in message) {
      mediaType = key;
    }
  }
  if (!mediaType) {
    throw new Boom("Invalid media type", { statusCode: 400 });
  }
  const uploadData = { ...message, media: message[mediaType] };
  delete uploadData[mediaType];
  const cacheableKey =
    typeof uploadData.media === "object" &&
    "url" in uploadData.media &&
    !!uploadData.media.url &&
    !!options.mediaCache &&
    mediaType + ":" + uploadData.media.url.toString();
  if (mediaType === "document" && !uploadData.fileName) {
    uploadData.fileName = "file";
  }
  if (!uploadData.mimetype) {
    uploadData.mimetype = MIMETYPE_MAP[mediaType];
  }
  if (cacheableKey) {
    const mediaBuff = await options.mediaCache.get(cacheableKey);
    if (mediaBuff) {
      logger?.debug({ cacheableKey }, "got media cache hit");
      const obj = proto.Message.decode(mediaBuff);
      const key = `${mediaType}Message`;
      Object.assign(obj[key], { ...uploadData, media: undefined });
      return obj;
    }
  }
  const isNewsletter = !!options.jid && isJidNewsletter(options.jid);
  if (isNewsletter) {
    logger?.info({ key: cacheableKey }, "Preparing raw media for newsletter");
    const { filePath, fileSha256, fileLength } = await getRawMediaUploadData(
      uploadData.media,
      options.mediaTypeOverride || mediaType,
      logger,
    );
    const fileSha256B64 = fileSha256.toString("base64");
    const { mediaUrl, directPath } = await options.upload(filePath, {
      fileEncSha256B64: fileSha256B64,
      mediaType: mediaType,
      timeoutMs: options.mediaUploadTimeoutMs,
    });
    await fs.unlink(filePath);
    const obj = WAProto.Message.fromObject({
      [`${mediaType}Message`]: MessageTypeProto[mediaType].fromObject({
        url: mediaUrl,
        directPath,
        fileSha256,
        fileLength,
        ...uploadData,
        media: undefined,
      }),
    });
    if (uploadData.ptv) {
      obj.ptvMessage = obj.videoMessage;
      delete obj.videoMessage;
    }
    if (obj.stickerMessage) {
      obj.stickerMessage.stickerSentTs = Date.now();
    }
    if (cacheableKey) {
      logger?.debug({ cacheableKey }, "set cache");
      await options.mediaCache.set(cacheableKey, WAProto.Message.encode(obj).finish());
    }
    return obj;
  }
  const requiresDurationComputation = mediaType === "audio" && typeof uploadData.seconds === "undefined";
  const requiresThumbnailComputation =
    (mediaType === "image" || mediaType === "video") &&
    typeof uploadData["jpegThumbnail"] === "undefined";
  const requiresWaveformProcessing = mediaType === "audio" && uploadData.ptt === true;
  const requiresAudioBackground = options.backgroundColor && mediaType === "audio" && uploadData.ptt === true;
  const requiresOriginalForSomeProcessing = requiresDurationComputation || requiresThumbnailComputation;
  const {
    mediaKey,
    encFilePath,
    originalFilePath,
    fileEncSha256,
    fileSha256,
    fileLength,
  } = await encryptedStream(uploadData.media, options.mediaTypeOverride || mediaType, {
    logger,
    saveOriginalFileIfRequired: requiresOriginalForSomeProcessing,
    opts: options.options,
  });
  const fileEncSha256B64 = fileEncSha256.toString("base64");
  const [{ mediaUrl, directPath }] = await Promise.all([
    (async () => {
      const result = await options.upload(encFilePath, {
        fileEncSha256B64,
        mediaType,
        timeoutMs: options.mediaUploadTimeoutMs,
      });
      logger?.debug({ mediaType, cacheableKey }, "uploaded media");
      return result;
    })(),
    (async () => {
      try {
        if (requiresThumbnailComputation) {
          const { thumbnail, originalImageDimensions } = await generateThumbnail(originalFilePath, mediaType, options);
          uploadData.jpegThumbnail = thumbnail;
          if (!uploadData.width && originalImageDimensions) {
            uploadData.width = originalImageDimensions.width;
            uploadData.height = originalImageDimensions.height;
            logger?.debug("set dimensions");
          }
          logger?.debug("generated thumbnail");
        }
        if (requiresDurationComputation) {
          uploadData.seconds = await getAudioDuration(originalFilePath);
          logger?.debug("computed audio duration");
        }
        if (requiresWaveformProcessing) {
          uploadData.waveform = await getAudioWaveform(originalFilePath, logger);
          logger?.debug("processed waveform");
        }
        if (requiresAudioBackground) {
          uploadData.backgroundArgb = await assertColor(options.backgroundColor);
          logger?.debug("computed backgroundColor audio status");
        }
      } catch (error) {
        logger?.warn({ trace: error.stack }, "failed to obtain extra info");
      }
    })(),
  ]).finally(async () => {
    try {
      await fs.unlink(encFilePath);
      if (originalFilePath) {
        await fs.unlink(originalFilePath);
      }
      logger?.debug("removed tmp files");
    } catch (error) {
      logger?.warn("failed to remove tmp file");
    }
  });
  const obj = WAProto.Message.fromObject({
    [`${mediaType}Message`]: MessageTypeProto[mediaType].fromObject({
      url: mediaUrl,
      directPath,
      mediaKey,
      fileEncSha256,
      fileSha256,
      fileLength,
      mediaKeyTimestamp: unixTimestampSeconds(),
      ...uploadData,
      media: undefined,
    }),
  });
  if (uploadData.ptv) {
    obj.ptvMessage = obj.videoMessage;
    delete obj.videoMessage;
  }
  if (cacheableKey) {
    logger?.debug({ cacheableKey }, "set cache");
    await options.mediaCache.set(cacheableKey, WAProto.Message.encode(obj).finish());
  }
  return obj;
};

export const prepareAlbumMessageContent = async (jid, albums, options) => {
  if (!Array.isArray(albums)) {
    throw new Error("albums must be an array containing media objects.");
  }
  if (albums.length === 0) {
    throw new Error("albums cannot be empty. At least one media item is required.");
  }
  const validCount = albums.filter((m) => "image" in m || "video" in m).length;
  if (validCount === 0) {
    throw new Error("albums contains no valid media. Use 'image' or 'video' keys.");
  }
  let mediaHandle;
  let mediaMsg;
  const message = [];
  const albumMsg = generateWAMessageFromContent(
    jid,
    {
      albumMessage: {
        expectedImageCount: albums.filter((item) => "image" in item).length,
        expectedVideoCount: albums.filter((item) => "video" in item).length,
      },
    },
    options
  );
  await options.conn.relayMessage(jid, albumMsg.message, { messageId: albumMsg.key.id });
  for (const media of albums) {
    let content = {};
    if ("image" in media) {
      content = { image: media.image };
    } else if ("video" in media) {
      content = { video: media.video };
    } else {
      continue;
    }
    mediaMsg = await generateWAMessage(
      jid,
      { ...content, ...media },
      {
        userJid: options.userJid,
        upload: async (encFilePath, opts) => {
          const up = await options.conn.waUploadToServer(encFilePath, {
            ...opts,
            newsletter: isJidNewsletter(jid),
          });
          mediaHandle = up.handle;
          return up;
        },
        ...options,
      }
    );
    if (mediaMsg) {
      mediaMsg.message.messageContextInfo = {
        messageSecret: randomBytes(32),
        messageAssociation: {
          associationType: proto.MessageAssociation.AssociationType.MEDIA_ALBUM,
          parentMessageKey: albumMsg.key,
        },
      };
    }
    message.push(mediaMsg);
  }
  return message;
};

export const prepareDisappearingMessageSettingContent = (ephemeralExpiration) => {
  ephemeralExpiration = ephemeralExpiration || 0;
  const content = {
    ephemeralMessage: {
      message: {
        protocolMessage: {
          type: WAProto.Message.ProtocolMessage.Type.EPHEMERAL_SETTING,
          ephemeralExpiration,
        },
      },
    },
  };
  return WAProto.Message.fromObject(content);
};

export const generateForwardMessageContent = (message, forceForward) => {
  let content = message.message;
  if (!content) {
    throw new Boom("no content in message", { statusCode: 400 });
  }
  content = normalizeMessageContent(content);
  content = proto.Message.decode(proto.Message.encode(content).finish());
  let key = Object.keys(content)[0];
  let score = content?.[key]?.contextInfo?.forwardingScore || 0;
  score += message.key.fromMe && !forceForward ? 0 : 1;
  if (key === "conversation") {
    content.extendedTextMessage = { text: content[key] };
    delete content.conversation;
    key = "extendedTextMessage";
  }
  const key_ = content?.[key];
  if (score > 0) {
    key_.contextInfo = { forwardingScore: score, isForwarded: true };
  } else {
    key_.contextInfo = {};
  }
  return content;
};

export const generateWAMessageContent = async (message, options) => {
  let m = {};

  if (hasNonNullishProperty(message, "text")) {
    const extContent = { text: message.text };
    let urlInfo = message.linkPreview;
    if (typeof urlInfo === "undefined") {
      urlInfo = await generateLinkPreviewIfRequired(message.text, options.getUrlInfo, options.logger);
    }
    if (urlInfo) {
      extContent.canonicalUrl = urlInfo["canonical-url"];
      extContent.matchedText = urlInfo["matched-text"];
      extContent.jpegThumbnail = urlInfo.jpegThumbnail;
      extContent.description = urlInfo.description;
      extContent.title = urlInfo.title;
      extContent.previewType = 0;
      const img = urlInfo.highQualityThumbnail;
      if (img) {
        extContent.thumbnailDirectPath = img.directPath;
        extContent.mediaKey = img.mediaKey;
        extContent.mediaKeyTimestamp = img.mediaKeyTimestamp;
        extContent.thumbnailWidth = img.width;
        extContent.thumbnailHeight = img.height;
        extContent.thumbnailSha256 = img.fileSha256;
        extContent.thumbnailEncSha256 = img.fileEncSha256;
      }
    }
    if (options.backgroundColor) {
      extContent.backgroundArgb = await assertColor(options.backgroundColor);
    }
    if (options.textColor) {
      extContent.textArgb = await assertColor(options.textColor);
    }
    if (options.font) {
      extContent.font = options.font;
    }
    m.extendedTextMessage = extContent;

  } else if (hasNonNullishProperty(message, "contacts")) {
    const contactLen = message.contacts.contacts.length;
    if (!contactLen) {
      throw new Boom("require atleast 1 contact", { statusCode: 400 });
    }
    if (contactLen === 1) {
      m = { contactMessage: WAProto.Message.ContactMessage.fromObject(message.contacts.contacts[0]) };
    } else {
      m = { contactsArrayMessage: WAProto.Message.ContactsArrayMessage.fromObject(message.contacts) };
    }

  } else if (hasNonNullishProperty(message, "location")) {
    if (message.location?.jpegThumbnail && !Buffer.isBuffer(message.location.jpegThumbnail)) {
      message.location.jpegThumbnail = await processLocationThumbnail(message.location.jpegThumbnail);
    }
    if (message.live) {
      m = { liveLocationMessage: WAProto.Message.LiveLocationMessage.fromObject(message.location) };
    } else {
      m = { locationMessage: WAProto.Message.LocationMessage.fromObject(message.location) };
    }

  } else if (hasNonNullishProperty(message, "buttonsMessage")) {
    const raw = { ...message.buttonsMessage };
    if (raw.locationMessage) {
      if (raw.locationMessage.thumbnail && !raw.locationMessage.jpegThumbnail) {
        let tb = raw.locationMessage.thumbnail;
        if (typeof tb === 'string') tb = await Toolkit.fetchBuffer(tb);
        if (Buffer.isBuffer(tb) && tb.length) raw.locationMessage.jpegThumbnail = tb;
        delete raw.locationMessage.thumbnail;
      }
      if (raw.locationMessage.jpegThumbnail) {
        raw.locationMessage.jpegThumbnail = await processLocationThumbnail(raw.locationMessage.jpegThumbnail);
      }
    }
    if (raw.body && !raw.contentText) raw.contentText = raw.body;
    delete raw.body;
    if (raw.footer && !raw.footerText) raw.footerText = raw.footer;
    delete raw.footer;
    if (raw.thumbnail) {
      let tb = raw.thumbnail;
      if (typeof tb === 'string') tb = await Toolkit.fetchBuffer(tb);
      if (Buffer.isBuffer(tb)) raw.jpegThumbnail = tb;
      delete raw.thumbnail;
    }
    if (Array.isArray(raw.buttons)) {
      raw.buttons = raw.buttons.map(btn => {
        const mapped = { ...btn };
        if (mapped.text && !mapped.buttonText) {
          mapped.buttonText = { displayText: mapped.text };
          delete mapped.text;
        }
        if (mapped.id && !mapped.buttonId) {
          mapped.buttonId = mapped.id;
          delete mapped.id;
        }
        if (!mapped.type) mapped.type = 1;
        return mapped;
      });
    }
    if (!raw.headerType) {
      if (raw.jpegThumbnail) raw.headerType = 4;
      else if (raw.videoMessage) raw.headerType = 5;
      else if (raw.documentMessage) raw.headerType = 6;
      else if (raw.locationMessage) raw.headerType = 3;
      else raw.headerType = 1;
    }
    m = { buttonsMessage: raw };

  } else if (hasNonNullishProperty(message, "react")) {
    if (!message.react.senderTimestampMs) {
      message.react.senderTimestampMs = Date.now();
    }
    m.reactionMessage = WAProto.Message.ReactionMessage.fromObject(message.react);

  } else if (hasNonNullishProperty(message, "delete")) {
    m.protocolMessage = {
      key: message.delete,
      type: WAProto.Message.ProtocolMessage.Type.REVOKE,
    };

  } else if (hasNonNullishProperty(message, "sharePhoneNumber")) {
    m.protocolMessage = {
      type: proto.Message.ProtocolMessage.Type.SHARE_PHONE_NUMBER,
    };

  } else if (hasNonNullishProperty(message, "requestPhoneNumber")) {
    m.requestPhoneNumberMessage = {};

  } else if (hasNonNullishProperty(message, "forward")) {
    m = generateForwardMessageContent(message.forward, message.force);

  } else if (hasNonNullishProperty(message, "disappearingMessagesInChat")) {
    const exp =
      typeof message.disappearingMessagesInChat === "boolean"
        ? message.disappearingMessagesInChat
          ? WA_DEFAULT_EPHEMERAL
          : 0
        : message.disappearingMessagesInChat;
    m = prepareDisappearingMessageSettingContent(exp);

  } else if (hasNonNullishProperty(message, "groupInvite")) {
    m.groupInviteMessage = {};
    m.groupInviteMessage.inviteCode = message.groupInvite.code ?? message.groupInvite.inviteCode;
    m.groupInviteMessage.inviteExpiration = message.groupInvite.expiration ?? message.groupInvite.inviteExpiration;
    m.groupInviteMessage.caption = message.groupInvite.caption ?? message.groupInvite.text;
    m.groupInviteMessage.groupJid = message.groupInvite.jid;
    m.groupInviteMessage.groupName = message.groupInvite.name ?? message.groupInvite.subject;
    m.groupInviteMessage.contextInfo = message.contextInfo;
    if (options.getProfilePicUrl) {
      const pfpUrl = await options.getProfilePicUrl(message.groupInvite.jid);
      const { thumbnail } = await generateThumbnail(pfpUrl, "image");
      m.groupInviteMessage.jpegThumbnail = thumbnail;
    }

  } else if (hasNonNullishProperty(message, "adminInvite")) {
    m.newsletterAdminInviteMessage = {};
    m.newsletterAdminInviteMessage.newsletterJid = message.adminInvite.jid;
    m.newsletterAdminInviteMessage.newsletterName = message.adminInvite.name;
    m.newsletterAdminInviteMessage.caption = message.adminInvite.caption;
    m.newsletterAdminInviteMessage.inviteExpiration = message.adminInvite.expiration;
    m.newsletterAdminInviteMessage.contextInfo = message.contextInfo;
    if (options.getProfilePicUrl) {
      const pfpUrl = await options.getProfilePicUrl(message.adminInvite.jid);
      const { thumbnail } = await generateThumbnail(pfpUrl, "image");
      m.newsletterAdminInviteMessage.jpegThumbnail = thumbnail;
    }

  } else if (hasNonNullishProperty(message, "keep")) {
    m.keepInChatMessage = {};
    m.keepInChatMessage.key = message.keep.key;
    m.keepInChatMessage.keepType = message.keep?.type || 1;
    m.keepInChatMessage.timestampMs = message.keep?.time || Date.now();

  } else if (hasNonNullishProperty(message, "call")) {
    m.scheduledCallCreationMessage = {};
    m.scheduledCallCreationMessage.scheduledTimestampMs = message.call?.time || Date.now();
    m.scheduledCallCreationMessage.callType = message.call?.type || 1;
    m.scheduledCallCreationMessage.title = message.call?.name || "Call Creation";

  } else if (hasNonNullishProperty(message, "paymentInvite")) {
    m.messageContextInfo = {};
    m.paymentInviteMessage = {};
    m.paymentInviteMessage.expiryTimestamp = message.paymentInvite?.expiry || 0;
    m.paymentInviteMessage.serviceType = message.paymentInvite?.type || 2;

  } else if (hasNonNullishProperty(message, "payment")) {
    m.requestPaymentMessage = {
      amount: {
        currencyCode: message.payment?.currency || "IDR",
        offset: message.payment?.offset || 0,
        value: message.payment?.amount || 999999999,
      },
      expiryTimestamp: message.payment?.expiry || 0,
      amount1000: (message.payment?.amount || 999999999) * 1e3,
      currencyCodeIso4217: message.payment?.currency || "IDR",
      requestFrom: message.payment?.from || "0@s.whatsapp.net",
      noteMessage: {
        extendedTextMessage: { text: message.payment?.note || "Notes" },
      },
      background: {
        placeholderArgb: message.payment?.image?.placeholderArgb || 4278190080,
        textArgb: message.payment?.image?.textArgb || 4294967295,
        subtextArgb: message.payment?.image?.subtextArgb || 4294967295,
        type: 1,
      },
    };

  } else if (hasNonNullishProperty(message, "orderStatus")) {
    const os = message.orderStatus;
    if (!os.image) throw new Error("image is required for orderStatus");
    let imageInput = os.image;
    if (typeof imageInput === 'string' && !imageInput.startsWith('http://') && !imageInput.startsWith('https://')) {
      imageInput = await fs.readFile(imageInput);
    }
    const media = await prepareWAMessageMedia({ image: imageInput }, { upload: options.upload, ...options });
    m = {
      viewOnceMessage: {
        message: {
          messageContextInfo: {
            deviceListMetadata: {},
            deviceListMetadataVersion: 2,
          },
          interactiveMessage: proto.Message.InteractiveMessage.create({
            header: { title: os.title || "Order Status", hasMediaAttachment: true, ...media },
            body: { text: os.text || "Silakan cek status pesanan Anda." },
            footer: { text: os.footer || "have a reason" },
            nativeFlowMessage: {
              buttons: [
                {
                  name: "order_status",
                  buttonParamsJson: JSON.stringify({
                    reference_id: os.referenceId || "LV-001",
                    order: {
                      status: os.status || "PROCESSING",
                      subtotal: { value: os.subtotalValue || 0, offset: os.subtotalOffset || 100 },
                      tax: { value: os.taxValue || 0, offset: os.taxOffset || 100 },
                      currency: os.currency || "IDR",
                    },
                  }),
                },
              ],
            },
          }),
        },
      },
    };

  } else if (hasNonNullishProperty(message, "splitPayment")) {
    const sp = message.splitPayment;
    m = {
      interactiveMessage: {
        body: { text: sp.text || "" },
        nativeFlowMessage: {
          buttons: [
            {
              name: "split_payment",
              buttonParamsJson: JSON.stringify({
                reference_id: sp.referenceId || "LV-001",
                currency: sp.currency || "IDR",
                total_amount: {
                  value: sp.value || 0,
                  offset: sp.offset || 100,
                },
                order_type: sp.orderType || "ORDER",
              }),
            },
          ],
        },
      },
    };

  } else if (hasNonNullishProperty(message, "pin")) {
    m.pinInChatMessage = {};
    m.messageContextInfo = {};
    m.pinInChatMessage.key = message.pin;
    m.pinInChatMessage.type = message.type;
    m.pinInChatMessage.senderTimestampMs = Date.now();
    m.messageContextInfo.messageAddOnDurationInSecs = message.type === 1 ? message.time || 86400 : 0;

  } else if (hasNonNullishProperty(message, "limitSharing")) {
    m.protocolMessage = {
      type: proto.Message.ProtocolMessage.Type.LIMIT_SHARING,
      limitSharing: {
        sharingLimited: message.limitSharing === true,
        trigger: 1,
        limitSharingSettingTimestamp: Date.now(),
        initiatedByMe: true,
      },
    };

  } else if (hasNonNullishProperty(message, "ptv") && message.ptv) {
    const { videoMessage } = await prepareWAMessageMedia({ video: message.video }, options);
    m.ptvMessage = videoMessage;

  } else if (hasNonNullishProperty(message, "order")) {
    m.orderMessage = WAProto.Message.OrderMessage.fromObject(message.order);

  } else if (hasNonNullishProperty(message, "product")) {
    const { imageMessage } = await prepareWAMessageMedia({ image: message.product.productImage }, options);
    m.productMessage = WAProto.Message.ProductMessage.fromObject({
      ...message,
      product: { ...message.product, productImage: imageMessage },
    });

  } else if (hasNonNullishProperty(message, "album")) {
    const imageMessages = message.album.filter((item) => "image" in item);
    const videoMessages = message.album.filter((item) => "video" in item);
    m.albumMessage = WAProto.Message.AlbumMessage.fromObject({
      expectedImageCount: imageMessages.length,
      expectedVideoCount: videoMessages.length,
    });

  } else if (hasNonNullishProperty(message, "listReply")) {
    m.listResponseMessage = { ...message.listReply };

  } else if (hasNonNullishProperty(message, "event")) {
    m.eventMessage = {};
    const startTime = Math.floor(message.event.startDate?.getTime?.() / 1000 ?? unixTimestampSeconds() + 86400);
    if (message.event.call && options.getCallLink) {
      const token = await options.getCallLink(message.event.call, { startTime });
      m.eventMessage.joinLink =
        (message.event.call === "audio" ? CALL_AUDIO_PREFIX : CALL_VIDEO_PREFIX) + token;
    }
    m.messageContextInfo = {
      messageSecret: message.event.messageSecret || randomBytes(32),
    };
    m.eventMessage.name = message.event.name;
    m.eventMessage.description = message.event.description;
    m.eventMessage.startTime = startTime;
    m.eventMessage.endTime = message.event.endDate ? message.event.endDate.getTime() / 1000 : undefined;
    m.eventMessage.isCanceled = message.event.isCancelled ?? false;
    m.eventMessage.extraGuestsAllowed = message.event.extraGuestsAllowed;
    m.eventMessage.isScheduleCall = message.event.isScheduleCall ?? false;
    m.eventMessage.location = message.event.location;

  } else if (hasNonNullishProperty(message, "pollResult")) {
    if (!Array.isArray(message.pollResult.values)) {
      throw new Boom("Invalid pollResult values", { statusCode: 400 });
    }
    m.pollResultSnapshotMessage = {
      name: message.pollResult.name,
      pollVotes: message.pollResult.values.map(([optionName, optionVoteCount]) => ({
        optionName,
        optionVoteCount,
      })),
    };

  } else if (hasNonNullishProperty(message, "poll")) {
    message.poll.selectableCount ??= 0;
    message.poll.toAnnouncementGroup ??= false;
    if (!Array.isArray(message.poll.values)) {
      throw new Boom("Invalid poll values", { statusCode: 400 });
    }
    if (message.poll.selectableCount < 0 || message.poll.selectableCount > message.poll.values.length) {
      throw new Boom(
        `poll.selectableCount in poll should be >= 0 and <= ${message.poll.values.length}`,
        { statusCode: 400 }
      );
    }
    m.messageContextInfo = {
      messageSecret: message.poll.messageSecret || randomBytes(32),
    };
    const pollCreationMessage = {
      name: message.poll.name,
      selectableOptionsCount: message.poll.selectableCount,
      options: message.poll.values.map((optionName) => ({ optionName })),
    };
    if (message.poll.toAnnouncementGroup) {
      m.pollCreationMessageV2 = pollCreationMessage;
    } else {
      if (message.poll.selectableCount === 1) {
        m.pollCreationMessageV3 = pollCreationMessage;
      } else {
        m.pollCreationMessage = pollCreationMessage;
      }
    }

  } else if (hasNonNullishProperty(message, "nativeFlowMessage")) {
    const nf = message.nativeFlowMessage;
    const raw = nf.buttons ?? [];
    const buttons = raw.map(btn => {
      if (btn.name && btn.buttonParamsJson !== undefined) return btn;
      const type = btn.type ?? 'reply';
      const text = btn.text ?? btn.display_text ?? '';
      const id = btn.id ?? '';
      if (type === 'reply') return { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: text, id }) };
      if (type === 'url') return { name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: text, url: btn.url ?? '', webview_interaction: btn.webview ?? false }) };
      if (type === 'call') return { name: 'cta_call', buttonParamsJson: JSON.stringify({ display_text: text, id }) };
      if (type === 'copy') return { name: 'cta_copy', buttonParamsJson: JSON.stringify({ display_text: text, copy_code: btn.copy_code ?? btn.code ?? '' }) };
      if (type === 'location') return { name: 'send_location', buttonParamsJson: JSON.stringify({}) };
      if (type === 'address') return { name: 'address_message', buttonParamsJson: JSON.stringify({ display_text: text, id }) };
      if (type === 'reminder') return { name: 'cta_reminder', buttonParamsJson: JSON.stringify({ display_text: text, id }) };
      if (type === 'cancel_reminder') return { name: 'cta_cancel_reminder', buttonParamsJson: JSON.stringify({ display_text: text, id }) };
      return { name: type, buttonParamsJson: JSON.stringify(btn.params ?? {}) };
    });
    let header = { title: nf.title ?? '', subtitle: nf.subtitle ?? '', hasMediaAttachment: false };
    if (nf.image || nf.video || nf.document) {
      const mediaKey = nf.image ? 'image' : nf.video ? 'video' : 'document';
      const mediaVal = nf[mediaKey];
      try {
        const uploaded = await prepareWAMessageMedia({ [mediaKey]: typeof mediaVal === 'string' ? { url: mediaVal } : mediaVal }, options);
        Object.assign(header, uploaded);
        header.hasMediaAttachment = true;
      } catch (_) {
        header[mediaKey] = typeof mediaVal === 'string' ? { url: mediaVal } : mediaVal;
        header.hasMediaAttachment = true;
      }
    }
    m = {
      interactiveMessage: {
        header,
        body: { text: nf.body ?? '' },
        footer: { text: nf.footer ?? '' },
        contextInfo: nf.contextInfo ?? {},
        nativeFlowMessage: { messageParamsJson: JSON.stringify(nf.params ?? {}), buttons },
      }
    };

  } else if (hasNonNullishProperty(message, "buttonReply")) {
    switch (message.type) {
      case "list":
        m.listResponseMessage = {
          title: message.buttonReply.title,
          description: message.buttonReply.description,
          singleSelectReply: { selectedRowId: message.buttonReply.rowId },
          lisType: proto.Message.ListResponseMessage.ListType.SINGLE_SELECT,
        };
        break;
      case "template":
        m.templateButtonReplyMessage = {
          selectedDisplayText: message.buttonReply.displayText,
          selectedId: message.buttonReply.id,
          selectedIndex: message.buttonReply.index,
        };
        break;
      case "plain":
        m.buttonsResponseMessage = {
          selectedButtonId: message.buttonReply.id,
          selectedDisplayText: message.buttonReply.displayText,
          type: proto.Message.ButtonsResponseMessage.Type.DISPLAY_TEXT,
        };
        break;
      case "interactive":
        m.interactiveResponseMessage = {
          body: {
            text: message.buttonReply.displayText,
            format: proto.Message.InteractiveResponseMessage.Body.Format.EXTENSIONS_1,
          },
          nativeFlowResponseMessage: {
            name: message.buttonReply.nativeFlows.name,
            paramsJson: message.buttonReply.nativeFlows.paramsJson,
            version: message.buttonReply.nativeFlows.version,
          },
        };
        break;
    }

  } else if (hasNonNullishProperty(message, "sections")) {
    m.listMessage = {
      title: message.title,
      buttonText: message.buttonText,
      footerText: message.footer,
      description: message.text,
      sections: message.sections,
      listType: proto.Message.ListMessage.ListType.SINGLE_SELECT,
    };

  } else if (hasNonNullishProperty(message, "productList")) {
    const thumbnail = message.thumbnail ? await generateThumbnail(message.thumbnail, "image") : null;
    m.listMessage = {
      title: message.title,
      buttonText: message.buttonText,
      footerText: message.footer,
      description: message.text,
      productListInfo: {
        productSections: message.productList,
        headerImage: {
          productId: message.productList[0].products[0].productId,
          jpegThumbnail: thumbnail?.thumbnail || null,
        },
        businessOwnerJid: message.businessOwnerJid,
      },
      listType: proto.Message.ListMessage.ListType.PRODUCT_LIST,
    };

  } else if (hasNonNullishProperty(message, "buttons")) {
    const buttonsMessage = {
      buttons: message.buttons.map((b) => ({
        ...b,
        type: proto.Message.ButtonsMessage.Button.Type.RESPONSE,
      })),
    };
    if (hasNonNullishProperty(message, "text")) {
      buttonsMessage.contentText = message.text;
      buttonsMessage.headerType = proto.Message.ButtonsMessage.HeaderType.EMPTY;
    } else {
      if (hasNonNullishProperty(message, "caption")) {
        buttonsMessage.contentText = message.caption;
      }
      const type = Object.keys(m)[0].replace("Message", "").toUpperCase();
      buttonsMessage.headerType = proto.Message.ButtonsMessage.HeaderType[type];
      Object.assign(buttonsMessage, m);
    }
    if (hasNonNullishProperty(message, "title")) {
      buttonsMessage.text = message.title;
      buttonsMessage.headerType = proto.Message.ButtonsMessage.HeaderType.TEXT;
    }
    if (hasNonNullishProperty(message, "footer")) {
      buttonsMessage.footerText = message.footer;
    }
    m = { buttonsMessage };

  } else if (hasNonNullishProperty(message, "templateButtons")) {
    const hydratedTemplate = { hydratedButtons: message.templateButtons };
    if (hasNonNullishProperty(message, "text")) {
      hydratedTemplate.hydratedContentText = message.text;
    } else {
      if (hasNonNullishProperty(message, "caption")) {
        hydratedTemplate.hydratedContentText = message.caption;
      }
    }
    if (hasNonNullishProperty(message, "footer")) {
      hydratedTemplate.hydratedFooterText = message.footer;
    }
    m = { templateMessage: { hydratedTemplate } };

  } else if (hasNonNullishProperty(message, "interactiveButtons")) {
    const interactiveMessage = {
      nativeFlowMessage: { buttons: message.interactiveButtons },
    };
    if (hasNonNullishProperty(message, "text")) {
      interactiveMessage.body = { text: message.text };
    }
    if (hasNonNullishProperty(message, "title")) {
      interactiveMessage.header = {
        title: message.title,
        subtitle: null,
        hasMediaAttachment: false,
      };
      if (hasNonNullishProperty(message, "subtitle")) {
        interactiveMessage.header.subtitle = message.subtitle;
      }
    } else if (hasNonNullishProperty(message, "caption")) {
      interactiveMessage.body = { text: message.caption };
      interactiveMessage.header = {
        title: null,
        subtitle: null,
        hasMediaAttachment: false,
        ...Object.assign(interactiveMessage, m),
      };
      if (hasNonNullishProperty(message, "title")) interactiveMessage.header.title = message.title;
      if (hasNonNullishProperty(message, "subtitle")) interactiveMessage.header.subtitle = message.subtitle;
      if (hasNonNullishProperty(message, "hasMediaAttachment")) interactiveMessage.header.hasMediaAttachment = Boolean(message.hasMediaAttachment);
    }
    if (hasNonNullishProperty(message, "footer")) {
      interactiveMessage.footer = { text: message.footer };
    }
    m = { interactiveMessage };

  } else if (hasNonNullishProperty(message, "shop")) {
    const interactiveMessage = {
      shopStorefrontMessage: { surface: message.shop.surface, id: message.shop.id },
    };
    if (hasNonNullishProperty(message, "text")) interactiveMessage.body = { text: message.text };
    if (hasNonNullishProperty(message, "title")) {
      interactiveMessage.header = { title: message.title, subtitle: null, hasMediaAttachment: false };
      if (hasNonNullishProperty(message, "subtitle")) interactiveMessage.header.subtitle = message.subtitle;
    } else if (hasNonNullishProperty(message, "caption")) {
      interactiveMessage.body = { text: message.caption };
      interactiveMessage.header = { title: null, subtitle: null, hasMediaAttachment: false, ...Object.assign(interactiveMessage, m) };
      if (hasNonNullishProperty(message, "title")) interactiveMessage.header.title = message.title;
      if (hasNonNullishProperty(message, "subtitle")) interactiveMessage.header.subtitle = message.subtitle;
      if (hasNonNullishProperty(message, "hasMediaAttachment")) interactiveMessage.header.hasMediaAttachment = Boolean(message.hasMediaAttachment);
    }
    if (hasNonNullishProperty(message, "footer")) interactiveMessage.footer = { text: message.footer };
    m = { interactiveMessage };

  } else if (hasNonNullishProperty(message, "collection")) {
    const interactiveMessage = {
      collectionMessage: {
        bizJid: message.collection.bizJid,
        id: message.collection.id,
        messageVersion: message?.collection?.version,
      },
    };
    if (hasNonNullishProperty(message, "text")) interactiveMessage.body = { text: message.text };
    if (hasNonNullishProperty(message, "title")) {
      interactiveMessage.header = { title: message.title, subtitle: null, hasMediaAttachment: false };
      if (hasNonNullishProperty(message, "subtitle")) interactiveMessage.header.subtitle = message.subtitle;
    } else if (hasNonNullishProperty(message, "caption")) {
      interactiveMessage.body = { text: message.caption };
      interactiveMessage.header = { title: null, subtitle: null, hasMediaAttachment: false, ...Object.assign(interactiveMessage, m) };
      if (hasNonNullishProperty(message, "title")) interactiveMessage.header.title = message.title;
      if (hasNonNullishProperty(message, "subtitle")) interactiveMessage.header.subtitle = message.subtitle;
      if (hasNonNullishProperty(message, "hasMediaAttachment")) interactiveMessage.header.hasMediaAttachment = Boolean(message.hasMediaAttachment);
    }
    if (hasNonNullishProperty(message, "footer")) interactiveMessage.footer = { text: message.footer };
    m = { interactiveMessage };

  } else if (hasNonNullishProperty(message, "cards")) {
    const slides = await Promise.all(
      message.cards.map(async (slide) => {
        const { image, video, product, title, body, footer, buttons } = slide;
        let header;
        if (product) {
          const { imageMessage } = await prepareWAMessageMedia({ image: product.productImage, ...options }, options);
          header = { productMessage: { product: { ...product, productImage: imageMessage }, ...slide } };
        } else if (image) {
          header = await prepareWAMessageMedia({ image, ...options }, options);
        } else if (video) {
          header = await prepareWAMessageMedia({ video, ...options }, options);
        }
        return {
          header: { title, hasMediaAttachment: true, ...header },
          body: { text: body },
          footer: { text: footer },
          nativeFlowMessage: { buttons },
        };
      })
    );
    const interactiveMessage = { carouselMessage: { cards: slides } };
    if (hasNonNullishProperty(message, "text")) interactiveMessage.body = { text: message.text };
    if (hasNonNullishProperty(message, "title")) {
      interactiveMessage.header = { title: message.title, subtitle: null, hasMediaAttachment: false };
      if (hasNonNullishProperty(message, "subtitle")) interactiveMessage.header.subtitle = message.subtitle;
    } else if (hasNonNullishProperty(message, "caption")) {
      interactiveMessage.body = { text: message.caption };
      interactiveMessage.header = { title: null, subtitle: null, hasMediaAttachment: false, ...Object.assign(interactiveMessage, m) };
      if (hasNonNullishProperty(message, "title")) interactiveMessage.header.title = message.title;
      if (hasNonNullishProperty(message, "subtitle")) interactiveMessage.header.subtitle = message.subtitle;
      if (hasNonNullishProperty(message, "hasMediaAttachment")) interactiveMessage.header.hasMediaAttachment = Boolean(message.hasMediaAttachment);
    }
    if (hasNonNullishProperty(message, "footer")) interactiveMessage.footer = { text: message.footer };
    m = { interactiveMessage };

  } else if (hasNonNullishProperty(message, "carouselMessage")) {
    const cm = message.carouselMessage;
    const cards = await Promise.all((cm.cards ?? []).map(async card => {
      let header = { title: card.title ?? '', subtitle: card.subtitle ?? '', hasMediaAttachment: false };
      if (card.image || card.video) {
        const mediaKey = card.image ? 'image' : 'video';
        const mediaVal = card[mediaKey];
        try {
          const uploaded = await prepareWAMessageMedia({ [mediaKey]: typeof mediaVal === 'string' ? { url: mediaVal } : mediaVal }, options);
          Object.assign(header, uploaded);
          header.hasMediaAttachment = true;
        } catch (_) {
          header[mediaKey] = typeof mediaVal === 'string' ? { url: mediaVal } : mediaVal;
          header.hasMediaAttachment = true;
        }
      }
      const buttons = (card.buttons ?? []).map(btn => {
        if (btn.name && btn.buttonParamsJson !== undefined) return btn;
        const type = btn.type ?? 'reply';
        const text = btn.text ?? btn.display_text ?? '';
        const id = btn.id ?? '';
        if (type === 'reply') return { name: 'quick_reply', buttonParamsJson: JSON.stringify({ display_text: text, id }) };
        if (type === 'url') return { name: 'cta_url', buttonParamsJson: JSON.stringify({ display_text: text, url: btn.url ?? '', webview_interaction: btn.webview ?? false }) };
        if (type === 'call') return { name: 'cta_call', buttonParamsJson: JSON.stringify({ display_text: text, id }) };
        if (type === 'copy') return { name: 'cta_copy', buttonParamsJson: JSON.stringify({ display_text: text, copy_code: btn.copy_code ?? btn.code ?? '' }) };
        return { name: type, buttonParamsJson: JSON.stringify(btn.params ?? {}) };
      });
      return {
        body: { text: card.body ?? '' },
        footer: { text: card.footer ?? '' },
        header,
        nativeFlowMessage: { messageParamsJson: JSON.stringify(card.params ?? {}), buttons },
      };
    }));
    m = {
      interactiveMessage: {
        header: { hasMediaAttachment: false },
        body: { text: cm.body ?? '' },
        footer: { text: cm.footer ?? '' },
        contextInfo: cm.contextInfo ?? {},
        carouselMessage: { cards },
      }
    };

  } else if (hasNonNullishProperty(message, "bloksWidget") || hasNonNullishProperty(message, "widget")) {
    const w = message.bloksWidget ?? message.widget;
    const { randomUUID } = await import("crypto");
    const uuid = w.uuid ?? randomUUID();
    const data = typeof w.data === "string" ? w.data : JSON.stringify(w.data ?? {});
    const type = w.type ?? "im_a2ui";
    const raw = message.buttons ?? w.buttons ?? [];
    const buttons = raw.map(btn => {
      if (btn.name && btn.buttonParamsJson !== undefined) return btn;
      const bType = btn.type ?? "reply";
      const text = btn.text ?? btn.display_text ?? "";
      const id = btn.id ?? "";
      if (bType === "reply") return { name: "quick_reply", buttonParamsJson: JSON.stringify({ display_text: text, id }) };
      if (bType === "url") return { name: "cta_url", buttonParamsJson: JSON.stringify({ display_text: text, url: btn.url ?? "", webview_interaction: btn.webview ?? false }) };
      return { name: bType, buttonParamsJson: JSON.stringify(btn.params ?? {}) };
    });
    m = {
      interactiveMessage: {
        header: message.header ?? { hasMediaAttachment: false },
        body: { text: message.text ?? message.body ?? "" },
        footer: { text: message.footer ?? "" },
        contextInfo: message.contextInfo ?? {},
        nativeFlowMessage: {
          buttons,
          messageParamsJson: typeof message.messageParamsJson === "string" ? message.messageParamsJson : JSON.stringify(message.messageParamsJson ?? {}),
          messageVersion: message.messageVersion ?? 1
        },
        bloksWidget: {
          uuid,
          data,
          type
        }
      }
    };

  } else if (hasNonNullishProperty(message, "richMessage")) {
    const { randomUUID } = await import('crypto');
    const rich = message.richMessage;
    const submessages = [];
    const sections = [];
    const embeddedScreens = [];
    const richResponseSources = [];

    const tokenizer = (code, lang = 'javascript') => {
      const normalizedLang = lang.toLowerCase();

      if (normalizedLang === 'plaintext' || normalizedLang === 'txt' || normalizedLang === 'text') {
        const raw = [{ codeContent: code, highlightType: 0 }];
        return {
          codeBlock: raw,
          unified_codeBlock: raw.map(t => ({ content: t.codeContent, type: 'DEFAULT' }))
        };
      }

      const keywordsMap = {
        javascript: new Set(['break','case','catch','continue','debugger','delete','do','else','finally','for','function','if','in','instanceof','new','return','switch','this','throw','try','typeof','var','void','while','with','true','false','null','undefined','class','const','let','super','extends','export','import','yield','static','constructor','async','await','get','set']),
        typescript: new Set(['break','case','catch','continue','debugger','delete','do','else','finally','for','function','if','in','instanceof','new','return','switch','this','throw','try','typeof','var','void','while','with','true','false','null','undefined','class','const','let','super','extends','export','import','yield','static','constructor','async','await','get','set','type','interface','enum','namespace','declare','abstract','implements','as','from','of','readonly','keyof','infer','never','unknown','any']),
        python: new Set(['False','None','True','and','as','assert','async','await','break','class','continue','def','del','elif','else','except','finally','for','from','global','if','import','in','is','lambda','nonlocal','not','or','pass','raise','return','try','while','with','yield']),
        java: new Set(['abstract','assert','boolean','break','byte','case','catch','char','class','const','continue','default','do','double','else','enum','extends','final','finally','float','for','goto','if','implements','import','instanceof','int','interface','long','native','new','null','package','private','protected','public','return','short','static','strictfp','super','switch','synchronized','this','throw','throws','transient','try','void','volatile','while','true','false']),
        go: new Set(['break','case','chan','const','continue','default','defer','else','fallthrough','for','func','go','goto','if','import','interface','map','package','range','return','select','struct','switch','type','var','true','false','nil','iota']),
        c: new Set(['auto','break','case','char','const','continue','default','do','double','else','enum','extern','float','for','goto','if','inline','int','long','register','restrict','return','short','signed','sizeof','static','struct','switch','typedef','union','unsigned','void','volatile','while','NULL','true','false']),
        php: new Set(['abstract','and','array','as','break','callable','case','catch','class','clone','const','continue','declare','default','die','do','echo','else','elseif','empty','enddeclare','endfor','endforeach','endif','endswitch','endwhile','eval','exit','extends','final','finally','fn','for','foreach','function','global','goto','if','implements','include','include_once','instanceof','insteadof','interface','isset','list','match','namespace','new','null','or','print','private','protected','public','readonly','require','require_once','return','static','switch','throw','trait','true','try','unset','use','var','while','xor','yield','false']),
        rust: new Set(['as','async','await','break','const','continue','crate','dyn','else','enum','extern','false','fn','for','if','impl','in','let','loop','match','mod','move','mut','pub','ref','return','self','Self','static','struct','super','trait','true','type','union','unsafe','use','where','while']),
        html: new Set(['DOCTYPE','html','head','body','div','span','p','a','ul','ol','li','table','tr','td','th','thead','tbody','tfoot','form','input','button','select','option','textarea','label','script','style','link','meta','title','h1','h2','h3','h4','h5','h6','img','video','audio','canvas','svg','nav','header','footer','section','article','aside','main']),
        bash: new Set(['if','then','else','elif','fi','for','in','do','done','while','until','case','esac','function','select','time','coproc','break','continue','return','exit','export','local','declare','readonly','unset','set','shift','source','echo','printf','read','test','true','false']),
        markdown: new Set([]),
      };

      const TYPE_MAP = { 0: 'DEFAULT', 1: 'KEYWORD', 2: 'METHOD', 3: 'STR', 4: 'NUMBER', 5: 'COMMENT' };
      const keywords = keywordsMap[normalizedLang] || new Set();
      const tokens = [];
      let i = 0;

      const push = (content, type) => {
        if (!content) return;
        const last = tokens[tokens.length - 1];
        if (last && last.highlightType === type) last.codeContent += content;
        else tokens.push({ codeContent: content, highlightType: type });
      };

      const isIdentStart = (c) => /[a-zA-Z_$]/.test(c);
      const isIdentPart = (c) => {
        if (normalizedLang === 'css') return /[a-zA-Z0-9_$-]/.test(c);
        if (normalizedLang === 'html') return /[a-zA-Z0-9_$:-]/.test(c);
        return /[a-zA-Z0-9_$]/.test(c);
      };

      while (i < code.length) {
        const c = code[i];
        if (/\s/.test(c)) {
          let s = i;
          while (i < code.length && /\s/.test(code[i])) i++;
          push(code.slice(s, i), 0);
          continue;
        }
        if (c === '/' && code[i + 1] === '/') {
          let s = i; i += 2;
          while (i < code.length && code[i] !== '\n') i++;
          push(code.slice(s, i), 5);
          continue;
        }
        if (c === '#' && (normalizedLang === 'python' || normalizedLang === 'bash')) {
          let s = i++;
          while (i < code.length && code[i] !== '\n') i++;
          push(code.slice(s, i), 5);
          continue;
        }
        if (c === '/' && code[i + 1] === '*') {
          let s = i; i += 2;
          while (i < code.length - 1 && !(code[i] === '*' && code[i + 1] === '/')) i++;
          i += 2;
          push(code.slice(s, i), 5);
          continue;
        }
        if (c === '"' || c === "'" || c === '`') {
          let s = i; const q = c; i++;
          while (i < code.length) {
            if (code[i] === '\\' && i + 1 < code.length) i += 2;
            else if (code[i] === q) { i++; break; }
            else i++;
          }
          push(code.slice(s, i), 3);
          continue;
        }
        if (/[0-9]/.test(c)) {
          let s = i;
          while (i < code.length && /[0-9.xXa-fA-F_]/.test(code[i])) i++;
          push(code.slice(s, i), 4);
          continue;
        }
        if (isIdentStart(c)) {
          let s = i;
          while (i < code.length && isIdentPart(code[i])) i++;
          const word = code.slice(s, i);
          let type = 0;
          if (keywords.has(word)) {
            type = 1;
          } else {
            if (normalizedLang === 'html' && s > 0 && (code[s - 1] === '<' || (code[s - 1] === '/' && code[s - 2] === '<'))) {
              type = 1;
            } else {
              let j = i;
              while (j < code.length && /\s/.test(code[j])) j++;
              if (normalizedLang === 'css' && code[j] === ':') {
                type = 1;
              } else if (code[j] === '(') {
                type = 2;
              }
            }
          }
          push(word, type);
          continue;
        }
        push(c, 0); i++;
      }

      return {
        codeBlock: tokens,
        unified_codeBlock: tokens.map(t => ({ content: t.codeContent, type: TYPE_MAP[t.highlightType] }))
      };
    };

    const toTableMetadata = (arr, { hyperlink = false, citation = false, latex = false } = {}) => {
      if (!Array.isArray(arr) || !arr.every(row => Array.isArray(row) && row.every(cell => typeof cell === 'string'))) {
        throw new TypeError('Table must be a nested array of strings');
      }
      const [header, ...rows] = arr;
      const maxLen = Math.max(header.length, ...rows.map(r => r.length));
      const normalize = (r) => [...r, ...Array(maxLen - r.length).fill('')];
      const shouldExtractIE = hyperlink || citation || latex;
      let hasEntities = false;
      const processRow = (cells, isHeader) => {
        const processed = normalize(cells).map(cell => {
          if (!shouldExtractIE) return { text: cell };
          const { text, inline_entities } = extractIE(cell, { hyperlink, citation, latex });
          if (inline_entities.length) hasEntities = true;
          return { text, inline_entities };
        });
        return { is_header: isHeader, cells: processed.map(c => c.text), _meta: processed };
      };
      const unified_rows = [processRow(header, true), ...rows.map(r => processRow(r, false))];
      const result = {
        title: '',
        rows: unified_rows.map(r => ({ items: r.cells, ...(r.is_header ? { isHeading: true } : {}) })),
        unified_rows: unified_rows.map(r => ({ is_header: r.is_header, cells: r.cells }))
      };
      if (hasEntities) {
        result.markdown_cells = unified_rows.map(r => r._meta.map(c => ({ text: c.text, inline_entities: c.inline_entities || [] })));
      }
      return result;
    };

    const newLayout = (name, data, extra = {}) => ({
      view_model: {
        [Array.isArray(data) ? 'primitives' : 'primitive']: data,
        __typename: `GenAI${name}LayoutViewModel`,
        ...extra
      }
    });

    if (rich.product || rich.products) {
      const raw = rich.product || rich.products;
      const items = Array.isArray(raw) ? raw : [raw];
      submessages.push({ messageType: 2, messageText: '[ CANNOT_LOAD_PRODUCT ]' });
      const mapped = await Promise.all(items.map(async item => {
        const imageUrl = await Toolkit.resolveMedia(
          typeof item.image === 'string' ? item.image : item.image?.url ?? item.image_url ?? '', 'url'
        );
        const iconUrl = await Toolkit.resolveMedia(item.icon_url ?? item.icon ?? imageUrl ?? '', 'url');
        return {
          title: item.title ?? '',
          brand: item.brand ?? '',
          price: item.price ?? '',
          sale_price: item.sale_price ?? '',
          product_url: item.product_url ?? item.url ?? '',
          image: { url: imageUrl },
          additional_images: [{ url: iconUrl }],
          __typename: 'GenAIProductItemCardPrimitive'
        };
      }));
      sections.push(newLayout(items.length > 1 ? 'HScroll' : 'Single', items.length > 1 ? mapped : mapped[0]));
    }

    if (rich.image || rich.images) {
      const raw = rich.image || rich.images;
      const inputs = Array.isArray(raw) ? raw : [raw];
      const urls = await Promise.all(inputs.map(item => Toolkit.resolveMedia(item, 'url')));
      submessages.push({
        messageType: 1,
        gridImageMetadata: {
          gridImageUrl: { imagePreviewUrl: urls[0] },
          imageUrls: urls.map(url => ({ imagePreviewUrl: url, imageHighResUrl: url, sourceUrl: url }))
        }
      });
      urls.forEach(url => sections.push(newLayout('Single', {
        media: { url, mime_type: 'image/png' },
        imagine_type: 'IMAGE',
        status: { status: 'READY' },
        __typename: 'GenAIImaginePrimitive'
      })));
    }

    if (rich.video || rich.videos) {
      const raw = rich.video || rich.videos;
      const isObjectVideo = (v) => v && typeof v === 'object' && !Array.isArray(v) && (v.url || v.videoUrl);
      const rawEntries = Array.isArray(raw) ? raw : [raw];
      submessages.push({ messageType: 2, messageText: '[ CANNOT_LOAD_VIDEO - NIXEL ]' });
      rawEntries.forEach(item => {
        const isObj = isObjectVideo(item);
        const rawUrl = isObj ? (item.url ?? item.videoUrl ?? '') : (typeof item === 'string' ? item.split('|')[0] : '');
        const explicitDuration = isObj && item.duration != null ? item.duration : (typeof item === 'string' && item.includes('|') ? Number(item.split('|')[1]) || null : null);
        const autoFill = item?.autoFill !== false;
        const bufPromise = autoFill ? Toolkit.fetchBuffer(rawUrl) : Promise.resolve(Buffer.alloc(0));
        const file_length = isObj && item.file_length != null ? item.file_length : autoFill ? bufPromise.then(b => b?.length ?? 0) : 0;
        const duration = explicitDuration != null ? explicitDuration : autoFill ? bufPromise.then(b => Toolkit.getMp4DurationSync(b)) : 0;
        const thumbnail = isObj && item.thumbnail
          ? bufPromise.then(() => {
              const tb = item.thumbnail;
              const tbBuf = Buffer.isBuffer(tb) ? tb : null;
              if (tbBuf) return sharp(tbBuf).resize(300, 300, { fit: 'cover' }).png().toBuffer().then(b => b.toString('base64'));
              return Toolkit.fetchBuffer(tb).then(b => sharp(b).resize(300, 300, { fit: 'cover' }).png().toBuffer()).then(b => b.toString('base64'));
            })
          : autoFill
          ? bufPromise.then(b => Toolkit.getMp4Preview(b, { time: 0, result: 'base64', resize: true, width: 300, height: 300 }))
          : null;
        sections.push(newLayout('Single', {
          media: {
            url: rawUrl,
            mime_type: isObj ? (item.mime_type ?? 'video/mp4') : 'video/mp4',
            file_length,
            duration,
          },
          imagine_type: 'ANIMATE',
          status: { status: 'READY' },
          thumbnail: { raw_media: thumbnail },
          __typename: 'GenAIImaginePrimitive',
        }));
      });
    }

    if (rich.tip !== undefined) {
      const tipText = String(rich.tip);
      submessages.push({ messageType: 2, messageText: tipText });
      sections.push(newLayout('Single', { text: tipText, __typename: 'GenAIMetadataTextPrimitive' }));
    }

    if (rich.code) {
      const language = rich.code.language ?? rich.code.lang ?? 'javascript';
      const code = rich.code.code ?? rich.code.content ?? '';
      const tokenized = tokenizer(code, language);
      submessages.push({ messageType: 5, codeMetadata: { codeLanguage: language, codeBlocks: tokenized.codeBlock } });
      sections.push(newLayout('Single', { language, code_blocks: tokenized.unified_codeBlock, __typename: 'GenAICodeUXPrimitive' }));
    }

    if (rich.table) {
      const tableOpts = typeof rich.table === 'object' && !Array.isArray(rich.table) ? rich.table : { data: rich.table };
      const data = tableOpts.data ?? rich.table;
      const meta = toTableMetadata(data, {
        hyperlink: tableOpts.hyperlink ?? false,
        citation: tableOpts.citation ?? false,
        latex: tableOpts.latex ?? false,
      });
      submessages.push({ messageType: 4, tableMetadata: { title: meta.title, rows: meta.rows } });
      const primitive = { rows: meta.unified_rows, __typename: 'GenATableUXPrimitive' };
      if (meta.markdown_cells) primitive.markdown_cells = meta.markdown_cells;
      sections.push(newLayout('Single', primitive));
    }

    if (rich.post || rich.posts) {
      const raw = rich.post || rich.posts;
      const items = Array.isArray(raw) ? raw : [raw];
      submessages.push({ messageType: 2, messageText: '[ CANNOT_LOAD_POST - NIXEL ]' });
      const mapped = await Promise.all(items.map(async p => ({
        title: p.title ?? '',
        subtitle: p.subtitle ?? '',
        username: p.username ?? '',
        profile_picture_url: await Toolkit.resolveMedia(p.profile_picture_url ?? p.profile_url ?? '', 'url'),
        is_verified: !!(p.is_verified || p.verified),
        thumbnail_url: await Toolkit.resolveMedia(p.thumbnail_url ?? p.thumbnail ?? '', 'url'),
        post_caption: p.post_caption ?? p.caption ?? '',
        source_app: p.source_app ?? p.source ?? '',
        post_url: p.post_url ?? p.url ?? '',
        post_deeplink: p.post_deeplink ?? p.deeplink ?? p.post_url ?? p.url ?? '',
        footer_label: p.footer_label ?? p.footer ?? '',
        footer_icon: await Toolkit.resolveMedia(p.footer_icon ?? p.icon ?? p.profile_picture_url ?? p.profile_url ?? '', 'url'),
        likes_count: p.likes_count ?? p.like ?? 0,
        comments_count: p.comments_count ?? p.comment ?? 0,
        shares_count: p.shares_count ?? p.share ?? 0,
        orientation: p.orientation ?? 'LANDSCAPE',
        post_type: p.post_type ?? 'PHOTO',
        is_carousel: !!(p.is_carousel),
        __typename: 'GenAIPostPrimitive',
      })));
      sections.push(newLayout(items.length > 1 ? 'HScroll' : 'Single', items.length > 1 ? mapped : mapped[0]));
    }

    if (rich.reels || rich.reel) {
      const raw = rich.reels ?? rich.reel;
      const items = Array.isArray(raw) ? raw : [raw];
      submessages.push({
        messageType: 9,
        contentItemsMetadata: {
          contentType: 1,
          itemsMetadata: items.map(item => ({
            reelItem: {
              title: item.username ?? item.title ?? '',
              profileIconUrl: item._resolvedAvatar ?? item.profileIconUrl ?? '',
              thumbnailUrl: item._resolvedThumb ?? item.thumbnailUrl ?? '',
              videoUrl: item._resolvedVideo ?? item.videoUrl ?? '',
            }
          }))
        }
      });
      items.forEach((item, idx) => richResponseSources.push({
        provider: 'UNKNOWN',
        thumbnailCDNURL: item.thumbnailUrl ?? '',
        sourceProviderURL: item.videoUrl ?? '',
        sourceQuery: '',
        faviconCDNURL: item.profileIconUrl ?? '',
        citationNumber: idx + 1,
        sourceTitle: item.username ?? item.title ?? '',
      }));
      sections.push(newLayout('HScroll', items.map(item => ({
        reels_url: item.videoUrl ?? '',
        thumbnail_url: item.thumbnailUrl ?? '',
        creator: item.username ?? item.title ?? '',
        avatar_url: item.profileIconUrl ?? '',
        reels_title: item.reels_title ?? item.title ?? '',
        likes_count: item.likes_count ?? item.like ?? 0,
        shares_count: item.shares_count ?? item.share ?? 0,
        view_count: item.view_count ?? item.view ?? 0,
        reel_source: item.reel_source ?? item.source ?? 'IG',
        is_verified: !!(item.is_verified || item.verified),
        __typename: 'GenAIReelPrimitive',
      }))));
    }

    if (rich.sources || rich.source) {
      const raw = rich.sources ?? rich.source;
      const sourceArr = Array.isArray(raw) ? raw : [raw];
      const resolved = await Promise.all(sourceArr.map(async s => {
        if (typeof s === 'object' && !Array.isArray(s)) {
          return {
            ...s,
            favicon: s.favicon ? { ...s.favicon, url: await Toolkit.resolveMedia(s.favicon.url, 'url') } : s.favicon
          };
        }
        return {
          source_type: 'THIRD_PARTY',
          source_display_name: s[2] ?? '',
          source_subtitle: 'AI',
          source_url: s[1] ?? '',
          favicon: { url: await Toolkit.resolveMedia(s[0] ?? '', 'url'), mime_type: 'image/jpeg', width: 16, height: 16 }
        };
      }));
      sections.push(newLayout('Single', { sources: resolved, __typename: 'GenAISearchResultPrimitive' }));
    }

    if (rich.suggestions || rich.suggest) {
      const raw = rich.suggestions ?? rich.suggest;
      const opts = typeof raw === 'object' && !Array.isArray(raw) && raw !== null ? raw : { items: raw };
      const items = Array.isArray(opts.items ?? raw) ? (opts.items ?? raw) : [opts.items ?? raw];
      const suggest = items.map(text => ({
        prompt_text: String(text),
        prompt_type: 'SUGGESTED_PROMPT',
        __typename: 'GenAIFollowUpSuggestionPillPrimitive'
      }));
      let layout;
      if (opts.layout) {
        layout = opts.layout;
      } else if (suggest.length === 1) {
        layout = 'Single';
      } else if (opts.scroll === false) {
        layout = 'ActionRow';
      } else {
        layout = 'HScroll';
      }
      sections.push(newLayout(layout, suggest.length === 1 ? suggest[0] : suggest));
    }

    if (rich.widget) {
      const w = rich.widget;
      sections.push(newLayout('Single', {
        title: w.title ?? '',
        sections: w.sections ?? [],
        actions: (w.actions ?? []).map(a => ({
          label: a.label ?? '',
          kind: a.kind ?? 'OTHER',
          state: a.state ?? 'PENDING',
          id: a.id ?? ''
        })),
        __typename: 'GenAIWidgetCardPrimitive'
      }));
    }

    if (rich.footerAction || rich.footerBtn) {
      const fa = rich.footerAction || rich.footerBtn;
      sections.push(newLayout('Single', {
        action: {
          text: fa.text ?? '',
          url: fa.url ?? ''
        },
        __typename: 'GenAIFooterActionPrimitive'
      }));
    }

    if (rich.footer) {
      sections.push(newLayout('Single', { text: rich.footer, __typename: 'GenAIMetadataTextPrimitive' }));
    }

    if (rich.progress) {
      const p = typeof rich.progress === 'string' ? { title: rich.progress } : rich.progress;
      if (p.text) {
        submessages.push({ messageType: 2, messageText: String(p.text) });
      }
      sections.push(newLayout('Single', {
        __typename: 'GenAIBotProgressStatusPrimitive',
        icon: p.icon ?? null,
        is_in_progress: p.isInProgress ?? true,
        meta_search_apps: null,
        target_secondary_screen_id: null,
        target_secondary_screen_tab_id: null,
        title: p.title ?? 'Processing...'
      }));
    }

    if (rich.game) {
      const gameTitle = typeof rich.game === 'string' ? rich.game : (rich.game.title ?? 'Click to Play');
      const tabHeader = typeof rich.game === 'object' && rich.game.tab ? rich.game.tab : 'Widget';
      const screenTitle = typeof rich.game === 'object' && rich.game.screen ? rich.game.screen : 'Preview';
      const gameHtml = rich.html || (typeof rich.game === 'object' ? rich.game.html : '') || '';

      sections.push(newLayout('Single', {
        __typename: 'GenAIBotProgressStatusPrimitive',
        title: gameTitle,
        is_in_progress: true
      }));

      embeddedScreens.push({
        title: screenTitle,
        content: [
          {
            __typename: 'FOAIDNixelButtonSheets',
            tabs: [
              {
                id: 'tab_0',
                tab_header: tabHeader,
                sections: [
                  newLayout('Single', {
                    payload: gameHtml,
                    url: 'https://example.com',
                    trusted_sources: ['example.com'],
                    __typename: 'GenAIaeacdsnwHtmlPrimitive'
                  })
                ],
                step_entries: []
              }
            ]
          }
        ]
      });
    } else if (rich.html) {
      sections.push(newLayout('Single', {
        payload: rich.html,
        trusted_sources: rich.trustedSources ?? ['nixel.dev'],
        __typename: 'GenAIaeacdsnwHtmlPrimitive'
      }));
    }

    if (rich.text) {
      const input = typeof rich.text === 'string' ? rich.text : String(rich.text);
      const { text: extractedText, inline_entities } = extractIE(input);
      submessages.push({ messageType: 2, messageText: extractedText });
      sections.push(newLayout('Single', {
        text: extractedText,
        ...(inline_entities.length && { inline_entities }),
        __typename: 'GenAIMarkdownTextUXPrimitive'
      }));
    }

    if (rich.customSections && Array.isArray(rich.customSections)) {
      sections.push(...rich.customSections);
    }

    const generateVerificationMetadata = () => {
      const signatureMaterial = Buffer.from(
        'NIXEL.MessageBuilderV4.7-VerificationSignature.Metadata'
      );
      const certificateMaterial = Buffer.from(
        'NIXEL.MessageBuilderV4.7-CertificateChain.Metadata'
      );
      const signature = Buffer.concat([
        signatureMaterial,
        randomBytes(64 - signatureMaterial.length)
      ]).toString('base64');
      const certificateChain = [
        Buffer.concat([certificateMaterial, randomBytes(684 - certificateMaterial.length)]).toString('base64'),
        Buffer.concat([certificateMaterial, randomBytes(892 - certificateMaterial.length)]).toString('base64')
      ];
      return {
        proofs: [
          {
            version: 1,
            useCase: 1,
            signature,
            certificateChain
          }
        ]
      };
    };

    const [resolvedSections, resolvedSubmessages] = await Promise.all([
      Toolkit.waitAllPromises(sections),
      Toolkit.waitAllPromises(submessages)
    ]);

    const unifiedJsonObj = { response_id: randomUUID(), sections: resolvedSections };
    if (embeddedScreens.length) {
      unifiedJsonObj.embedded_screens = embeddedScreens;
    }
    const unifiedJsonStr = JSON.stringify(unifiedJsonObj);
    const unifiedDataBase64 = Buffer.from(unifiedJsonStr).toString('base64');

    m = {
      messageContextInfo: {
        deviceListMetadata: {},
        deviceListMetadataVersion: 2,
        botMetadata: {
          messageDisclaimerText: rich.title ?? '',
          verificationMetadata: generateVerificationMetadata(),
          botResponseId: randomUUID(),
          richResponseSourcesMetadata: { sources: richResponseSources }
        }
      },
      botForwardedMessage: {
        message: {
          richResponseMessage: {
            messageType: 1,
            submessages: resolvedSubmessages,
            unifiedResponse: {
              data: unifiedDataBase64
            },
            contextInfo: {
              forwardingScore: 1,
              isForwarded: true,
              forwardedAiBotMessageInfo: { botJid: '867051314767696@bot' },
              forwardOrigin: 4,
              ...(rich.contextInfo ?? {})
            }
          }
        }
      }
    };

  } else if (hasNonNullishProperty(message, "stickerPackMessage")) {
    const sp = message.stickerPackMessage;

    const encryptStickerPack = async (plainBuffer) => {
      const { createHmac, createCipheriv, randomBytes: rb, hkdf: hkdfCb } = await import('crypto');
      const { promisify } = await import('util');
      const hkdf = promisify(hkdfCb);
      const mediaKey = rb(32);
      const expanded = await hkdf('sha256', mediaKey, Buffer.alloc(0), Buffer.from('WhatsApp Sticker Pack Keys'), 112);
      const keyExpanded = Buffer.from(expanded);
      const iv = keyExpanded.slice(0, 16);
      const key = keyExpanded.slice(16, 48);
      const macKey = keyExpanded.slice(48, 80);
      const padLen = 16 - (plainBuffer.length % 16);
      const padded = Buffer.concat([plainBuffer, Buffer.alloc(padLen, padLen)]);
      const cipher = createCipheriv('aes-256-cbc', key, iv);
      cipher.setAutoPadding(false);
      const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
      const mac = createHmac('sha256', macKey).update(Buffer.concat([iv, encrypted])).digest().slice(0, 10);
      const encFull = Buffer.concat([encrypted, mac]);
      const { createHash } = await import('crypto');
      const fileSha256 = createHash('sha256').update(plainBuffer).digest();
      const fileEncSha256 = createHash('sha256').update(encFull).digest();
      return { encFull, mediaKey, fileSha256, fileEncSha256 };
    };

    const toAnimatedWebp = async (buffer) => {
      const { join } = await import('path');
      const { tmpdir } = await import('os');
      const { writeFile: wf, readFile: rf, unlink: ul } = await import('fs/promises');
      try {
        const result = await sharp(buffer, { animated: true })
          .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
          .webp({ quality: 60, loop: 0 })
          .toBuffer();
        if (result && result.length > 0) return result;
      } catch {}
      const ext = (buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) ? 'mp4' : 'mp4';
      const ts = Date.now();
      const tmpIn = join(tmpdir(), `stc_in_${ts}.${ext}`);
      const tmpOut = join(tmpdir(), `stc_out_${ts}.webp`);
      await wf(tmpIn, buffer);
      try {
        await new Promise((resolve, reject) => {
          ffmpeg(tmpIn)
            .outputOptions([
              '-vcodec', 'libwebp',
              '-vf', 'fps=15,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black@0,format=rgba',
              '-loop', '0',
              '-compression_level', '6',
              '-quality', '60',
              '-preset', 'icon',
              '-an',
              '-t', '5',
            ])
            .toFormat('webp')
            .on('error', reject)
            .on('end', resolve)
            .save(tmpOut);
        });
        return await rf(tmpOut);
      } finally {
        await ul(tmpIn).catch(() => {});
        await ul(tmpOut).catch(() => {});
      }
    };

    const toStaticWebp = async (buffer) => {
      return sharp(buffer)
        .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .webp({ quality: 100 })
        .toBuffer();
    };

    if (sp.mediaKey && sp.directPath) {
      m = { stickerPackMessage: sp };
    } else {
      const { default: AdmZip } = await import('adm-zip');
      const { join } = await import('path');
      const { tmpdir } = await import('os');
      const { writeFile: wf, unlink: ul } = await import('fs/promises');
      const { randomUUID, createHash } = await import('crypto');

      const packId = sp.stickerPackId ?? randomUUID();
      const zip = new AdmZip();
      const stickers = [];
      const rawStickers = sp.stickers ?? [];

      for (const stiker of rawStickers) {
        let buffer;
        if (Buffer.isBuffer(stiker)) {
          buffer = stiker;
        } else if (stiker.buffer) {
          buffer = stiker.buffer;
        } else if (stiker.imageUrl || stiker.url) {
          const res = await fetch(stiker.imageUrl ?? stiker.url);
          buffer = Buffer.from(await res.arrayBuffer());
        } else continue;

        const isAnimated = stiker.isAnimated ?? false;
        let webp;
        try {
          webp = isAnimated ? await toAnimatedWebp(buffer) : await toStaticWebp(buffer);
        } catch {
          webp = await toStaticWebp(buffer);
        }

        const fileName = `sticker_${createHash('md5').update(webp).digest('hex').slice(0, 12)}.webp`;
        zip.addFile(fileName, webp);
        stickers.push({
          fileName: String(fileName),
          isAnimated: Boolean(isAnimated),
          isLottie: false,
          mimetype: 'image/webp',
          emojis: stiker.emojis ?? ['✨'],
        });
      }

      let trayBuffer;
      if (sp.trayIcon) {
        trayBuffer = Buffer.isBuffer(sp.trayIcon)
          ? sp.trayIcon
          : Buffer.from(await (await fetch(sp.trayIcon)).arrayBuffer());
      } else if (stickers.length > 0) {
        const firstEntry = zip.getEntries()[0];
        trayBuffer = firstEntry ? firstEntry.getData() : Buffer.alloc(0);
      }
      if (trayBuffer && trayBuffer.length) {
        trayBuffer = await sharp(trayBuffer).resize(96, 96, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
      }

      const trayName = `${packId}.png`;
      if (trayBuffer?.length) zip.addFile(trayName, trayBuffer);

      const zipBuffer = zip.toBuffer();
      const { encFull, mediaKey, fileSha256, fileEncSha256 } = await encryptStickerPack(zipBuffer);

      const tmpPath = join(tmpdir(), `stickerpack_${Date.now()}.zip`);
      await wf(tmpPath, encFull);

      const upload = await options.upload(tmpPath, {
        mediaType: 'sticker',
        fileEncSha256B64: fileEncSha256.toString('base64'),
      }).finally(() => ul(tmpPath).catch(() => {}));

      m = {
        stickerPackMessage: {
          stickerPackId: String(packId),
          name: String(sp.name ?? 'Sticker Pack'),
          publisher: String(sp.publisher ?? sp.author ?? 'Unknown'),
          stickers,
          mediaKey,
          directPath: String(upload?.directPath ?? ''),
          fileSha256,
          fileEncSha256,
          fileLength: zipBuffer.length,
          mediaKeyTimestamp: unixTimestampSeconds(),
          trayIconFileName: String(trayName),
          thumbnailDirectPath: String(upload?.directPath ?? ''),
          thumbnailSha256: fileSha256,
          thumbnailEncSha256: fileEncSha256,
          thumbnailHeight: 96,
          thumbnailWidth: 96,
          stickerPackSize: zipBuffer.length,
          stickerPackOrigin: sp.stickerPackOrigin ?? 1,
        }
      };
    }

  } else {
    m = await prepareWAMessageMedia(message, options);
  }

  if (hasOptionalProperty(message, "ephemeral")) {
    m = { ephemeralMessage: { message: m } };
  }

  if ("viewOnce" in message && !!message.viewOnce) {
    m = { viewOnceMessage: { message: m } };
  }

  if (hasOptionalProperty(message, "mentions") && message.mentions?.length) {
    const messageType = Object.keys(m)[0];
    const key = m[messageType];
    if ("contextInfo" in key && !!key.contextInfo) {
      key.contextInfo.mentionedJid = message.mentions;
    } else if (key) {
      key.contextInfo = { mentionedJid: message.mentions };
    }
  }

  if (hasOptionalProperty(message, "edit")) {
    m = {
      protocolMessage: {
        key: message.edit,
        editedMessage: m,
        timestampMs: Date.now(),
        type: WAProto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
      },
    };
  }

  if (hasOptionalProperty(message, "contextInfo") && !!message.contextInfo) {
    const messageType = Object.keys(m)[0];
    const key = m[messageType];
    if ("contextInfo" in key && !!key.contextInfo) {
      key.contextInfo = { ...key.contextInfo, ...message.contextInfo };
    } else if (key) {
      key.contextInfo = message.contextInfo;
    }
  }

  return WAProto.Message.create(m);
};

export const generateWAMessageFromContent = (jid, message, options) => {
  if (!options.timestamp) {
    options.timestamp = new Date();
  }
  const innerMessage = normalizeMessageContent(message);
  const key = getContentType(innerMessage);
  const timestamp = unixTimestampSeconds(options.timestamp);
  const threadId = [];
  const { quoted, userJid } = options;

  if (quoted && !isJidNewsletter(jid)) {
    const participant = quoted.key.fromMe
      ? userJid
      : quoted.participant || quoted.key.participant || quoted.key.remoteJid;
    let quotedMsg = normalizeMessageContent(quoted.message);
    const msgType = getContentType(quotedMsg);
    quotedMsg = proto.Message.fromObject({ [msgType]: quotedMsg[msgType] });
    const quotedContent = quotedMsg[msgType];
    if (typeof quotedContent === "object" && quotedContent && "contextInfo" in quotedContent) {
      delete quotedContent.contextInfo;
    }
    let requestPayment;
    if (key === "requestPaymentMessage") {
      if (innerMessage?.requestPaymentMessage?.noteMessage?.extendedTextMessage) {
        requestPayment = innerMessage.requestPaymentMessage.noteMessage.extendedTextMessage;
      } else if (innerMessage?.requestPaymentMessage?.noteMessage?.stickerMessage) {
        requestPayment = innerMessage.requestPaymentMessage.noteMessage.stickerMessage;
      }
    }
    const contextInfo =
      (key === "requestPaymentMessage"
        ? requestPayment?.contextInfo
        : innerMessage[key]?.contextInfo) || {};
    contextInfo.participant = jidNormalizedUser(participant);
    contextInfo.stanzaId = quoted.key.id;
    contextInfo.quotedMessage = quotedMsg;
    if (jid !== quoted.key.remoteJid) {
      contextInfo.remoteJid = quoted.key.remoteJid;
    }
    if (contextInfo.quotedMessage) {
      contextInfo.quotedType = proto.ContextInfo.QuotedType.EXPLICIT;
    }
    if (contextInfo.quotedMessage && isJidGroup(jid)) {
      threadId.push({
        threadType: proto.ThreadID.ThreadType.VIEW_REPLIES,
        threadKey: {
          remoteJid: quoted?.key?.remoteJid,
          fromMe: quoted?.key?.fromMe,
          id: generateMessageID(),
          ...(quoted?.key?.fromMe ? {} : { participant: quoted?.key?.participant }),
        },
      });
    }
    if (key === "requestPaymentMessage" && requestPayment) {
      requestPayment.contextInfo = contextInfo;
    } else if (key === 'botForwardedMessage') {
      const richCtx = innerMessage[key]?.message?.richResponseMessage?.contextInfo ?? {};
      innerMessage[key].message.richResponseMessage.contextInfo = {
        ...richCtx,
        stanzaId: contextInfo.stanzaId,
        participant: contextInfo.participant,
        quotedMessage: contextInfo.quotedMessage,
        ...(contextInfo.remoteJid ? { remoteJid: contextInfo.remoteJid } : {}),
      };
    } else {
      innerMessage[key].contextInfo = contextInfo;
    }
  }

    if (key !== "protocolMessage" && key !== "ephemeralMessage" && key !== "botForwardedMessage" && !isJidNewsletter(jid)) {
    message.messageContextInfo = {
      threadId: threadId.length > 0 ? threadId : [],
      messageSecret: randomBytes(32),
      ...message.messageContextInfo,
    };
    innerMessage[key].contextInfo = {
      ...(innerMessage[key].contextInfo || {}),
      expiration: options.ephemeralExpiration ? options.ephemeralExpiration : 0,
    };
  }

  message = WAProto.Message.fromObject(message);
  const messageJSON = {
    key: {
      remoteJid: jid,
      fromMe: true,
      id: options?.messageId || generateMessageIDV2(),
    },
    message: message,
    messageTimestamp: timestamp,
    messageStubParameters: [],
    participant: isJidGroup(jid) || isJidStatusBroadcast(jid) ? userJid : undefined,
    status: WAMessageStatus.PENDING,
  };
  return WAProto.WebMessageInfo.fromObject(messageJSON);
};

export const generateWAMessage = async (jid, content, options) => {
  options.logger = options?.logger?.child({ msgId: options.messageId });
  return generateWAMessageFromContent(
    jid,
    await generateWAMessageContent(content, {
      newsletter: isJidNewsletter(jid),
      ...options,
      jid,
    }),
    options,
  );
};

export const getContentType = (content) => {
  if (content) {
    const keys = Object.keys(content);
    const key = keys.find(
      (k) =>
        (k === "conversation" ||
          k.endsWith("Message") ||
          k.endsWith("V2") ||
          k.endsWith("V3") ||
          k.endsWith("V4")) &&
        k !== "senderKeyDistributionMessage" &&
        k !== "messageContextInfo"
    );
    return key;
  }
};

export const normalizeMessageContent = (content) => {
  if (!content) {
    return undefined;
  }
  for (let i = 0; i < 5; i++) {
    const inner = getFutureProofMessage(content);
    if (!inner) {
      break;
    }
    content = inner.message;
  }
  return content;

  function getFutureProofMessage(message) {
    return (
      message?.editedMessage ||
      message?.statusAddYours ||
      message?.botTaskMessage ||
      message?.eventCoverImage ||
      message?.questionMessage ||
      message?.viewOnceMessage ||
      message?.botInvokeMessage ||
      message?.ephemeralMessage ||
      message?.limitSharingMessage ||
      message?.viewOnceMessageV2 ||
      message?.lottieStickerMessage ||
      message?.questionReplyMessage ||
      message?.botForwardedMessage ||
      message?.statusMentionMessage ||
      message?.pollCreationMessageV4 ||
      message?.associatedChildMessage ||
      message?.groupMentionedMessage ||
      message?.groupStatusMentionMessage ||
      message?.viewOnceMessageV2Extension ||
      message?.documentWithCaptionMessage ||
      message?.pollCreationOptionImageMessage
    );
  }
};

export const extractMessageContent = (content) => {
  const extractFromTemplateMessage = (msg) => {
    const header = typeof msg.header === "object" && msg.header !== null;
    if (header ? msg.header?.imageMessage : msg.imageMessage) {
      return { imageMessage: header ? msg.header.imageMessage : msg.imageMessage };
    } else if (header ? msg.header?.documentMessage : msg.documentMessage) {
      return { documentMessage: header ? msg.header.documentMessage : msg.documentMessage };
    } else if (header ? msg.header?.videoMessage : msg.videoMessage) {
      return { videoMessage: header ? msg.header.videoMessage : msg.videoMessage };
    } else if (header ? msg.header?.locationMessage : msg.locationMessage) {
      return { locationMessage: header ? msg.header.locationMessage : msg.locationMessage };
    } else if (header ? msg.header?.productMessage : msg.productMessage) {
      return { productMessage: header ? msg.header.productMessage : msg.productMessage };
    } else {
      return {
        conversation:
          "contentText" in msg
            ? msg.contentText
            : "hydratedContentText" in msg
              ? msg.hydratedContentText
              : "body" in msg
                ? msg.body.text
                : "",
      };
    }
  };
  content = normalizeMessageContent(content);
  if (content?.buttonsMessage) {
    return extractFromTemplateMessage(content.buttonsMessage);
  }
  if (content?.interactiveMessage) {
    return extractFromTemplateMessage(content.interactiveMessage);
  }
  if (content?.templateMessage?.interactiveMessageTemplate) {
    return extractFromTemplateMessage(content?.templateMessage?.interactiveMessageTemplate);
  }
  if (content?.templateMessage?.hydratedFourRowTemplate) {
    return extractFromTemplateMessage(content?.templateMessage?.hydratedFourRowTemplate);
  }
  if (content?.templateMessage?.hydratedTemplate) {
    return extractFromTemplateMessage(content?.templateMessage?.hydratedTemplate);
  }
  if (content?.templateMessage?.fourRowTemplate) {
    return extractFromTemplateMessage(content?.templateMessage?.fourRowTemplate);
  }
  return content;
};

export const getDevice = (id) =>
  /^3A.{18}$/.test(id)
    ? "ios"
    : /^3E.{20}$/.test(id)
      ? "web"
      : /^(.{21}|.{32})$/.test(id)
        ? "android"
        : /^(3F|.{18}$)/.test(id)
          ? "desktop"
          : "baileys";

export const updateMessageWithReceipt = (msg, receipt) => {
  msg.userReceipt = msg.userReceipt || [];
  const recp = msg.userReceipt.find((m) => m.userJid === receipt.userJid);
  if (recp) {
    Object.assign(recp, receipt);
  } else {
    msg.userReceipt.push(receipt);
  }
};

export const updateMessageWithReaction = (msg, reaction) => {
  const authorID = getKeyAuthor(reaction.key);
  const reactions = (msg.reactions || []).filter((r) => getKeyAuthor(r.key) !== authorID);
  reaction.text = reaction.text || "";
  reactions.push(reaction);
  msg.reactions = reactions;
};

export const updateMessageWithPollUpdate = (msg, update) => {
  const authorID = getKeyAuthor(update.pollUpdateMessageKey);
  const votes = (msg.pollUpdates || []).filter(
    (r) => getKeyAuthor(r.pollUpdateMessageKey) !== authorID
  );
  if (update.vote?.selectedOptions?.length) {
    votes.push(update);
  }
  msg.pollUpdates = votes;
};

export const updateMessageWithEventResponse = (msg, update) => {
  const authorID = getKeyAuthor(update.eventResponseMessageKey);
  const responses = (msg.eventResponses || []).filter(
    (r) => getKeyAuthor(r.eventResponseMessageKey) !== authorID
  );
  responses.push(update);
  msg.eventResponses = responses;
};

export function getAggregateVotesInPollMessage({ message, pollUpdates }, meId) {
  message = normalizeMessageContent(message);
  const opts =
    message?.pollCreationMessage?.options ||
    message?.pollCreationMessageV2?.options ||
    message?.pollCreationMessageV3?.options ||
    [];
  const voteHashMap = opts.reduce((acc, opt) => {
    const hash = sha256(Buffer.from(opt.optionName || "")).toString();
    acc[hash] = { name: opt.optionName || "", voters: [] };
    return acc;
  }, {});
  for (const update of pollUpdates || []) {
    const { vote } = update;
    if (!vote) continue;
    for (const option of vote.selectedOptions || []) {
      const hash = option.toString();
      let data = voteHashMap[hash];
      if (!data) {
        voteHashMap[hash] = { name: "Unknown", voters: [] };
        data = voteHashMap[hash];
      }
      voteHashMap[hash].voters.push(getKeyAuthor(update.pollUpdateMessageKey, meId));
    }
  }
  return Object.values(voteHashMap);
}

export function getAggregateResponsesInEventMessage({ eventResponses }, meId) {
  const responseTypes = ["GOING", "NOT_GOING", "MAYBE"];
  const responseMap = {};
  for (const type of responseTypes) {
    responseMap[type] = { response: type, responders: [] };
  }
  for (const update of eventResponses || []) {
    const { response } = update.response || 0;
    const responseType = proto.Message.EventResponseMessage.EventResponseType[response];
    if (responseType !== "UNKNOWN" && responseMap[responseType]) {
      responseMap[responseType].responders.push(getKeyAuthor(update.eventResponseMessageKey, meId));
    }
  }
  return Object.values(responseMap);
}

export const aggregateMessageKeysNotFromMe = (keys) => {
  const keyMap = {};
  for (const { remoteJid, id, participant, fromMe } of keys) {
    if (!fromMe) {
      const uqKey = `${remoteJid}:${participant || ""}`;
      if (!keyMap[uqKey]) {
        keyMap[uqKey] = { jid: remoteJid, participant: participant, messageIds: [] };
      }
      keyMap[uqKey].messageIds.push(id);
    }
  }
  return Object.values(keyMap);
};

const REUPLOAD_REQUIRED_STATUS = [410, 404];

export const downloadMediaMessage = async (message, type, options, ctx) => {
  const result = await downloadMsg().catch(async (error) => {
    if (ctx && typeof error?.status === "number" && REUPLOAD_REQUIRED_STATUS.includes(error.status)) {
      ctx.logger.info({ key: message.key }, "sending reupload media request...");
      message = await ctx.reuploadRequest(message);
      const result = await downloadMsg();
      return result;
    }
    throw error;
  });
  return result;

  async function downloadMsg() {
    const mContent = extractMessageContent(message.message);
    if (!mContent) {
      throw new Boom("No message present", { statusCode: 400, data: message });
    }
    const contentType = getContentType(mContent);
    let mediaType = contentType?.replace("Message", "");
    const media =
      contentType === "productMessage"
        ? mContent[contentType]?.product?.productImage
        : mContent[contentType];
    if (!media || typeof media !== "object" || (!("url" in media) && !("thumbnailDirectPath" in media))) {
      throw new Boom(`"${contentType}" message is not a media message`);
    }
    let download;
    if ("thumbnailDirectPath" in media && !("url" in media)) {
      download = { directPath: media.thumbnailDirectPath, mediaKey: media.mediaKey };
      mediaType = "thumbnail-link";
    } else {
      download = media;
    }
    const stream = await downloadContentFromMessage(download, mediaType, options);
    if (type === "buffer") {
      const bufferArray = [];
      for await (const chunk of stream) {
        bufferArray.push(chunk);
      }
      return Buffer.concat(bufferArray);
    }
    return stream;
  }
};

export const assertMediaContent = (content) => {
  content = extractMessageContent(content);
  const mediaContent =
    content?.documentMessage ||
    content?.imageMessage ||
    content?.videoMessage ||
    content?.audioMessage ||
    content?.stickerMessage;
  if (!mediaContent) {
    throw new Boom("given message is not a media message", { statusCode: 400, data: content });
  }
  return mediaContent;
};
