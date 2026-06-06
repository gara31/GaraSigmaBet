import { Boom } from "@hapi/boom";
import { randomBytes } from "crypto";
import { promises as fs } from "fs";
import {} from "stream";
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

    const extractIE = (text, { hyperlink = true, citation = true, latex = true } = {}) => {
      let ie = [], result = '', last = 0,
        citation_index = 1, hyperlink_index = 0, latex_index = 0,
        stack = [];
      for (let i = 0; i < text.length; i++) {
        if (text[i] == '[' && text[i - 1] != '\\') {
          stack.push(i);
        } else if (text[i] == ']' && (text[i + 1] == '(' || text[i + 1] == '<')) {
          let start = stack.pop();
          if (start == null) continue;
          let open = text[i + 1],
            close = open == '(' ? ')' : '>',
            type = open == '(' ? 'link' : 'latex',
            end = i + 2, depth = 1;
          while (end < text.length && depth) {
            if (text[end] == open && text[end - 1] != '\\') depth++;
            else if (text[end] == close && text[end - 1] != '\\') depth--;
            end++;
          }
          if (depth) continue;
          let raw = text.slice(start + 1, i).trim(),
            url = text.slice(i + 2, end - 1).trim(),
            key, tag, data;
          if (type == 'latex') {
            if (!latex) continue;
            let [txt = '', width = null, height = null, font_height = null, padding = null] = raw.split('|');
            key = `NIXEL_LATEX_${latex_index++}`;
            tag = `{{${key}}}${txt || 'image'}{{/${key}}}`;
            data = { type: 'latex', ie: { key, text: txt, url, width, height, font_height, padding } };
          } else if (raw) {
            if (!hyperlink) continue;
            key = `NIXEL_HYPERLINK_${hyperlink_index++}`;
            tag = `{{${key}}}${url}{{/${key}}}`;
            data = { type: 'hyperlink', ie: { key, text: raw, url } };
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
      return { text: result, ie };
    };

    const mapInlineEntities = (ieList) => ieList.map(({ type, ie }) => {
      if (type == 'hyperlink') return {
        key: ie.key,
        metadata: { display_name: ie.text, is_trusted: true, url: ie.url, __typename: 'GenAIInlineLinkItem' }
      };
      if (type == 'citation') return {
        key: ie.key,
        metadata: {
          reference_id: ie.reference_id,
          reference_url: ie.url,
          reference_title: ie.url,
          reference_display_name: ie.url,
          sources: [],
          __typename: 'GenAISearchCitationItem'
        }
      };
      if (type == 'latex') return {
        key: ie.key,
        metadata: {
          latex_expression: ie.text,
          latex_image: { url: ie.url, width: Number(ie.width) || 100, height: Number(ie.height) || 100 },
          font_height: Number(ie.font_height) || 83.333333333333,
          padding: Number(ie.padding) || 15,
          __typename: 'GenAILatexItem'
        }
      };
    });

    const tokenizer = (code, lang = 'javascript') => {
      const keywordsMap = {
        javascript: new Set([
          'break','case','catch','continue','debugger','delete','do','else','finally','for',
          'function','if','in','instanceof','new','return','switch','this','throw','try',
          'typeof','var','void','while','with','true','false','null','undefined','class',
          'const','let','super','extends','export','import','yield','static','constructor',
          'async','await','get','set'
        ])
      };
      const TYPE_MAP = { 0:'DEFAULT', 1:'KEYWORD', 2:'METHOD', 3:'STR', 4:'NUMBER', 5:'COMMENT' };
      const keywords = keywordsMap[lang] || new Set();
      const tokens = [];
      let i = 0;
      const push = (content, type) => {
        if (!content) return;
        const last = tokens[tokens.length - 1];
        if (last && last.highlightType === type) last.codeContent += content;
        else tokens.push({ codeContent: content, highlightType: type });
      };
      while (i < code.length) {
        const c = code[i];
        if (/\s/.test(c)) { let s = i; while (i < code.length && /\s/.test(code[i])) i++; push(code.slice(s, i), 0); continue; }
        if (c === '/' && code[i + 1] === '/') { let s = i; i += 2; while (i < code.length && code[i] !== '\n') i++; push(code.slice(s, i), 5); continue; }
        if (c === '"' || c === "'" || c === '`') {
          let s = i; const q = c; i++;
          while (i < code.length) {
            if (code[i] === '\\' && i + 1 < code.length) i += 2;
            else if (code[i] === q) { i++; break; }
            else i++;
          }
          push(code.slice(s, i), 3); continue;
        }
        if (/[0-9]/.test(c)) { let s = i; while (i < code.length && /[0-9.]/.test(code[i])) i++; push(code.slice(s, i), 4); continue; }
        if (/[a-zA-Z_$]/.test(c)) {
          let s = i;
          while (i < code.length && /[a-zA-Z0-9_$]/.test(code[i])) i++;
          const word = code.slice(s, i);
          let type = 0;
          if (keywords.has(word)) type = 1;
          else { let j = i; while (j < code.length && /\s/.test(code[j])) j++; if (code[j] === '(') type = 2; }
          push(word, type); continue;
        }
        push(c, 0); i++;
      }
      return {
        codeBlock: tokens,
        unified_codeBlock: tokens.map(t => ({ content: t.codeContent, type: TYPE_MAP[t.highlightType] }))
      };
    };

    const toTableMetadata = (arr) => {
      if (!Array.isArray(arr) || !arr.every(row => Array.isArray(row) && row.every(cell => typeof cell === 'string'))) {
        throw new TypeError('Table must be a nested array of strings');
      }
      const [header, ...rows] = arr;
      const maxLen = Math.max(header.length, ...rows.map(r => r.length));
      const normalize = (r) => [...r, ...Array(maxLen - r.length).fill('')];
      const unified_rows = [
        { is_header: true, cells: normalize(header) },
        ...rows.map(r => ({ is_header: false, cells: normalize(r) }))
      ];
      return {
        title: '',
        rows: unified_rows.map(r => ({ items: r.cells, ...(r.is_header ? { isHeading: true } : {}) })),
        unified_rows
      };
    };

    const newLayout = (name, data) => ({
      view_model: {
        [Array.isArray(data) ? 'primitives' : 'primitive']: data,
        __typename: `GenAI${name}LayoutViewModel`
      }
    });

    if (rich.text) {
      const input = typeof rich.text === 'string' ? rich.text : String(rich.text);
      const extracted = extractIE(input);
      const inline_entities = mapInlineEntities(extracted.ie);
      submessages.push({ messageType: 2, messageText: extracted.text });
      sections.push(newLayout('Single', {
        text: extracted.text,
        ...(inline_entities.length && { inline_entities }),
        __typename: 'GenAIMarkdownTextUXPrimitive'
      }));
    }

    if (rich.product || rich.products) {
      const raw = rich.product || rich.products;
      const items = Array.isArray(raw) ? raw : [raw];
      submessages.push({ messageType: 2, messageText: '[ CANNOT_LOAD_PRODUCT ]' });
      const mapped = items.map(item => ({
        title: item.title ?? '',
        brand: item.brand ?? '',
        price: item.price ?? '',
        sale_price: item.sale_price ?? '',
        product_url: item.product_url ?? item.url ?? '',
        image: { url: typeof item.image === 'string' ? item.image : item.image?.url ?? item.image_url ?? '' },
        additional_images: [{ url: item.icon_url ?? item.icon ?? (typeof item.image === 'string' ? item.image : item.image?.url ?? '') }],
        __typename: 'GenAIProductItemCardPrimitive'
      }));
      sections.push(newLayout(items.length > 1 ? 'HScroll' : 'Single', items.length > 1 ? mapped : mapped[0]));
    }

    if (rich.image || rich.images) {
      const raw = rich.image || rich.images;
      const urls = Array.isArray(raw) ? raw : [raw];
      submessages.push({
        messageType: 1,
        gridImageMetadata: {
          gridImageUrl: { imagePreviewUrl: urls[0] },
          imageUrls: urls.map(url => ({ imagePreviewUrl: url, imageHighResUrl: url, sourceUrl: 'https://google.com' }))
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
      const entries = (Array.isArray(raw) ? raw : [raw]).map(item => {
        if (typeof item === 'string') {
          const [url, duration = 0] = item.split('|');
          return { url, duration: Number(duration) || 0 };
        }
        return { url: item.url ?? item.videoUrl ?? '', duration: item.duration ?? 0 };
      });
      submessages.push({ messageType: 2, messageText: '[ CANNOT_LOAD_VIDEO ]' });
      entries.forEach(({ url, duration }) => sections.push(newLayout('Single', {
        media: { url, mime_type: 'video/mp4', duration },
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
      const meta = toTableMetadata(rich.table);
      submessages.push({ messageType: 4, tableMetadata: { title: meta.title, rows: meta.rows } });
      sections.push(newLayout('Single', { rows: meta.unified_rows, __typename: 'GenATableUXPrimitive' }));
    }

    if (rich.post || rich.posts) {
      const raw = rich.post || rich.posts;
      const items = Array.isArray(raw) ? raw : [raw];
      submessages.push({ messageType: 2, messageText: '[ CANNOT_LOAD_POST ]' });
      const mapped = items.map(p => ({
        title: p.title ?? '',
        subtitle: p.subtitle ?? '',
        username: p.username ?? '',
        profile_picture_url: p.profile_picture_url ?? p.profile_url ?? '',
        is_verified: !!(p.is_verified || p.verified),
        thumbnail_url: p.thumbnail_url ?? p.thumbnail ?? '',
        post_caption: p.post_caption ?? p.caption ?? '',
        likes_count: p.likes_count ?? p.like ?? 0,
        comments_count: p.comments_count ?? p.comment ?? 0,
        shares_count: p.shares_count ?? p.share ?? 0,
        post_url: p.post_url ?? p.url ?? '',
        post_deeplink: p.post_deeplink ?? p.deeplink ?? '',
        source_app: p.source_app ?? p.source ?? 'INSTAGRAM',
        footer_label: p.footer_label ?? p.footer ?? '',
        footer_icon: p.footer_icon ?? p.icon ?? '',
        is_carousel: items.length > 1,
        orientation: p.orientation ?? 'LANDSCAPE',
        post_type: p.post_type ?? 'VIDEO',
        __typename: 'GenAIPostPrimitive'
      }));
      sections.push(newLayout('HScroll', mapped));
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
              profileIconUrl: item.profileIconUrl ?? item.profile_url ?? '',
              thumbnailUrl: item.thumbnailUrl ?? item.thumbnail ?? '',
              videoUrl: item.videoUrl ?? item.url ?? ''
            }
          }))
        }
      });
      items.forEach((item, idx) => richResponseSources.push({
        provider: 'UNKNOWN',
        thumbnailCDNURL: item.thumbnailUrl ?? item.thumbnail ?? '',
        sourceProviderURL: item.videoUrl ?? item.url ?? '',
        sourceQuery: '',
        faviconCDNURL: item.profileIconUrl ?? item.profile_url ?? '',
        citationNumber: idx + 1,
        sourceTitle: item.username ?? item.title ?? ''
      }));
      sections.push(newLayout('HScroll', items.map(item => ({
        reels_url: item.videoUrl ?? item.url ?? '',
        thumbnail_url: item.thumbnailUrl ?? item.thumbnail ?? '',
        creator: item.username ?? item.title ?? '',
        avatar_url: item.profileIconUrl ?? item.profile_url ?? '',
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
      sections.push(newLayout('Single', {
        sources: sourceArr.map(s => typeof s === 'object' && !Array.isArray(s) ? s : {
          source_type: 'THIRD_PARTY',
          source_display_name: s[2] ?? '',
          source_subtitle: 'AI',
          source_url: s[1] ?? '',
          favicon: { url: s[0] ?? '', mime_type: 'image/jpeg', width: 16, height: 16 }
        }),
        __typename: 'GenAISearchResultPrimitive'
      }));
    }

    if (rich.suggestions || rich.suggest) {
      const raw = rich.suggestions ?? rich.suggest;
      const suggest = (Array.isArray(raw) ? raw : [raw]).map(text => ({
        prompt_text: String(text),
        prompt_type: 'SUGGESTED_PROMPT',
        __typename: 'GenAIFollowUpSuggestionPillPrimitive'
      }));
      sections.push(newLayout('ActionRow', suggest));
    }

    const { randomUUID } = await import('crypto');

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
            submessages,
            unifiedResponse: {
              data: Buffer.from(JSON.stringify({ response_id: randomUUID(), sections })).toString('base64')
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
      /* @ts-ignore */
      innerMessage[key].contextInfo = contextInfo;
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

