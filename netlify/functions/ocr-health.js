import { GoogleAuth } from 'google-auth-library';
import axios from 'axios';

export async function handler() {
  try {
    const raw = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (!raw) {
      return {
        statusCode: 400,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ok: false, error: 'Missing GOOGLE_APPLICATION_CREDENTIALS_JSON' }),
      };
    }

    let credentials;
    try {
      credentials = JSON.parse(raw);
    } catch (_) {
      return {
        statusCode: 400,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ok: false, error: 'Invalid credentials JSON' }),
      };
    }

    const auth = new GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });

    const client = await auth.getClient();
    const t = await client.getAccessToken();
    const accessToken = typeof t === 'string' ? t : (t && t.token) || null;
    if (!accessToken) {
      return {
        statusCode: 500,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ok: false, error: 'Unable to acquire access token' }),
      };
    }

    // 1x1 transparent PNG
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAAWgmWQ0AAAAASUVORK5CYII=';

    const payload = {
      requests: [
        {
          image: { content: base64 },
          features: [{ type: 'TEXT_DETECTION' }],
        },
      ],
    };

    const response = await axios.post('https://vision.googleapis.com/v1/images:annotate', payload, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });

    if (response.status === 200) {
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ok: true }),
      };
    }

    return {
      statusCode: response.status,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: false, error: `Vision API returned status ${response.status}` }),
    };
  } catch (err) {
    const message =
      (err && err.response && err.response.data && err.response.data.error && err.response.data.error.message) ||
      (err && err.message) ||
      'Unknown error';
    return {
      statusCode: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: false, error: message }),
    };
  }
}
