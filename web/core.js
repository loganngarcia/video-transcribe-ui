export function endpointURL(value) {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) throw new Error('Use HTTPS for a hosted reader, or HTTP with localhost. Do not include a key in the address.');
  return url.href.replace(/\/$/, '');
}
export const wordCount = text => text.trim() ? text.trim().split(/\s+/).length : 0;
export const clock = seconds => `${Math.floor(seconds/60)}:${String(Math.floor(seconds%60)).padStart(2,'0')}`;
export const videoType = name => ({mp4:'video/mp4',mov:'video/quicktime',webm:'video/webm',avi:'video/x-msvideo'}[name.split('.').pop().toLowerCase()] || '');
