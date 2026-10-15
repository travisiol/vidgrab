// Static HTML analysis: crawlable links, media URLs, embedded players, and hints that a
// JS player is present (which makes the headless-browser pass worth its cost).
import * as cheerio from 'cheerio';
import { resolveUrl, normalizePageUrl } from './util.js';

export const DIRECT_EXT = /\.(mp4|m4v|webm|mov|mkv|ogv|flv|avi|wmv|3gp)(?:$|[?#])/i;
export const HLS_EXT = /\.m3u8(?:$|[?#])/i;
export const DASH_EXT = /\.mpd(?:$|[?#])/i;
const SKIP_LINK_EXT =
  /\.(jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|pdf|zip|rar|7z|gz|tar|exe|msi|dmg|apk|css|js|mjs|json|xml|rss|atom|woff2?|ttf|otf|eot|mp3|wav|flac|aac|ogg|m4a|docx?|xlsx?|pptx?|txt|csv|ts|m4s|vtt|srt)(?:$|[?#])/i;
const SKIP_LINK_PATH = /\/(log-?out|sign-?out|wp-admin|wp-login|cart|checkout|account\/delete)\b/i;

// Players whose iframe/page URL yt-dlp resolves natively.
const EMBED_HOSTS =
  /(^|\.)(youtube(-nocookie)?\.com|youtu\.be|vimeo\.com|dailymotion\.com|dai\.ly|twitch\.tv|streamable\.com|wistia\.(com|net)|fast\.wistia\.net|jwplayer\.com|jwplatform\.com|brightcove\.net|vidyard\.com|loom\.com|rumble\.com|facebook\.com|instagram\.com|tiktok\.com|twitter\.com|x\.com|bilibili\.com|odysee\.com|bitchute\.com|kick\.com|mux\.com|cloudflarestream\.com|videodelivery\.net|sproutvideo\.com|vk\.com|vkvideo\.ru|ok\.ru|rutube\.ru|soundcloud\.com|bandcamp\.com|archive\.org|peertube\.[a-z.]+|reddit\.com|redd\.it|imgur\.com|gfycat\.com|ted\.com|spreaker\.com|mixcloud\.com|vidio\.com|bunnycdn\.com|mediadelivery\.net|kaltura\.com|ooyala\.com|dacast\.com|vidlii\.com|ustream\.tv|video\.ibm\.com)$/i;

export const PLAYER_HINT =
  /<video\b|jwplayer|video\.js|videojs|hls(\.min)?\.js|plyr|flowplayer|clappr|dash(\.all)?(\.min)?\.js|shaka-player|mediaelement|fluidplayer|\.m3u8|\.mp4\b|og:video|"VideoObject"|data-video|player\.(js|min\.js)/i;

// Ad servers and VAST/VPAID creatives: their clips are never what the user is after.
const AD_URL =
  /(doubleclick|googlesyndication|googleadservices|imasdk|adnxs|adsrvr|adform|smartadserver|spotxchange|springserve|teads|taboola|outbrain|criteo|pubmatic|rubiconproject|flashtalking|sizmek|innovid|serving-sys|2mdn.net|tribalfusion|viously|aniview|vidazoo|sekindo|primis|adsafeprotected|moatads|web_video_ads|video_ads|tremorhub|videohub|exoclick|trafficjunky|juicyads|popads|adsterra|adserver|\/vast\/|\/vpaid\/|[?&]vast=)/i;

export const isAdUrl = (u) => AD_URL.test(u);

export const isEmbedHost = (u) => {
  try {
    return EMBED_HOSTS.test(new URL(u).hostname);
  } catch {
    return false;
  }
};

export function mediaKind(u, contentType = '') {
  const ct = contentType.toLowerCase();
  if (HLS_EXT.test(u) || ct.includes('mpegurl')) return 'hls';
  if (DASH_EXT.test(u) || ct.includes('dash+xml')) return 'dash';
  if (ct.includes('mp2t') || /\.(ts|m4s)(?:$|[?#])/i.test(u)) return null; // stream segments
  if (DIRECT_EXT.test(u) || ct.startsWith('video/')) return 'direct';
  return null;
}

const unescapeJs = (s) =>
  s
    .replace(/\\u002[fF]/g, '/')
    .replace(/\\u0026/g, '&')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&');

const ABS_MEDIA = /https?:(?:\\?\/){2}[^"'\s<>()`]+?\.(?:m3u8|mpd|mp4|m4v|webm|mov)(?:\?[^"'\s<>()`]*)?(?=["'\s<>()`]|$)/gi;
const REL_MEDIA = /["'](\/[^"'\s<>]+?\.(?:m3u8|mpd|mp4|m4v|webm))(?:\?[^"'\s<>]*)?["']/gi;

export function extract(html, pageUrl) {
  const $ = cheerio.load(html);
  const base = resolveUrl($('base[href]').attr('href'), pageUrl) ?? pageUrl;
  const media = new Map();
  const embeds = new Set();
  const frames = new Set();
  const links = new Set();

  const addMedia = (raw, source) => {
    const url = resolveUrl(unescapeJs(raw ?? ''), base);
    if (!url) return;
    const kind = mediaKind(url);
    if (kind && !media.has(url) && !isAdUrl(url)) media.set(url, { url, kind, source });
  };
  const addEmbed = (raw) => {
    const url = resolveUrl(raw, base);
    if (url && isEmbedHost(url)) embeds.add(url);
    return url;
  };

  // One <video> often lists the same clip in several containers (mp4 + webm + ogg): keep the best.
  const RANK = { hls: 0, dash: 1, direct: 2 };
  $('video').each((_, el) => {
    const options = [];
    for (const node of [el, ...$(el).find('source').toArray()]) {
      for (const attr of ['src', 'data-src', 'data-video-src', 'data-hls', 'data-mp4']) {
        const url = resolveUrl(unescapeJs($(node).attr(attr) ?? ''), base);
        const kind = url && mediaKind(url);
        if (kind) options.push({ url, kind, mp4: /\.(mp4|m4v)(?:$|[?#])/i.test(url) });
      }
    }
    options.sort((a, b) => RANK[a.kind] - RANK[b.kind] || b.mp4 - a.mp4);
    if (options[0]) addMedia(options[0].url, 'tag');
  });
  $('[data-video-src], [data-video-url], [data-src], [data-hls-url], [data-stream]').each((_, el) => {
    const $el = $(el);
    for (const attr of ['data-video-src', 'data-video-url', 'data-src', 'data-hls-url', 'data-stream'])
      addMedia($el.attr(attr), 'data');
  });

  const metas = [
    'og:video',
    'og:video:url',
    'og:video:secure_url',
    'twitter:player:stream',
    'twitter:player',
    'contentUrl',
    'embedUrl',
  ];
  for (const name of metas) {
    $(`meta[property="${name}"], meta[name="${name}"], meta[itemprop="${name}"]`).each((_, el) => {
      const value = $(el).attr('content');
      addMedia(value, 'meta');
      addEmbed(value);
    });
  }
  $('link[rel="video_src"], link[itemprop="contentUrl"], link[itemprop="embedUrl"]').each((_, el) => {
    addMedia($(el).attr('href'), 'meta');
    addEmbed($(el).attr('href'));
  });

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      walkJsonLd(JSON.parse($(el).text()), (node) => {
        addMedia(node.contentUrl, 'jsonld');
        addEmbed(node.embedUrl);
      });
    } catch {
      /* malformed JSON-LD is common */
    }
  });

  $('iframe[src], iframe[data-src], embed[src], object[data]').each((_, el) => {
    const $el = $(el);
    const url = addEmbed($el.attr('src') ?? $el.attr('data-src') ?? $el.attr('data'));
    // Unknown players (often /embed/123 pages on the same site) get scanned one level deep.
    if (url && !isEmbedHost(url) && /embed|player|video|stream|watch/i.test(url)) frames.add(url);
  });

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    const url = resolveUrl(href, base);
    if (!url) return;
    if (mediaKind(url)) return addMedia(url, 'link');
    if (isEmbedHost(url) && /watch|video|embed|\/v\/|\/\d{5,}/i.test(url)) embeds.add(url);
    if (SKIP_LINK_EXT.test(url) || SKIP_LINK_PATH.test(url)) return;
    const page = normalizePageUrl(url);
    if (page) links.add(page);
  });

  // Player configs inside inline scripts (jwplayer setup, hls.js sources, JSON blobs...).
  const unescaped = unescapeJs(html);
  for (const m of unescaped.matchAll(ABS_MEDIA)) addMedia(m[0], 'script');
  for (const m of unescaped.matchAll(REL_MEDIA)) addMedia(m[1], 'script');

  const title =
    $('meta[property="og:title"]').attr('content')?.trim() ||
    $('title').first().text().trim() ||
    $('h1').first().text().trim() ||
    '';
  const thumb =
    resolveUrl($('meta[property="og:image"]').attr('content'), base) ??
    resolveUrl($('video[poster]').first().attr('poster'), base);

  return {
    title,
    thumb,
    media: [...media.values()],
    embeds: [...embeds],
    frames: [...frames],
    links: [...links],
    hasPlayerHints: PLAYER_HINT.test(html),
  };
}

function walkJsonLd(node, visit) {
  if (Array.isArray(node)) return node.forEach((n) => walkJsonLd(n, visit));
  if (!node || typeof node !== 'object') return;
  const type = [].concat(node['@type'] ?? []);
  if (type.includes('VideoObject')) visit(node);
  for (const value of Object.values(node)) if (value && typeof value === 'object') walkJsonLd(value, visit);
}
