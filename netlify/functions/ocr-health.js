import { GoogleAuth } from 'google-auth-library';
import axios from 'axios';

function jsonResponse(statusCode, payload) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

function safeDetailFromError(err) {
  try {
    const msg =
      (err && err.response && err.response.data && err.response.data.error && err.response.data.error.message) ||
      (err && err.message) ||
      'vision_api_error';
    const s = String(msg)
      .replace(/\n/g, ' ')
      .replace(/private_key/gi, 'redacted');
    return s.length > 400 ? s.slice(0, 400) : s;
  } catch (_) {
    return 'vision_api_error';
  }
}

export async function handler() {
  try {
    const raw = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (!raw || String(raw).trim() === '') {
      return jsonResponse(500, {
        ok: false,
        step: 'env',
        error: 'missing_GOOGLE_APPLICATION_CREDENTIALS_JSON',
      });
    }

    let credentials;
    try {
      credentials = JSON.parse(raw);
    } catch (_) {
      return jsonResponse(500, {
        ok: false,
        step: 'parse',
        error: 'invalid_credentials_json',
      });
    }

    const required = ['type', 'project_id', 'private_key', 'client_email', 'token_uri'];
    const missing = required.filter((k) => !credentials[k] || String(credentials[k]).trim() === '');
    if (missing.length) {
      return jsonResponse(500, {
        ok: false,
        step: 'validate',
        error: 'credentials_json_missing_fields',
      });
    }

    const auth = new GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/cloud-vision'],
    });

    let accessToken;
    try {
      const client = await auth.getClient();
      const t = await client.getAccessToken();
      accessToken = typeof t === 'string' ? t : (t && t.token) || null;
    } catch (e) {
      return jsonResponse(500, {
        ok: false,
        step: 'vision',
        error: 'vision_call_failed',
        detail: safeDetailFromError(e),
      });
    }

    if (!accessToken) {
      return jsonResponse(500, {
        ok: false,
        step: 'vision',
        error: 'vision_call_failed',
        detail: 'failed_to_obtain_access_token',
      });
    }

    // Minimal Vision call using a 1x1 PNG (no secrets)
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAAWgmWQ0AAAAASUVORK5CYII=';
    const payload = {
      requests: [
        {
          image: { content: base64 },
          features: [{ type: 'TEXT_DETECTION', maxResults: 1 }],
        },
      ],
    };

    try {
      const response = await axios.post('https://vision.googleapis.com/v1/images:annotate', payload, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      });

      if (response.status === 200) {
        return jsonResponse(200, { ok: true });
      }

      return jsonResponse(500, {
        ok: false,
        step: 'vision',
        error: 'vision_call_failed',
        detail: `status ${response.status} ${response.statusText || ''}`.trim(),
      });
    } catch (err) {
      return jsonResponse(500, {
        ok: false,
        step: 'vision',
        error: 'vision_call_failed',
        detail: safeDetailFromError(err),
      });
    }
  } catch (err) {
    return jsonResponse(500, {
      ok: false,
      step: 'catch',
      error: 'unhandled_exception',
      detail: safeDetailFromError(err),
    });
  }
}
