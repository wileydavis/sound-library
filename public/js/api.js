// Thin client for the Worker API.

async function j(res) {
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    // Usually a Cloudflare Access login page after the session expired.
    if (res.redirected || ct.includes('text/html')) throw new Error('Signed out — reload the page to sign in again.');
    throw new Error(`Unexpected response (${res.status})`);
  }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  get: (path) => fetch(path, { credentials: 'same-origin' }).then(j),
  post: (path, body) => fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(j),
  patch: (path, body) => fetch(path, { method: 'PATCH', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(j),
  del: (path) => fetch(path, { method: 'DELETE', credentials: 'same-origin' }).then(j),

  transcribe: (wavBytes) => fetch('/api/transcribe', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'audio/wav' }, body: wavBytes }).then(j),

  fileUrl: (key, { download = false, name = '' } = {}) =>
    `/api/file?key=${encodeURIComponent(key)}${download ? '&dl=1' : ''}${name ? `&name=${encodeURIComponent(name)}` : ''}`,
};

/** PUT with upload progress (fetch can't report upload progress). */
export function putWithProgress(url, body, contentType, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.withCredentials = true;
    if (contentType) xhr.setRequestHeader('content-type', contentType);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress && onProgress(e.loaded);
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.send(body);
  });
}

const SINGLE_LIMIT = 90 * 1024 * 1024;
const PART_SIZE = 50 * 1024 * 1024;

/** Upload a Blob to R2 under `key`, in parts if it's big. onProgress(bytesSent). */
export async function uploadBlob(key, blob, contentType, onProgress) {
  if (blob.size <= SINGLE_LIMIT) {
    return putWithProgress(`/api/put?key=${encodeURIComponent(key)}`, blob, contentType, onProgress);
  }
  const { uploadId } = await api.post('/api/upload/start', { key, contentType });
  const parts = [];
  try {
    for (let n = 1, off = 0; off < blob.size; n++, off += PART_SIZE) {
      const chunk = blob.slice(off, Math.min(blob.size, off + PART_SIZE));
      let attempt = 0;
      for (;;) {
        try {
          const part = await putWithProgress(
            `/api/upload/part?key=${encodeURIComponent(key)}&uploadId=${encodeURIComponent(uploadId)}&n=${n}`,
            chunk, 'application/octet-stream', (b) => onProgress && onProgress(off + b));
          parts.push({ partNumber: part.partNumber, etag: part.etag });
          break;
        } catch (e) {
          if (++attempt >= 3) throw e;
          await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
      }
    }
    return await api.post('/api/upload/finish', { key, uploadId, parts });
  } catch (e) {
    api.post('/api/upload/abort', { key, uploadId }).catch(() => {});
    throw e;
  }
}
