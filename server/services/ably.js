const Ably = require('ably');

let restClient = null;

function getAblyClient() {
  if (!restClient && process.env.ABLY_API_KEY) {
    restClient = new Ably.Rest({ key: process.env.ABLY_API_KEY });
  }
  return restClient;
}

/**
 * Generates an Ably Token Request for a specific client (authenticated user)
 * @param {string|number} clientId - The user's unique ID
 * @returns {Promise<object>} Token Request object to be sent to client
 */
async function generateTokenRequest(clientId) {
  const client = getAblyClient();
  if (!client) {
    throw new Error('Ably API Key is missing. Ensure ABLY_API_KEY is configured in your .env file.');
  }
  
  return new Promise((resolve, reject) => {
    client.auth.createTokenRequest({ clientId: String(clientId) }, (err, tokenRequest) => {
      if (err) {
        console.error('[ABLY AUTH ERROR] Failed to create token request:', err);
        reject(err);
      } else {
        resolve(tokenRequest);
      }
    });
  });
}

module.exports = { generateTokenRequest };
