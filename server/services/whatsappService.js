const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

class WhatsAppService {
  constructor() {
    this.enabled = process.env.WHATSAPP_ENABLED !== 'false';
    this.apiUrl = process.env.WHATSAPP_API_URL || 'http://localhost:5050/whapi/send.php';
    this.apiKey = process.env.WHATSAPP_API_KEY;
    this.waid = process.env.WHATSAPP_WAID;
    this.targetId = process.env.WHATSAPP_TARGET_ID || '120363409783916376@g.us';
  }

  /**
   * Cleans up markdown characters and formats text for WhatsApp.
   */
  formatMessage(text) {
    if (!text) return '';
    // Telegram uses \* or \_ escaping, WhatsApp uses standard *bold* and _italic_
    return String(text).replace(/\\([_*~`])/g, '$1');
  }

  /**
   * Sends a text notification message to the configured WhatsApp group / number.
   */
  async sendNotification(text) {
    try {
      const enabled = process.env.WHATSAPP_ENABLED !== 'false';
      if (!enabled) return;

      const apiKey = process.env.WHATSAPP_API_KEY || this.apiKey;
      const waid = process.env.WHATSAPP_WAID || this.waid;
      const targetId = process.env.WHATSAPP_TARGET_ID || this.targetId;
      const apiUrl = process.env.WHATSAPP_API_URL || this.apiUrl;

      if (!apiKey || !targetId) {
        console.warn('[WHATSAPP SERVICE] WhatsApp credentials not configured. Notification skipped.');
        return;
      }

      const formattedText = this.formatMessage(text);
      return this._sendJsonPost({
        number: targetId,
        message: formattedCaptionOrText(formattedText),
        waid: waid,
        apikey: apiKey
      }, apiKey, apiUrl);
    } catch (err) {
      console.error('[WHATSAPP SERVICE] Unexpected exception in sendNotification:', err.message);
    }
  }

  /**
   * Sends a photo/image with caption (supports both URL and local file paths as Base64).
   */
  async sendPhoto(photoInput, caption) {
    try {
      const enabled = process.env.WHATSAPP_ENABLED !== 'false';
      if (!enabled) return;

      if (!photoInput) {
        return this.sendNotification(caption);
      }

      const apiKey = process.env.WHATSAPP_API_KEY || this.apiKey;
      const waid = process.env.WHATSAPP_WAID || this.waid;
      const targetId = process.env.WHATSAPP_TARGET_ID || this.targetId;
      const apiUrl = process.env.WHATSAPP_API_URL || this.apiUrl;

      if (!apiKey || !targetId) {
        console.warn('[WHATSAPP SERVICE] WhatsApp credentials not configured. Photo skipped.');
        return;
      }

      let imagePayload = null;

      // Case 1: Public HTTP / HTTPS URL
      if (typeof photoInput === 'string' && (photoInput.startsWith('http://') || photoInput.startsWith('https://'))) {
        imagePayload = photoInput;
      } else {
        // Case 2: Local file path -> Base64 Data URI
        let absolutePath = photoInput;
        if (typeof photoInput === 'string' && !path.isAbsolute(photoInput)) {
          const possiblePaths = [
            path.resolve(__dirname, '..', '..', 'public', photoInput.replace(/^\//, '')),
            path.resolve(__dirname, '..', '..', photoInput.replace(/^\//, ''))
          ];
          for (const p of possiblePaths) {
            if (fs.existsSync(p)) {
              absolutePath = p;
              break;
            }
          }
        }

        if (fs.existsSync(absolutePath)) {
          try {
            const ext = path.extname(absolutePath).toLowerCase().replace('.', '') || 'jpeg';
            const mimeType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
            const fileBuffer = fs.readFileSync(absolutePath);
            imagePayload = `data:${mimeType};base64,${fileBuffer.toString('base64')}`;
          } catch (readErr) {
            console.warn('[WHATSAPP SERVICE] Error reading local image file, falling back to text:', readErr.message);
          }
        }
      }

      if (!imagePayload) {
        return this.sendNotification(caption);
      }

      const formattedCaption = this.formatMessage(caption);

      return this._sendJsonPost({
        number: targetId,
        image: imagePayload,
        media_url: imagePayload.startsWith('http') ? imagePayload : undefined,
        message: formattedCaption,
        caption: formattedCaption,
        waid: waid,
        apikey: apiKey
      }, apiKey, apiUrl);

    } catch (err) {
      console.error('[WHATSAPP SERVICE] Photo send exception, falling back to text:', err.message);
      return this.sendNotification(caption);
    }
  }

  /**
   * Internal helper: Sends JSON POST request to WhatsApp Gateway.
   */
  _sendJsonPost(payloadObj, apiKey, apiUrl) {
    return new Promise((resolve) => {
      try {
        const rawUrl = apiUrl || this.apiUrl;
        const postEndpoint = rawUrl;
        const targetUrl = new URL(postEndpoint);
        const payloadString = JSON.stringify(payloadObj);

        const options = {
          hostname: targetUrl.hostname,
          port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
          path: targetUrl.pathname + (targetUrl.search || ''),
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
            'Content-Length': Buffer.byteLength(payloadString)
          }
        };

        const client = targetUrl.protocol === 'https:' ? https : http;
        const req = client.request(options, (res) => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              console.log('[WHATSAPP SERVICE] Notification sent successfully to group.');
            } else {
              // If /api/send returned 404, fallback to send.php with query params
              if (res.statusCode === 404 && !rawUrl.includes('/api/send')) {
                return this._sendGetFallback(rawUrl, payloadObj, apiKey).then(resolve);
              }
              console.warn(`[WHATSAPP SERVICE] Gateway returned status ${res.statusCode}: ${data.substring(0, 200)}`);
            }
            resolve();
          });
        });

        req.on('error', (err) => {
          console.error('[WHATSAPP SERVICE] Error sending request:', err.message);
          // Fallback to GET on send.php if POST fails
          this._sendGetFallback(rawUrl, payloadObj, apiKey).then(resolve);
        });

        req.setTimeout(10000, () => {
          req.destroy();
          console.warn('[WHATSAPP SERVICE] Request timed out (10s).');
          resolve();
        });

        req.write(payloadString);
        req.end();

      } catch (err) {
        console.error('[WHATSAPP SERVICE] Request construction failed:', err.message);
        resolve();
      }
    });
  }

  /**
   * Internal fallback helper: Sends GET request to send.php
   */
  _sendGetFallback(apiUrl, payloadObj, apiKey) {
    return new Promise((resolve) => {
      try {
        const urlObj = new URL(apiUrl);
        urlObj.searchParams.set('apikey', apiKey);
        if (payloadObj.waid) urlObj.searchParams.set('waid', payloadObj.waid);
        urlObj.searchParams.set('number', payloadObj.number);
        urlObj.searchParams.set('message', payloadObj.message || payloadObj.caption || '');
        if (payloadObj.image && payloadObj.image.startsWith('http')) {
          urlObj.searchParams.set('image', payloadObj.image);
        }

        const client = urlObj.protocol === 'https:' ? https : http;
        const req = client.get(urlObj.toString(), (res) => {
          res.on('data', () => {});
          res.on('end', () => resolve());
        });
        req.on('error', () => resolve());
        req.setTimeout(6000, () => { req.destroy(); resolve(); });
      } catch (e) {
        resolve();
      }
    });
  }
}

function formattedCaptionOrText(text) {
  return text || '';
}

module.exports = new WhatsAppService();
