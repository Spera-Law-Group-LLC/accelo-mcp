const SAFE_HOST = /^(?:\[[a-f\d:]+\]|[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)*\.?)$/i;

export const redirectUriOrigin = (value) => {
  if (typeof value !== 'string' || value !== value.trim()) return null;
  try {
    const url = new URL(value);
    if ((url.protocol !== 'https:' &&
         !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) ||
        url.username || url.password || url.hash || !SAFE_HOST.test(url.hostname)) return null;
    return url.origin;
  } catch {
    return null;
  }
};
