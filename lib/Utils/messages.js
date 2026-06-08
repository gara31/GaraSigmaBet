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
} from "./messages-media.js";
// ─── Toolkit ────────────────────────────────────────────────────────────────

export const Toolkit = {
  /** Resize an image buffer using sharp */
  async resize(input, width, height) {
    const buf = Buffer.isBuffer(input) ? input : await Toolkit.fetchBuffer(input);
    return sharp(buf).resize(width, height).jpeg().toBuffer();
  },

  /** Fetch a URL and return a Buffer */
  async fetchBuffer(url, { silent = true } = {}) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (!silent) throw err;
      return null;
    }
  },

  /** Upload a buffer or URL to WA CDN and return a hosted URL */
  async toUrl(input, options = {}) {
    const buf = Buffer.isBuffer(input) ? input : await Toolkit.fetchBuffer(input);
    if (!buf) return null;
    if (options.upload) return options.upload(buf);
    return input;
  },

  /**
   * Smart multi-format media resolver: URL / Buffer / base64 → { url | buffer | base64 }
   * Returns a Promise that resolves to the desired format.
   */
  async resolveMedia(input, as = 'url') {
    if (!input) return null;
    if (as === 'buffer') {
      if (Buffer.isBuffer(input)) return input;
      if (typeof input === 'string' && input.startsWith('data:')) {
        return Buffer.from(input.split(',')[1], 'base64');
      }
      if (typeof input === 'string') return Toolkit.fetchBuffer(input);
    }
    if (as === 'base64') {
      const buf = await Toolkit.resolveMedia(input, 'buffer');
      return buf ? buf.toString('base64') : null;
    }
    // default: url
    if (typeof input === 'string' && !input.startsWith('data:')) return input;
    if (Buffer.isBuffer(input)) return `data:application/octet-stream;base64,${input.toString('base64')}`;
    if (typeof input === 'string' && input.startsWith('data:')) return input;
    return input;
  },

  /**
   * Deeply resolves all nested promises in any object/array tree
   */
  async waitAllPromises(obj) {
    if (obj instanceof Promise) return Toolkit.waitAllPromises(await obj);
    if (Array.isArray(obj)) return Promise.all(obj.map(Toolkit.waitAllPromises));
    if (obj !== null && typeof obj === 'object') {
      const entries = await Promise.all(
        Object.entries(obj).map(async ([k, v]) => [k, await Toolkit.waitAllPromises(v)])
      );
      return Object.fromEntries(entries);
    }
    return obj;
  },

  /**
   * Pure-JS MP4 atom parser — reads video duration from a Buffer (sync).
   * Used internally by getMp4Preview.
   */
  getMp4DurationSync(buf) {
    try {
      if (!Buffer.isBuffer(buf) || buf.length < 8) return 0;
      let offset = 0;
      while (offset < buf.length - 8) {
        const size = buf.readUInt32BE(offset);
        if (size < 8 || offset + size > buf.length) break;
        const type = buf.toString('ascii', offset + 4, offset + 8);
        if (type === 'moov') {
          let inner = offset + 8;
          while (inner < offset + size - 8) {
            const iSize = buf.readUInt32BE(inner);
            if (iSize < 8) break;
            const iType = buf.toString('ascii', inner + 4, inner + 8);
            if (iType === 'mvhd') {
              const version = buf[inner + 8];
              const timescale = version === 1 ? buf.readUInt32BE(inner + 28) : buf.readUInt32BE(inner + 20);
              const duration = version === 1
                ? Number(buf.readBigUInt64BE(inner + 32))
                : buf.readUInt32BE(inner + 24);
              return timescale ? duration / timescale : 0;
            }
            inner += iSize;
          }
        }
        offset += size;
      }
      return 0;
    } catch { return 0; }
  },

  /**
   * Pure-JS MP4 atom parser — reads video duration without ffmpeg.
   * Accepts URL string or Buffer.
   */
  async getMp4Duration(input) {
    try {
      const buf = Buffer.isBuffer(input) ? input : await Toolkit.fetchBuffer(input);
      if (!buf || !buf.length) return 0;
      return Toolkit.getMp4DurationSync(buf);
    } catch { return 0; }
  },

  /**
   * ffmpeg-powered frame extractor — generates video thumbnail buffer.
   * Accepts URL string or Buffer.
   */
  async getMp4Preview(input, { time, resize = true, width = 300, height = 300, silent = true } = {}) {
    // If input is a URL string, fetch as buffer first
    if (typeof input === 'string') {
      input = await Toolkit.fetchBuffer(input);
    }
    return new Promise((resolve) => {
      const fail = () => resolve(Buffer.alloc(0));
      try {
        if (!Buffer.isBuffer(input) || !input.length) return fail();
        const inputStream = new Readable({ read() {} });
        inputStream.push(input);
        inputStream.push(null);
        const outputStream = new PassThrough();
        const chunks = [];
        outputStream.on('data', (chunk) => chunks.push(chunk));
        outputStream.on('end', async () => {
          try {
            let output = Buffer.concat(chunks);
            if (!output.length) return fail();
            if (resize) output = await Toolkit.resize(output, width, height);
            resolve(output);
          } catch { fail(); }
        });
        outputStream.on('error', fail);
        // seek to 20% into video or max 10s
        const seekTime = time ?? Math.min(Toolkit.getMp4DurationSync(input) * 0.2, 10);
        ffmpeg(inputStream)
          .outputOptions([`-ss ${seekTime}`, '-vframes 1', '-vcodec png', '-f image2pipe'])
          .on('error', fail)
          .pipe(outputStream, { end: true });
      } catch { fail(); }
    });
  },

  /** Public wrapper around the module-level extractIE parser */
  extractIE(text, opts) {
    return extractIE(text, opts);
  }
};

