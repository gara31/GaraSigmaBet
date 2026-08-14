import { prepareWAMessageMedia } from './messages.js';
import { extractImageThumb, getHttpStream } from './messages-media.js';

const THUMBNAIL_WIDTH_PX = 192;

const htmlDecode = (s) => s
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

const getMetaContent = (html, keys) => {
    const pattern = new RegExp(`<meta[^>]+(?:property|name)=["'](?:${keys.join('|')})["'][^>]*content=["']([^"']*)["']`, 'i');
    const match = html.match(pattern);
    if (match) return htmlDecode(match[1]);
    const reversed = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["'](?:${keys.join('|')})["']`, 'i');
    const alt = html.match(reversed);
    if (alt) return htmlDecode(alt[1]);
    return null;
};

const getTitle = (html) => {
    const meta = getMetaContent(html, ['og:title', 'twitter:title']);
    if (meta) return meta;
    const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    return match ? htmlDecode(match[1].trim()) : null;
};

const getFavicon = (html, baseUrl) => {
    const match = html.match(/<link[^>]+href=["']([^"']+)["'][^>]*rel=["'](?:shortcut\s+)?icon["']/i) ||
                  html.match(/<link[^>]+rel=["'](?:shortcut\s+)?icon["'][^>]*href=["']([^"']+)["']/i);
    const href = match ? match[1] || match[2] : null;
    try {
        return new URL(href || '/favicon.ico', baseUrl).href;
    } catch {
        return href || `${baseUrl}/favicon.ico`;
    }
};

const getCompressedJpegThumbnail = async (url, { thumbnailWidth, fetchOpts }) => {
    const stream = await getHttpStream(url, fetchOpts);
    const result = await extractImageThumb(stream, thumbnailWidth);
    return result;
};

const fetchPage = async (url, fetchOpts = {}) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), fetchOpts.timeout || 3000);
    try {
        const response = await fetch(url, {
            method: 'GET',
            redirect: 'follow',
            signal: controller.signal,
            headers: {
                'user-agent': 'WhatsApp/2.24.6.77',
                accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                ...(fetchOpts.headers || {})
            }
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const html = await response.text();
        return {
            html,
            finalUrl: response.url || url
        };
    } finally {
        clearTimeout(timer);
    }
};

export const getUrlInfo = async (text, opts = {
    thumbnailWidth: THUMBNAIL_WIDTH_PX,
    fetchOpts: { timeout: 3000 }
}) => {
    try {
        let previewLink = text;
        if (!previewLink.startsWith('https://') && !previewLink.startsWith('http://')) {
            previewLink = 'https://' + previewLink;
        }
        const { html, finalUrl } = await fetchPage(previewLink, opts.fetchOpts);
        const title = getTitle(html);
        if (!title) {
            return undefined;
        }
        const description = getMetaContent(html, ['og:description', 'twitter:description', 'description']);
        const image = getMetaContent(html, ['og:image', 'twitter:image']);
        const favicon = getFavicon(html, finalUrl);
        const urlInfo = {
            'canonical-url': finalUrl,
            'matched-text': text,
            title,
            description,
            originalThumbnailUrl: image || favicon
        };
        if (opts.uploadImage) {
            const { imageMessage } = await prepareWAMessageMedia({ image: { url: urlInfo.originalThumbnailUrl } }, {
                upload: opts.uploadImage,
                mediaTypeOverride: 'thumbnail-link',
                options: opts.fetchOpts
            });
            urlInfo.jpegThumbnail = imageMessage?.jpegThumbnail ? Buffer.from(imageMessage.jpegThumbnail) : undefined;
            urlInfo.highQualityThumbnail = imageMessage || undefined;
        }
        else {
            try {
                urlInfo.jpegThumbnail = (await getCompressedJpegThumbnail(urlInfo.originalThumbnailUrl, opts)).buffer;
            }
            catch (error) {
                opts.logger?.debug({ err: error.stack, url: previewLink }, 'error in generating thumbnail');
            }
        }
        return urlInfo;
    }
    catch (error) {
        opts.logger?.debug({ err: error.stack, url: text }, 'error in generating link preview');
    }
};
