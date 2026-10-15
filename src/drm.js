// Services whose catalogue is DRM-encrypted (Widevine/PlayReady/FairPlay). vidgrab refuses them
// up front instead of crawling for nothing; yt-dlp's own DRM errors are caught later as well.
const DRM_HOSTS = [
  'netflix.com',
  'disneyplus.com',
  'primevideo.com',
  'max.com',
  'hbomax.com',
  'hulu.com',
  'tv.apple.com',
  'music.apple.com',
  'paramountplus.com',
  'peacocktv.com',
  'canalplus.com',
  'mycanal.fr',
  'crunchyroll.com',
  'spotify.com',
  'deezer.com',
  'tidal.com',
  'starz.com',
  'skyshowtime.com',
  'dazn.com',
  'sling.com',
  'fubo.tv',
  'molotov.tv',
  'ocs.fr',
];

export function isDrmService(u) {
  let url;
  try {
    url = new URL(u);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (DRM_HOSTS.some((d) => host === d || host.endsWith(`.${d}`))) return true;
  return /(^|\.)amazon\.[a-z.]+$/.test(host) && url.pathname.startsWith('/gp/video');
}

export const isDrmError = (msg) => /\bDRM\b|widevine|playready|fairplay/i.test(msg ?? '');
