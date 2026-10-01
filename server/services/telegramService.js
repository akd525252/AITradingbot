const https = require('https');
const fs = require('fs');
const path = require('path');

class TelegramService {
  constructor() {
    this.token = process.env.TELEGRAM_BOT_TOKEN;
    this.chatId = process.env.TELEGRAM_CHAT_ID;
  }

  escapeMarkdown(text) {
    if (typeof text !== 'string' && text !== null && text !== undefined) {
      text = String(text);
    }
    if (!text) return '';
    return text.replace(/([\\_*\[`])/g, '\\$1');
  }

  sendNotification(text) {
    const token = this.token || process.env.TELEGRAM_BOT_TOKEN;
    const chatId = this.chatId || process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
      console.warn('[TELEGRAM SERVICE] Telegram credentials not configured. Notification skipped.');
      return Promise.resolve();
    }

    // Attempt 1: Send with Markdown. Fallback to plain text if Markdown parsing fails.
    return this._sendTextMessage(token, chatId, text, 'Markdown')
      .catch(err => {
        console.warn('[TELEGRAM SERVICE] Markdown formatting failed, retrying plain text:', err.message);
        return this._sendTextMessage(token, chatId, text, null);
      });
  }

  _sendTextMessage(token, chatId, text, parseMode) {
    const payloadObj = {
      chat_id: chatId,
      text: text
    };
    if (parseMode) payloadObj.parse_mode = parseMode;
    const payload = JSON.stringify(payloadObj);

    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${token}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Status: ${res.statusCode}, Body: ${data}`));
          } else {
            console.log('[TELEGRAM SERVICE] Notification sent successfully.');
            resolve();
          }
        });
      });

      req.on('error', (err) => reject(err));
      req.write(payload);
      req.end();
    });
  }

  sendPhoto(photoInput, caption) {
    const token = this.token || process.env.TELEGRAM_BOT_TOKEN;
    const chatId = this.chatId || process.env.TELEGRAM_CHAT_ID;

    if (!token || !chatId) {
      console.warn('[TELEGRAM SERVICE] Telegram credentials not configured. Photo skipped.');
      return Promise.resolve();
    }

    if (!photoInput) {
      return this.sendNotification(caption);
    }

    // Case 1: Photo is an HTTP or HTTPS URL (e.g. Supabase storage URL)
    if (typeof photoInput === 'string' && (photoInput.startsWith('http://') || photoInput.startsWith('https://'))) {
      return this._sendPhotoUrl(token, chatId, photoInput, caption, 'Markdown')
        .catch(err => {
          console.warn('[TELEGRAM SERVICE] Photo URL Markdown failed, retrying plain caption:', err.message);
          return this._sendPhotoUrl(token, chatId, photoInput, caption, null);
        })
        .catch(err => {
          console.error('[TELEGRAM SERVICE] Photo URL send failed, falling back to text notification:', err.message);
          return this.sendNotification(caption);
        });
    }

    // Case 2: Local file path
    let absolutePath = photoInput;
    if (typeof photoInput === 'string' && !path.isAbsolute(photoInput)) {
      absolutePath = path.resolve(__dirname, '..', '..', 'public', photoInput.replace(/^\//, ''));
    }

    if (!fs.existsSync(absolutePath)) {
      console.warn('[TELEGRAM SERVICE] File does not exist at path:', absolutePath, 'Falling back to text notification.');
      return this.sendNotification(caption);
    }

    return this._sendPhotoFile(token, chatId, absolutePath, caption, 'Markdown')
      .catch(err => {
        console.warn('[TELEGRAM SERVICE] Photo file Markdown failed, retrying plain caption:', err.message);
        return this._sendPhotoFile(token, chatId, absolutePath, caption, null);
      })
      .catch(err => {
        console.error('[TELEGRAM SERVICE] Photo file send failed, falling back to text notification:', err.message);
        return this.sendNotification(caption);
      });
  }

  _sendPhotoUrl(token, chatId, photoUrl, caption, parseMode) {
    const payloadObj = {
      chat_id: chatId,
      photo: photoUrl
    };
    if (caption) payloadObj.caption = caption;
    if (parseMode) payloadObj.parse_mode = parseMode;
    const payload = JSON.stringify(payloadObj);

    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${token}/sendPhoto`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Status: ${res.statusCode}, Body: ${data}`));
          } else {
            console.log('[TELEGRAM SERVICE] Photo URL sent successfully.');
            resolve();
          }
        });
      });

      req.on('error', (err) => reject(err));
      req.write(payload);
      req.end();
    });
  }

  _sendPhotoFile(token, chatId, filePath, caption, parseMode) {
    return new Promise((resolve, reject) => {
      const boundary = '----TelegramBotBoundary' + Math.random().toString(36).substring(2);
      const filename = path.basename(filePath);
      const fileBuffer = fs.readFileSync(filePath);

      let header = `--${boundary}\r\n`;
      header += `Content-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`;

      if (caption) {
        header += `--${boundary}\r\n`;
        header += `Content-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`;
        if (parseMode) {
          header += `--${boundary}\r\n`;
          header += `Content-Disposition: form-data; name="parse_mode"\r\n\r\n${parseMode}\r\n`;
        }
      }

      header += `--${boundary}\r\n`;
      header += `Content-Disposition: form-data; name="photo"; filename="${filename}"\r\n`;
      header += `Content-Type: image/jpeg\r\n\r\n`;

      const footer = `\r\n--${boundary}--\r\n`;

      const payload = Buffer.concat([
        Buffer.from(header, 'utf-8'),
        fileBuffer,
        Buffer.from(footer, 'utf-8')
      ]);

      const options = {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${token}/sendPhoto`,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': payload.length
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Status: ${res.statusCode}, Body: ${data}`));
          } else {
            console.log('[TELEGRAM SERVICE] Photo file sent successfully.');
            resolve();
          }
        });
      });

      req.on('error', (err) => reject(err));
      req.write(payload);
      req.end();
    });
  }
}

module.exports = new TelegramService();