// ─── extractIE (module-level) ────────────────────────────────────────────────

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
        // prefix '!' marks link as is_trusted: false
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

  // Build inline_entities directly inside parser (no longer rebuilt at callsites)
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

// ─── waitAllPromises (top-level alias) ──────────────────────────────────────
export const waitAllPromises = (obj) => Toolkit.waitAllPromises(obj);

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
/**
 * Uses a regex to test whether the string contains a URL, and returns the URL if it does.
 * @param text eg. hello https://google.com
 * @returns the URL, eg. https://google.com
 */
export const extractUrlFromText = (text) => text.match(URL_REGEX)?.[0];
export const generateLinkPreviewIfRequired = async (
  text,
  getUrlInfo,
  logger,
) => {
  const url = extractUrlFromText(text);
  if (!!getUrlInfo && url) {
    try {
      const urlInfo = await getUrlInfo(url);
      return urlInfo;
    } catch (error) {
      // ignore if fails
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
  const uploadData = {
    ...message,
    media: message[mediaType],
  };
  delete uploadData[mediaType];
  // check if cacheable + generate cache key
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
      // todo: add more support here
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
      await options.mediaCache.set(
        cacheableKey,
        WAProto.Message.encode(obj).finish(),
      );
    }
    return obj;
  }
  const requiresDurationComputation =
    mediaType === "audio" && typeof uploadData.seconds === "undefined";
  const requiresThumbnailComputation =
    (mediaType === "image" || mediaType === "video") &&
    typeof uploadData["jpegThumbnail"] === "undefined";
  const requiresWaveformProcessing =
    mediaType === "audio" && uploadData.ptt === true;
  const requiresAudioBackground =
    options.backgroundColor && mediaType === "audio" && uploadData.ptt === true;
  const requiresOriginalForSomeProcessing =
    requiresDurationComputation || requiresThumbnailComputation;
  const {
    mediaKey,
    encFilePath,
    originalFilePath,
    fileEncSha256,
    fileSha256,
    fileLength,
  } = await encryptedStream(
    uploadData.media,
    options.mediaTypeOverride || mediaType,
    {
      logger,
      saveOriginalFileIfRequired: requiresOriginalForSomeProcessing,
      opts: options.options,
    },
  );
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
          const { thumbnail, originalImageDimensions } =
            await generateThumbnail(originalFilePath, mediaType, options);
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
          uploadData.waveform = await getAudioWaveform(
            originalFilePath,
            logger,
          );
          logger?.debug("processed waveform");
        }
        if (requiresAudioBackground) {
          uploadData.backgroundArgb = await assertColor(
            options.backgroundColor,
          );
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
    await options.mediaCache.set(
      cacheableKey,
      WAProto.Message.encode(obj).finish(),
    );
  }
  return obj;
};
export const prepareDisappearingMessageSettingContent = (
  ephemeralExpiration,
) => {
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
/**
 * Generate forwarded message content like WA does
 * @param message the message to forward
 * @param options.forceForward will show the message as forwarded even if it is from you
 */
export const generateForwardMessageContent = (message, forceForward) => {
  let content = message.message;
  if (!content) {
    throw new Boom("no content in message", { statusCode: 400 });
  }
  // hacky copy
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
  var _a, _b;
  let m = {};
  if ("text" in message) {
    const extContent = { text: message.text };
    let urlInfo = message.linkPreview;
    if (typeof urlInfo === "undefined") {
      urlInfo = await generateLinkPreviewIfRequired(
        message.text,
        options.getUrlInfo,
        options.logger,
      );
    }
    if (urlInfo) {
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
    if (options.font) {
      extContent.font = options.font;
    }
    m.extendedTextMessage = extContent;
  } else if ("contacts" in message) {
    const contactLen = message.contacts.contacts.length;
    if (!contactLen) {
      throw new Boom("require atleast 1 contact", { statusCode: 400 });
    }
    if (contactLen === 1) {
      m.contactMessage = WAProto.Message.ContactMessage.create(
        message.contacts.contacts[0],
      );
    } else {
      m.contactsArrayMessage = WAProto.Message.ContactsArrayMessage.create(
        message.contacts,
      );
    }
  } else if ("location" in message) {
    m.locationMessage = WAProto.Message.LocationMessage.create(
      message.location,
    );
  } else if ("react" in message) {
    if (!message.react.senderTimestampMs) {
      message.react.senderTimestampMs = Date.now();
    }
    m.reactionMessage = WAProto.Message.ReactionMessage.create(message.react);
  } else if ("delete" in message) {
    m.protocolMessage = {
      key: message.delete,
      type: WAProto.Message.ProtocolMessage.Type.REVOKE,
    };
  } else if ("forward" in message) {
    m = generateForwardMessageContent(message.forward, message.force);
  } else if ("disappearingMessagesInChat" in message) {
    const exp =
      typeof message.disappearingMessagesInChat === "boolean"
        ? message.disappearingMessagesInChat
          ? WA_DEFAULT_EPHEMERAL
          : 0
        : message.disappearingMessagesInChat;
    m = prepareDisappearingMessageSettingContent(exp);
  } else if ("groupInvite" in message) {
    m.groupInviteMessage = {};
    m.groupInviteMessage.inviteCode = message.groupInvite.inviteCode;
    m.groupInviteMessage.inviteExpiration =
      message.groupInvite.inviteExpiration;
    m.groupInviteMessage.caption = message.groupInvite.text;
    m.groupInviteMessage.groupJid = message.groupInvite.jid;
    m.groupInviteMessage.groupName = message.groupInvite.subject;
    //TODO: use built-in interface and get disappearing mode info etc.
    //TODO: cache / use store!?
    if (options.getProfilePicUrl) {
      const pfpUrl = await options.getProfilePicUrl(
        message.groupInvite.jid,
        "preview",
      );
      if (pfpUrl) {
        const resp = await fetch(pfpUrl, {
          method: "GET",
          dispatcher: options?.options?.dispatcher,
        });
        if (resp.ok) {
          const buf = Buffer.from(await resp.arrayBuffer());
          m.groupInviteMessage.jpegThumbnail = buf;
        }
      }
    }
  } else if ("pin" in message) {
    m.pinInChatMessage = {};
    m.messageContextInfo = {};
    m.pinInChatMessage.key = message.pin;
    m.pinInChatMessage.type = message.type;
    m.pinInChatMessage.senderTimestampMs = Date.now();
    m.messageContextInfo.messageAddOnDurationInSecs =
      message.type === 1 ? message.time || 86400 : 0;
  } else if ("buttonReply" in message) {
    switch (message.type) {
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
    }
  } else if ("ptv" in message && message.ptv) {
    const { videoMessage } = await prepareWAMessageMedia(
      { video: message.video },
      options,
    );
    m.ptvMessage = videoMessage;
  } else if ("product" in message) {
    const { imageMessage } = await prepareWAMessageMedia(
      { image: message.product.productImage },
      options,
    );
    m.productMessage = WAProto.Message.ProductMessage.create({
      ...message,
      product: {
        ...message.product,
        productImage: imageMessage,
      },
    });
  } else if ("listReply" in message) {
    m.listResponseMessage = { ...message.listReply };
  } else if ("event" in message) {
    m.eventMessage = {};
    const startTime = Math.floor(message.event.startDate.getTime() / 1000);
    if (message.event.call && options.getCallLink) {
      const token = await options.getCallLink(message.event.call, {
        startTime,
      });
      m.eventMessage.joinLink =
        (message.event.call === "audio"
          ? CALL_AUDIO_PREFIX
          : CALL_VIDEO_PREFIX) + token;
    }
    m.messageContextInfo = {
      // encKey
      messageSecret: message.event.messageSecret || randomBytes(32),
    };
    m.eventMessage.name = message.event.name;
    m.eventMessage.description = message.event.description;
    m.eventMessage.startTime = startTime;
    m.eventMessage.endTime = message.event.endDate
      ? message.event.endDate.getTime() / 1000
      : undefined;
    m.eventMessage.isCanceled = message.event.isCancelled ?? false;
    m.eventMessage.extraGuestsAllowed = message.event.extraGuestsAllowed;
    m.eventMessage.isScheduleCall = message.event.isScheduleCall ?? false;
    m.eventMessage.location = message.event.location;
  } else if ("poll" in message) {
    (_a = message.poll).selectableCount || (_a.selectableCount = 0);
    (_b = message.poll).toAnnouncementGroup || (_b.toAnnouncementGroup = false);
    if (!Array.isArray(message.poll.values)) {
      throw new Boom("Invalid poll values", { statusCode: 400 });
    }
    if (
      message.poll.selectableCount < 0 ||
      message.poll.selectableCount > message.poll.values.length
    ) {
      throw new Boom(
        `poll.selectableCount in poll should be >= 0 and <= ${message.poll.values.length}`,
        {
          statusCode: 400,
        },
      );
    }
    m.messageContextInfo = {
      // encKey
      messageSecret: message.poll.messageSecret || randomBytes(32),
    };
    const pollCreationMessage = {
      name: message.poll.name,
      selectableOptionsCount: message.poll.selectableCount,
      options: message.poll.values.map((optionName) => ({ optionName })),
    };
    if (message.poll.toAnnouncementGroup) {
      // poll v2 is for community announcement groups (single select and multiple)
      m.pollCreationMessageV2 = pollCreationMessage;
    } else {
      if (message.poll.selectableCount === 1) {
        //poll v3 is for single select polls
        m.pollCreationMessageV3 = pollCreationMessage;
      } else {
        // poll for multiple choice polls
        m.pollCreationMessage = pollCreationMessage;
      }
    }
  } else if ("sharePhoneNumber" in message) {
    m.protocolMessage = {
      type: proto.Message.ProtocolMessage.Type.SHARE_PHONE_NUMBER,
    };
  } else if ("requestPhoneNumber" in message) {
    m.requestPhoneNumberMessage = {};
  } else if ("limitSharing" in message) {
    m.protocolMessage = {
      type: proto.Message.ProtocolMessage.Type.LIMIT_SHARING,
      limitSharing: {
        sharingLimited: message.limitSharing === true,
        trigger: 1,
        limitSharingSettingTimestamp: Date.now(),
        initiatedByMe: true,
      },
    };
  } else if ("nativeFlowMessage" in message) {
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
  } else if ("buttonsMessage" in message) {
    const bm = message.buttonsMessage;
    const buttons = (bm.buttons ?? []).map(btn => {
      if (btn.buttonId !== undefined) return btn;
      return { buttonId: btn.id ?? btn.buttonId ?? '', buttonText: { displayText: btn.text ?? btn.displayText ?? '' }, type: 1 };
    });
    let headerPart = {};
    if (bm.image || bm.video || bm.document) {
      const mediaKey = bm.image ? 'image' : bm.video ? 'video' : 'document';
      const mediaVal = bm[mediaKey];
      try {
        headerPart = await prepareWAMessageMedia({ [mediaKey]: typeof mediaVal === 'string' ? { url: mediaVal } : mediaVal }, options);
      } catch (_) {
        headerPart = { [mediaKey]: typeof mediaVal === 'string' ? { url: mediaVal } : mediaVal };
      }
    } else {
      headerPart = {
        headerType: 6,
        locationMessage: {
          degreesLatitude: 0,
          degreesLongitude: 0,
          name: bm.title ?? '',
          address: bm.subtitle ?? '',
        },
      };
    }
    m = {
      buttonsMessage: {
        contentText: bm.body ?? bm.contentText ?? '',
        footerText: bm.footer ?? bm.footerText ?? '',
        ...headerPart,
        viewOnce: true,
        contextInfo: bm.contextInfo ?? {},
        buttons,
      }
    };
  } else if ("carouselMessage" in message) {
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
  } else if ("richMessage" in message) {
    const rich = message.richMessage;
    const submessages = [];
    const sections = [];
    const richResponseSources = [];







    const tokenizer = (code, lang = 'javascript') => {
      const normalizedLang = lang.toLowerCase();

      // plaintext passthrough — no tokenization
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
        'c++': new Set(['alignas','alignof','and','and_eq','asm','auto','bitand','bitor','bool','break','case','catch','char','class','compl','concept','const','consteval','constexpr','constinit','const_cast','continue','co_await','co_return','co_yield','decltype','default','delete','do','double','dynamic_cast','else','enum','explicit','export','extern','false','float','for','friend','goto','if','inline','int','long','mutable','namespace','new','noexcept','not','not_eq','nullptr','operator','or','or_eq','private','protected','public','register','reinterpret_cast','requires','return','short','signed','sizeof','static','static_assert','static_cast','struct','switch','template','this','thread_local','throw','true','try','typedef','typeid','typename','union','unsigned','using','virtual','void','volatile','wchar_t','while','xor','xor_eq']),
        php: new Set(['abstract','and','array','as','break','callable','case','catch','class','clone','const','continue','declare','default','die','do','echo','else','elseif','empty','enddeclare','endfor','endforeach','endif','endswitch','endwhile','eval','exit','extends','final','finally','fn','for','foreach','function','global','goto','if','implements','include','include_once','instanceof','insteadof','interface','isset','list','match','namespace','new','null','or','print','private','protected','public','readonly','require','require_once','return','static','switch','throw','trait','true','try','unset','use','var','while','xor','yield','false']),
        rust: new Set(['as','async','await','break','const','continue','crate','dyn','else','enum','extern','false','fn','for','if','impl','in','let','loop','match','mod','move','mut','pub','ref','return','self','Self','static','struct','super','trait','true','type','union','unsafe','use','where','while']),
        html: new Set(['DOCTYPE','html','head','body','div','span','p','a','ul','ol','li','table','tr','td','th','thead','tbody','tfoot','form','input','button','select','option','textarea','label','script','style','link','meta','title','h1','h2','h3','h4','h5','h6','img','video','audio','canvas','svg','nav','header','footer','section','article','aside','main']),
        bash: new Set(['if','then','else','elif','fi','for','in','do','done','while','until','case','esac','function','select','time','coproc','break','continue','return','exit','export','local','declare','readonly','unset','set','shift','source','echo','printf','read','test','true','false']),
        markdown: new Set([])
      };

      const TYPE_MAP = { 0:'DEFAULT', 1:'KEYWORD', 2:'METHOD', 3:'STR', 4:'NUMBER', 5:'COMMENT' };
      const keywords = keywordsMap[normalizedLang] || new Set();
      const tokens = [];
      let i = 0;

      const push = (content, type) => {
        if (!content) return;
        const last = tokens[tokens.length - 1];
        if (last && last.highlightType === type) last.codeContent += content;
        else tokens.push({ codeContent: content, highlightType: type });
      };

      // Language-specific identifier char check
      const isIdentStart = (c) => /[a-zA-Z_$]/.test(c);
      const isIdentPart = (c) => {
        if (normalizedLang === 'css') return /[a-zA-Z0-9_$-]/.test(c);
        if (normalizedLang === 'html') return /[a-zA-Z0-9_$:-]/.test(c);
        return /[a-zA-Z0-9_$]/.test(c);
      };

      while (i < code.length) {
        const c = code[i];

        // Whitespace
        if (/\s/.test(c)) {
          let s = i;
          while (i < code.length && /\s/.test(code[i])) i++;
          push(code.slice(s, i), 0);
          continue;
        }

        // Single-line comments: // (JS/TS/Java/Go/C/C++/Rust/PHP)
        if (c === '/' && code[i + 1] === '/') {
          let s = i; i += 2;
          while (i < code.length && code[i] !== '\n') i++;
          push(code.slice(s, i), 5);
          continue;
        }

        // # comments for Python and Bash
        if (c === '#' && (normalizedLang === 'python' || normalizedLang === 'bash')) {
          let s = i++;
          while (i < code.length && code[i] !== '\n') i++;
          push(code.slice(s, i), 5);
          continue;
        }

        // Block comments /* */
        if (c === '/' && code[i + 1] === '*') {
          let s = i; i += 2;
          while (i < code.length - 1 && !(code[i] === '*' && code[i + 1] === '/')) i++;
          i += 2;
          push(code.slice(s, i), 5);
          continue;
        }

        // Strings
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

        // Numbers
        if (/[0-9]/.test(c)) {
          let s = i;
          while (i < code.length && /[0-9.xXa-fA-F_]/.test(code[i])) i++;
          push(code.slice(s, i), 4);
          continue;
        }

        // Identifiers / keywords / methods
        if (isIdentStart(c)) {
          let s = i;
          while (i < code.length && isIdentPart(code[i])) i++;
          const word = code.slice(s, i);
          let type = 0;
          if (keywords.has(word)) {
            type = 1;
          } else {
            // HTML tag name detection via '<' lookback
            if (normalizedLang === 'html' && s > 0 && (code[s - 1] === '<' || (code[s - 1] === '/' && code[s - 2] === '<'))) {
              type = 1;
            } else {
              let j = i;
              while (j < code.length && /\s/.test(code[j])) j++;
              // CSS property keyword detection via trailing ':'
              if (normalizedLang === 'css' && code[j] === ':') {
                type = 1;
              } else if (code[j] === '(') {
                type = 2; // method call
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
      const markdownCells = [];

      const processRow = (cells, isHeader) => {
        const processed = normalize(cells).map(cell => {
          if (!shouldExtractIE) return { text: cell };
          const { text, inline_entities } = extractIE(cell, { hyperlink, citation, latex });
          if (inline_entities.length) hasEntities = true;
          return { text, inline_entities };
        });
        return { is_header: isHeader, cells: processed.map(c => c.text), _meta: processed };
      };

      const unified_rows = [
        processRow(header, true),
        ...rows.map(r => processRow(r, false))
      ];

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
          typeof item.image === 'string' ? item.image : item.image?.url ?? item.image_url ?? '',
          'url'
        );
        const iconUrl = await Toolkit.resolveMedia(
          item.icon_url ?? item.icon ?? imageUrl ?? '',
          'url'
        );
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
      const rawEntries = Array.isArray(raw) ? raw : [raw];
      const entries = await Promise.all(rawEntries.map(async item => {
        let url, thumbnail, duration, file_length, mime_type;
        if (typeof item === 'string') {
          const parts = item.split('|');
          url = parts[0];
          duration = Number(parts[1]) || 0;
        } else if (typeof item === 'object' && item !== null) {
          url = item.url ?? item.videoUrl ?? '';
          thumbnail = item.thumbnail ?? null;
          duration = item.duration ?? null;
          file_length = item.file_length ?? null;
          mime_type = item.mime_type ?? 'video/mp4';
        }
        const autoFill = item?.autoFill !== false;
        const resolvedUrl = await Toolkit.resolveMedia(url, 'url');
        if (autoFill) {
          // fetch buffer once, reuse for both duration and thumbnail
          const videoBuf = Buffer.isBuffer(url) ? url : await Toolkit.fetchBuffer(url);
          if (duration == null) duration = await Toolkit.getMp4Duration(videoBuf);
          if (thumbnail == null) thumbnail = await Toolkit.getMp4Preview(videoBuf);
        }
        const resolvedThumbnail = thumbnail ? await Toolkit.resolveMedia(thumbnail, 'url') : null;
        return {
          url: resolvedUrl,
          thumbnail: resolvedThumbnail,
          duration: duration ?? 0,
          file_length: file_length ?? 0,
          mime_type: mime_type ?? 'video/mp4'
        };
      }));
      submessages.push({ messageType: 2, messageText: '[ CANNOT_LOAD_VIDEO ]' });
      entries.forEach(entry => sections.push(newLayout('Single', {
        media: {
          url: entry.url,
          mime_type: entry.mime_type,
          duration: entry.duration,
          ...(entry.file_length ? { file_length: entry.file_length } : {}),
          ...(entry.thumbnail ? { thumbnail_url: entry.thumbnail } : {})
        },
        imagine_type: 'ANIMATE',
        status: { status: 'READY' },
        __typename: 'GenAIImaginePrimitive'
      })));
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
      const tableOpts = typeof rich.table === 'object' && !Array.isArray(rich.table)
        ? rich.table
        : { data: rich.table };
      const data = tableOpts.data ?? rich.table;
      const meta = toTableMetadata(data, {
        hyperlink: tableOpts.hyperlink ?? false,
        citation: tableOpts.citation ?? false,
        latex: tableOpts.latex ?? false
      });
      submessages.push({ messageType: 4, tableMetadata: { title: meta.title, rows: meta.rows } });
      const primitive = { rows: meta.unified_rows, __typename: 'GenATableUXPrimitive' };
      if (meta.markdown_cells) primitive.markdown_cells = meta.markdown_cells;
      sections.push(newLayout('Single', primitive));
    }

    if (rich.post || rich.posts) {
      const raw = rich.post || rich.posts;
      const items = Array.isArray(raw) ? raw : [raw];
      submessages.push({ messageType: 2, messageText: '[ CANNOT_LOAD_POST ]' });
      const mapped = await Promise.all(items.map(async p => ({
        title: p.title ?? '',
        subtitle: p.subtitle ?? '',
        username: p.username ?? '',
        profile_picture_url: await Toolkit.resolveMedia(p.profile_picture_url ?? p.profile_url ?? '', 'url'),
        is_verified: !!(p.is_verified || p.verified),
        thumbnail_url: await Toolkit.resolveMedia(p.thumbnail_url ?? p.thumbnail ?? '', 'url'),
        post_caption: p.post_caption ?? p.caption ?? '',
        likes_count: p.likes_count ?? p.like ?? 0,
        comments_count: p.comments_count ?? p.comment ?? 0,
        shares_count: p.shares_count ?? p.share ?? 0,
        post_url: p.post_url ?? p.url ?? '',
        post_deeplink: p.post_deeplink ?? p.deeplink ?? '',
        source_app: p.source_app ?? p.source ?? 'INSTAGRAM',
        footer_label: p.footer_label ?? p.footer ?? '',
        footer_icon: await Toolkit.resolveMedia(p.footer_icon ?? p.icon ?? '', 'url'),
        is_carousel: items.length > 1,
        orientation: p.orientation ?? 'LANDSCAPE',
        post_type: p.post_type ?? 'VIDEO',
        __typename: 'GenAIPostPrimitive'
      })));
      sections.push(newLayout('HScroll', mapped));
    }

    if (rich.reels || rich.reel) {
      const raw = rich.reels ?? rich.reel;
      const items = Array.isArray(raw) ? raw : [raw];
      const resolvedItems = await Promise.all(items.map(async item => ({
        ...item,
        _resolvedThumb: await Toolkit.resolveMedia(item.thumbnailUrl ?? item.thumbnail ?? '', 'url'),
        _resolvedAvatar: await Toolkit.resolveMedia(item.profileIconUrl ?? item.profile_url ?? '', 'url'),
        _resolvedVideo: await Toolkit.resolveMedia(item.videoUrl ?? item.url ?? '', 'url'),
      })));
      submessages.push({
        messageType: 9,
        contentItemsMetadata: {
          contentType: 1,
          itemsMetadata: resolvedItems.map(item => ({
            reelItem: {
              title: item.username ?? item.title ?? '',
              profileIconUrl: item._resolvedAvatar,
              thumbnailUrl: item._resolvedThumb,
              videoUrl: item._resolvedVideo
            }
          }))
        }
      });
      resolvedItems.forEach((item, idx) => richResponseSources.push({
        provider: 'UNKNOWN',
        thumbnailCDNURL: item._resolvedThumb,
        sourceProviderURL: item._resolvedVideo,
        sourceQuery: '',
        faviconCDNURL: item._resolvedAvatar,
        citationNumber: idx + 1,
        sourceTitle: item.username ?? item.title ?? ''
      }));
      sections.push(newLayout('HScroll', resolvedItems.map(item => ({
        reels_url: item._resolvedVideo,
        thumbnail_url: item._resolvedThumb,
        creator: item.username ?? item.title ?? '',
        avatar_url: item._resolvedAvatar,
        reels_title: item.reels_title ?? item.title ?? '',
        likes_count: item.likes_count ?? item.like ?? 0,
        shares_count: item.shares_count ?? item.share ?? 0,
        view_count: item.view_count ?? item.view ?? 0,
        reel_source: item.reel_source ?? item.source ?? 'IG',
        is_verified: !!(item.is_verified || item.verified),
        __typename: 'GenAIReelPrimitive'
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
      sections.push(newLayout('Single', {
        sources: resolved,
        __typename: 'GenAISearchResultPrimitive'
      }));
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
      // Layout: Single for 1 item, HScroll for multiple (scrollable), ActionRow for multiple (non-scrollable)
      let layout;
      if (opts.layout) {
        layout = opts.layout;
      } else if (suggest.length === 1) {
        layout = 'Single';
      } else if (opts.scroll === false) {
        layout = 'ActionRow';
      } else {
        layout = 'HScroll'; // default for multiple (changed from ActionRow in v4.6)
      }
      sections.push(newLayout(layout, suggest.length === 1 ? suggest[0] : suggest));
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

    const { randomUUID } = await import('crypto');

    // Settle all lazy media promises in sections and submessages
    const [resolvedSections, resolvedSubmessages] = await Promise.all([
      Toolkit.waitAllPromises(sections),
      Toolkit.waitAllPromises(submessages)
    ]);

    m = {
      messageContextInfo: {
        deviceListMetadata: {},
        deviceListMetadataVersion: 2,
        botMetadata: {
          messageDisclaimerText: rich.title ?? '',
          richResponseSourcesMetadata: { sources: richResponseSources }
        }
      },
      botForwardedMessage: {
        message: {
          richResponseMessage: {
            messageType: 1,
            submessages: resolvedSubmessages,
            unifiedResponse: {
              data: Buffer.from(JSON.stringify({ response_id: randomUUID(), sections: resolvedSections })).toString('base64')
            },
            contextInfo: {
              forwardingScore: 1,
              isForwarded: true,
              forwardedAiBotMessageInfo: { botJid: '0@bot' },
              forwardOrigin: 4,
              ...(rich.contextInfo ?? {})
            }
          }
        }
      }
    };
  } else {
    m = await prepareWAMessageMedia(message, options);
  }
  if ("viewOnce" in message && !!message.viewOnce) {
    m = { viewOnceMessage: { message: m } };
  }
  if ("mentions" in message && message.mentions?.length) {
    const messageType = Object.keys(m)[0];
    const key = m[messageType];
    if ("contextInfo" in key && !!key.contextInfo) {
      key.contextInfo.mentionedJid = message.mentions;
    } else if (key) {
      key.contextInfo = {
        mentionedJid: message.mentions,
      };
    }
  }
  if ("edit" in message) {
    m = {
      protocolMessage: {
        key: message.edit,
        editedMessage: m,
        timestampMs: Date.now(),
        type: WAProto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
      },
    };
  }
  if ("contextInfo" in message && !!message.contextInfo) {
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
  // set timestamp to now
  // if not specified
  if (!options.timestamp) {
    options.timestamp = new Date();
  }
  const innerMessage = normalizeMessageContent(message);
  const key = getContentType(innerMessage);
  const timestamp = unixTimestampSeconds(options.timestamp);
  const { quoted, userJid } = options;
  if (quoted && !isJidNewsletter(jid)) {
    const participant = quoted.key.fromMe
      ? userJid // TODO: Add support for LIDs
      : quoted.participant || quoted.key.participant || quoted.key.remoteJid;
    let quotedMsg = normalizeMessageContent(quoted.message);
    const msgType = getContentType(quotedMsg);
    // strip any redundant properties
    quotedMsg = proto.Message.create({ [msgType]: quotedMsg[msgType] });
    const quotedContent = quotedMsg[msgType];
    if (
      typeof quotedContent === "object" &&
      quotedContent &&
      "contextInfo" in quotedContent
    ) {
      delete quotedContent.contextInfo;
    }
    const contextInfo =
      ("contextInfo" in innerMessage[key] && innerMessage[key]?.contextInfo) ||
      {};
    contextInfo.participant = jidNormalizedUser(participant);
    contextInfo.stanzaId = quoted.key.id;
    contextInfo.quotedMessage = quotedMsg;
    // if a participant is quoted, then it must be a group
    // hence, remoteJid of group must also be entered
    if (jid !== quoted.key.remoteJid) {
      contextInfo.remoteJid = quoted.key.remoteJid;
    }
    if (contextInfo && innerMessage[key]) {
      if (key === 'botForwardedMessage') {
        // Special handling for richMessage — inject quoted into nested richResponseMessage.contextInfo
        const richCtx = innerMessage[key]?.message?.richResponseMessage?.contextInfo ?? {};
        innerMessage[key].message.richResponseMessage.contextInfo = {
          ...richCtx,
          stanzaId: contextInfo.stanzaId,
          participant: contextInfo.participant,
          quotedMessage: contextInfo.quotedMessage,
          ...(contextInfo.remoteJid ? { remoteJid: contextInfo.remoteJid } : {}),
        };
      } else {
        /* @ts-ignore */
        innerMessage[key].contextInfo = contextInfo;
      }
    }
  }
  if (
    // if we want to send a disappearing message
    !!options?.ephemeralExpiration &&
    // and it's not a protocol message -- delete, toggle disappear message
    key !== "protocolMessage" &&
    // already not converted to disappearing message
    key !== "ephemeralMessage" &&
    // newsletters don't support ephemeral messages
    !isJidNewsletter(jid)
  ) {
    /* @ts-ignore */
    innerMessage[key].contextInfo = {
      ...(innerMessage[key].contextInfo || {}),
      expiration: options.ephemeralExpiration || WA_DEFAULT_EPHEMERAL,
      //ephemeralSettingTimestamp: options.ephemeralOptions.eph_setting_ts?.toString()
    };
  }
  message = WAProto.Message.create(message);
  const messageJSON = {
    key: {
      remoteJid: jid,
      fromMe: true,
      id: options?.messageId || generateMessageIDV2(),
    },
    message: message,
    messageTimestamp: timestamp,
    messageStubParameters: [],
    participant:
      isJidGroup(jid) || isJidStatusBroadcast(jid) ? userJid : undefined, // TODO: Add support for LIDs
    status: WAMessageStatus.PENDING,
  };
  return WAProto.WebMessageInfo.fromObject(messageJSON);
};
export const generateWAMessage = async (jid, content, options) => {
  // ensure msg ID is with every log
  options.logger = options?.logger?.child({ msgId: options.messageId });
  // Pass jid in the options to generateWAMessageContent
  return generateWAMessageFromContent(
    jid,
    await generateWAMessageContent(content, { ...options, jid }),
    options,
  );
};
/** Get the key to access the true type of content */
export const getContentType = (content) => {
  if (content) {
    const keys = Object.keys(content);
    const key = keys.find(
      (k) =>
        (k === "conversation" || k.includes("Message")) &&
        k !== "senderKeyDistributionMessage",
    );
    return key;
  }
};
/**
 * Normalizes ephemeral, view once messages to regular message content
 * Eg. image messages in ephemeral messages, in view once messages etc.
 * @param content
 * @returns
 */
export const normalizeMessageContent = (content) => {
  if (!content) {
    return undefined;
  }
  // set max iterations to prevent an infinite loop
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
      message?.ephemeralMessage ||
      message?.viewOnceMessage ||
      message?.documentWithCaptionMessage ||
      message?.viewOnceMessageV2 ||
      message?.viewOnceMessageV2Extension ||
      message?.editedMessage
    );
  }
};
/**
 * Extract the true message content from a message
 * Eg. extracts the inner message from a disappearing message/view once message
 */
export const extractMessageContent = (content) => {
  const extractFromTemplateMessage = (msg) => {
    if (msg.imageMessage) {
      return { imageMessage: msg.imageMessage };
    } else if (msg.documentMessage) {
      return { documentMessage: msg.documentMessage };
    } else if (msg.videoMessage) {
      return { videoMessage: msg.videoMessage };
    } else if (msg.locationMessage) {
      return { locationMessage: msg.locationMessage };
    } else {
      return {
        conversation:
          "contentText" in msg
            ? msg.contentText
            : "hydratedContentText" in msg
              ? msg.hydratedContentText
              : "",
      };
    }
  };
  content = normalizeMessageContent(content);
  if (content?.buttonsMessage) {
    return extractFromTemplateMessage(content.buttonsMessage);
  }
  if (content?.templateMessage?.hydratedFourRowTemplate) {
    return extractFromTemplateMessage(
      content?.templateMessage?.hydratedFourRowTemplate,
    );
  }
  if (content?.templateMessage?.hydratedTemplate) {
    return extractFromTemplateMessage(
      content?.templateMessage?.hydratedTemplate,
    );
  }
  if (content?.templateMessage?.fourRowTemplate) {
    return extractFromTemplateMessage(
      content?.templateMessage?.fourRowTemplate,
    );
  }
  return content;
};
/**
 * Returns the device predicted by message ID
 */
export const getDevice = (id) =>
  /^3A.{18}$/.test(id)
    ? "ios"
    : /^3E.{20}$/.test(id)
      ? "web"
      : /^(.{21}|.{32})$/.test(id)
        ? "android"
        : /^(3F|.{18}$)/.test(id)
          ? "desktop"
          : "unknown";
/** Upserts a receipt in the message */
export const updateMessageWithReceipt = (msg, receipt) => {
  msg.userReceipt = msg.userReceipt || [];
  const recp = msg.userReceipt.find((m) => m.userJid === receipt.userJid);
  if (recp) {
    Object.assign(recp, receipt);
  } else {
    msg.userReceipt.push(receipt);
  }
};
/** Update the message with a new reaction */
export const updateMessageWithReaction = (msg, reaction) => {
  const authorID = getKeyAuthor(reaction.key);
  const reactions = (msg.reactions || []).filter(
    (r) => getKeyAuthor(r.key) !== authorID,
  );
  reaction.text = reaction.text || "";
  reactions.push(reaction);
  msg.reactions = reactions;
};
/** Update the message with a new poll update */
export const updateMessageWithPollUpdate = (msg, update) => {
  const authorID = getKeyAuthor(update.pollUpdateMessageKey);
  const reactions = (msg.pollUpdates || []).filter(
    (r) => getKeyAuthor(r.pollUpdateMessageKey) !== authorID,
  );
  if (update.vote?.selectedOptions?.length) {
    reactions.push(update);
  }
  msg.pollUpdates = reactions;
};
/** Update the message with a new event response */
export const updateMessageWithEventResponse = (msg, update) => {
  const authorID = getKeyAuthor(update.eventResponseMessageKey);
  const responses = (msg.eventResponses || []).filter(
    (r) => getKeyAuthor(r.eventResponseMessageKey) !== authorID,
  );
  responses.push(update);
  msg.eventResponses = responses;
};
/**
 * Aggregates all poll updates in a poll.
 * @param msg the poll creation message
 * @param meId your jid
 * @returns A list of options & their voters
 */
export function getAggregateVotesInPollMessage({ message, pollUpdates }, meId) {
  const opts =
    message?.pollCreationMessage?.options ||
    message?.pollCreationMessageV2?.options ||
    message?.pollCreationMessageV3?.options ||
    [];
  const voteHashMap = opts.reduce((acc, opt) => {
    const hash = sha256(Buffer.from(opt.optionName || "")).toString();
    acc[hash] = {
      name: opt.optionName || "",
      voters: [],
    };
    return acc;
  }, {});
  for (const update of pollUpdates || []) {
    const { vote } = update;
    if (!vote) {
      continue;
    }
    for (const option of vote.selectedOptions || []) {
      const hash = option.toString();
      let data = voteHashMap[hash];
      if (!data) {
        voteHashMap[hash] = {
          name: "Unknown",
          voters: [],
        };
        data = voteHashMap[hash];
      }
      voteHashMap[hash].voters.push(
        getKeyAuthor(update.pollUpdateMessageKey, meId),
      );
    }
  }
  return Object.values(voteHashMap);
}
/**
 * Aggregates all event responses in an event message.
 * @param msg the event creation message
 * @param meId your jid
 * @returns A list of response types & their responders
 */
export function getAggregateResponsesInEventMessage({ eventResponses }, meId) {
  const responseTypes = ["GOING", "NOT_GOING", "MAYBE"];
  const responseMap = {};
  for (const type of responseTypes) {
    responseMap[type] = {
      response: type,
      responders: [],
    };
  }
  for (const update of eventResponses || []) {
    const responseType = update.eventResponse || "UNKNOWN";
    if (responseType !== "UNKNOWN" && responseMap[responseType]) {
      responseMap[responseType].responders.push(
        getKeyAuthor(update.eventResponseMessageKey, meId),
      );
    }
  }
  return Object.values(responseMap);
}
/** Given a list of message keys, aggregates them by chat & sender. Useful for sending read receipts in bulk */
export const aggregateMessageKeysNotFromMe = (keys) => {
  const keyMap = {};
  for (const { remoteJid, id, participant, fromMe } of keys) {
    if (!fromMe) {
      const uqKey = `${remoteJid}:${participant || ""}`;
      if (!keyMap[uqKey]) {
        keyMap[uqKey] = {
          jid: remoteJid,
          participant: participant,
          messageIds: [],
        };
      }
      keyMap[uqKey].messageIds.push(id);
    }
  }
  return Object.values(keyMap);
};
const REUPLOAD_REQUIRED_STATUS = [410, 404];
/**
 * Downloads the given message. Throws an error if it's not a media message
 */
export const downloadMediaMessage = async (message, type, options, ctx) => {
  const result = await downloadMsg().catch(async (error) => {
    if (
      ctx &&
      typeof error?.status === "number" && // treat errors with status as HTTP failures requiring reupload
      REUPLOAD_REQUIRED_STATUS.includes(error.status)
    ) {
      ctx.logger.info(
        { key: message.key },
        "sending reupload media request...",
      );
      // request reupload
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
    const media = mContent[contentType];
    if (
      !media ||
      typeof media !== "object" ||
      (!("url" in media) && !("thumbnailDirectPath" in media))
    ) {
      throw new Boom(`"${contentType}" message is not a media message`);
    }
    let download;
    if ("thumbnailDirectPath" in media && !("url" in media)) {
      download = {
        directPath: media.thumbnailDirectPath,
        mediaKey: media.mediaKey,
      };
      mediaType = "thumbnail-link";
    } else {
      download = media;
    }
    const stream = await downloadContentFromMessage(
      download,
      mediaType,
      options,
    );
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
/** Checks whether the given message is a media message; if it is returns the inner content */
export const assertMediaContent = (content) => {
  content = extractMessageContent(content);
  const mediaContent =
    content?.documentMessage ||
    content?.imageMessage ||
    content?.videoMessage ||
    content?.audioMessage ||
    content?.stickerMessage;
  if (!mediaContent) {
    throw new Boom("given message is not a media message", {
      statusCode: 400,
      data: content,
    });
  }
  return mediaContent;
};
//# sourceMappingURL=messages.js.map
