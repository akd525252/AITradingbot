const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID || '9585c884-001d-42f2-8c59-31205c199ec8';
const ONESIGNAL_REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY;

/**
 * Sends a background push notification to a user using their database User ID as the OneSignal external_id.
 * 
 * @param {number|string} userId The database user ID of the recipient
 * @param {string} title The notification title
 * @param {string} body The notification body content
 */
async function sendPushNotification(userId, title, body) {
  if (!ONESIGNAL_REST_API_KEY) {
    console.warn('[ONESIGNAL] ONESIGNAL_REST_API_KEY is not defined in environment. Skipping push notification.');
    return;
  }

  try {
    const payload = {
      app_id: ONESIGNAL_APP_ID,
      headings: { en: title },
      contents: { en: body },
      // Target the user's external ID (set during client login)
      include_aliases: {
        external_id: [String(userId)]
      },
      // Target also via custom tag filters for fallback compatibility
      filters: [
        { field: 'tag', key: 'userId', relation: '=', value: String(userId) }
      ],
      target_channel: 'push'
    };

    const response = await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Basic ${ONESIGNAL_REST_API_KEY}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[ONESIGNAL ERROR] Failed to send push notification to user #${userId}. Response:`, errorText);
    } else {
      const resData = await response.json();
      console.log(`[ONESIGNAL SUCCESS] Push notification sent to user #${userId}:`, resData);
    }
  } catch (err) {
    console.error(`[ONESIGNAL EXCEPTION] Failed to execute push notification for user #${userId}:`, err);
  }
}

module.exports = { sendPushNotification };
