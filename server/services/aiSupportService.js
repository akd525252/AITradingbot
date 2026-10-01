const https = require('https');
const { getDB } = require('../db');

let botUserId = null;

// Initialize bot user in database
async function initSupportBotUser() {
  try {
    const db = await getDB();
    let botUser = await db.get("SELECT id FROM users WHERE username = 'GainEX AI Bot' LIMIT 1");
    if (!botUser) {
      const bcrypt = require('bcryptjs');
      const salt = await bcrypt.genSalt(10);
      const hash = await bcrypt.hash(Math.random().toString(36), salt);
      const result = await db.run(
        `INSERT INTO users (username, password_hash, role, invite_code, email) 
         VALUES ('GainEX AI Bot', ?, 'employee', 'AIBOTCHAT', 'support_bot@gainex.com')`,
        [hash]
      );
      botUserId = result.lastID;
      console.log(`[AI-SUPPORT-BOT] Bot user created with ID ${botUserId}`);
    } else {
      botUserId = botUser.id;
      console.log(`[AI-SUPPORT-BOT] Bot user found with ID ${botUserId}`);
    }
  } catch (err) {
    console.error('[AI-SUPPORT-BOT] Error initializing bot user:', err.message);
  }
}

// Make https POST request to Gemini API with automatic fallback options
function postToGemini(apiKey, payload) {
  const attempts = [
    `/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`,
    `/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${apiKey}`,
    `/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    `/v1beta/models/gemini-3.7-flash:generateContent?key=${apiKey}`
  ];

  let currentAttempt = 0;

  function tryRequest(path) {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify(payload);
      const options = {
        hostname: 'generativelanguage.googleapis.com',
        port: 443,
        path: path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch (e) {
              reject(new Error('Failed to parse Gemini response: ' + e.message));
            }
          } else {
            reject({ statusCode: res.statusCode, data: data });
          }
        });
      });

      req.on('error', (e) => reject(e));
      req.write(postData);
      req.end();
    });
  }

  return new Promise((resolve, reject) => {
    function runNext() {
      const path = attempts[currentAttempt];
      console.log(`[AI-SUPPORT-BOT] Querying Gemini (Attempt ${currentAttempt + 1}/${attempts.length}) path: ${path.split('?')[0]}`);
      tryRequest(path)
        .then(resolve)
        .catch((err) => {
          console.warn(`[AI-SUPPORT-BOT] Attempt ${currentAttempt + 1} failed: ${err.message || JSON.stringify(err)}`);
          currentAttempt++;
          if (currentAttempt < attempts.length) {
            // For gemini-pro, systemInstruction might not be supported in the same payload format, so we can clean it if needed
            if (attempts[currentAttempt].includes('gemini-pro') && payload.systemInstruction) {
              // Convert systemInstruction to prompt text prefix
              const newPayload = JSON.parse(JSON.stringify(payload));
              const instrText = newPayload.systemInstruction.parts[0].text;
              newPayload.contents[0].parts[0].text = `${instrText}\n\nUser Message:\n${newPayload.contents[0].parts[0].text}`;
              delete newPayload.systemInstruction;
              payload = newPayload;
            }
            runNext();
          } else {
            reject(new Error(err.data || err.message || 'All Gemini API attempts failed.'));
          }
        });
    }
    runNext();
  });
}

// Main background message handler
async function handleUserMessage(conversationId, incomingMessage, user) {
  // Run asynchronously in background
  setTimeout(async () => {
    try {
      const db = await getDB();
      
      // 1. Check if AI bot is globally enabled
      const enabledRow = await db.get("SELECT value FROM settings WHERE key = 'aibot_support_enabled'");
      const enabled = enabledRow ? enabledRow.value === 'true' : true;
      if (!enabled) return;

      // Ensure bot user ID is loaded
      if (!botUserId) {
        await initSupportBotUser();
        if (!botUserId) return;
      }

      // 2. Verify conversation assignment and status
      const conv = await db.get("SELECT status, assigned_to FROM conversations WHERE id = ? AND type = 'support'", [conversationId]);
      if (!conv || conv.status === 'closed' || conv.status === 'resolved') {
        return;
      }
      if (conv.assigned_to !== null && Number(conv.assigned_to) !== Number(botUserId)) {
        // Disconnect: Do not reply if assigned to another human agent
        return;
      }

      // Check for manual transfer keywords in incoming message text
      const lowerText = (incomingMessage.text || '').toLowerCase();
      const needsTransfer = lowerText.includes('transfer') || 
                            lowerText.includes('talk to human') || 
                            lowerText.includes('talk to agent') || 
                            lowerText.includes('talk to person') || 
                            lowerText.includes('live support') || 
                            lowerText.includes('human agent') ||
                            lowerText.includes('connect me');

      if (needsTransfer) {
        const transferText = "I will transfer you to a human support agent now. Please wait, they will be with you shortly.";
        
        // Update database: status = 'waiting', assigned_to = null
        await db.run(
          `UPDATE conversations SET status = 'waiting', assigned_to = NULL, last_message_text = ?, last_message_at = NOW(), updated_at = NOW() WHERE id = ?`,
          [transferText.substring(0, 100), conversationId]
        );

        // Save message to DB
        await db.run(
          `INSERT INTO chat_messages (conversation_id, sender_id, text, delivered_at) VALUES ($1,$2,$3,NOW())`,
          [conversationId, botUserId, transferText]
        );

        const botMessageRow = await db.get(
          `SELECT m.*, 'GainEX AI Bot' as sender_name, true as is_staff 
           FROM chat_messages m 
           WHERE m.conversation_id = ? AND m.sender_id = ? 
           ORDER BY m.created_at DESC LIMIT 1`,
          [conversationId, botUserId]
        );

        // Broadcast via Ably
        if (process.env.ABLY_API_KEY) {
          const Ably = require('ably');
          const ablyRest = new Ably.Rest({ key: process.env.ABLY_API_KEY });
          ablyRest.channels.get(`support:conversation:${conversationId}`).publish('message', {
            ...botMessageRow,
            is_staff: true,
            is_bot: true,
            sender_name: 'GainEX AI Bot'
          });
          ablyRest.channels.get(`support:conversation:${conversationId}`).publish('status_update', {
            status: 'waiting',
            assignedTo: null
          });
          ablyRest.channels.get('support:queue').publish('conversation_updated', {
            conversationId,
            status: 'waiting',
            assignedTo: null,
            transferredFromBot: true
          });
          ablyRest.channels.get('support:queue').publish('message_update', {
            conversationId,
            lastMessage: transferText,
            updatedAt: new Date().toISOString(),
            status: 'waiting'
          });
        }
        console.log(`[AI-SUPPORT-BOT] Handed over conversation #${conversationId} to human agent.`);
        return;
      }

      // Start typing indicator immediately and repeat it every 2s
      let typingInterval = null;
      if (process.env.ABLY_API_KEY) {
        try {
          const Ably = require('ably');
          const ablyRest = new Ably.Rest({ key: process.env.ABLY_API_KEY });
          const channel = ablyRest.channels.get(`support:conversation:${conversationId}`);
          channel.publish('typing', { userId: botUserId, isBot: true });
          typingInterval = setInterval(() => {
            channel.publish('typing', { userId: botUserId, isBot: true });
          }, 2000);
        } catch (ablyErr) {
          console.warn('[AI-SUPPORT-BOT] Error starting typing indicator:', ablyErr.message);
        }
      }

      try {
        // 3. Fetch Gemini API Key
        const keyRow = await db.get("SELECT value FROM settings WHERE key = 'gemini_api_key'");
        const apiKey = (keyRow && keyRow.value) ? keyRow.value.trim() : (process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.trim() : null);
        if (!apiKey) {
          console.warn('[AI-SUPPORT-BOT] Gemini API key not found in settings or environment.');
          return;
        }

        // 4. Fetch instructions
        const instrRow = await db.get("SELECT value FROM settings WHERE key = 'aibot_support_instructions'");
        const instructions = instrRow ? instrRow.value : 'You are GainEX AI Support Bot. Answer user questions politely, using their data if needed. Do not expose other users\' data.';

        // 5. Gather user account data (strictly scoped to this user only)
        const fullUser = await db.get("SELECT id, username, email, full_name, balance, status, kyc_status, created_at FROM users WHERE id = ?", [user.id]);
        const userProfile = fullUser || user;
        const kycStatus = userProfile.kyc_status || 'not_submitted';

        // Last 10 Trades
        const trades = await db.all(
          "SELECT coin, direction, amount, open_price, close_price, status, created_at FROM trades WHERE user_id = ? ORDER BY created_at DESC LIMIT 10",
          [user.id]
        );
        const tradesStr = trades.length > 0 
          ? trades.map(t => `- ${t.created_at}: Trade ${t.amount} USD on ${t.coin} (${t.direction.toUpperCase()}). Status: ${t.status}. Open Price: ${t.open_price}, Close Price: ${t.close_price || 'N/A'}`).join('\n')
          : 'No trades recorded.';

        // Last 10 Deposits
        const deposits = await db.all(
          "SELECT amount, status, method, created_at FROM deposits WHERE user_id = ? ORDER BY created_at DESC LIMIT 10",
          [user.id]
        );
        const depositsStr = deposits.length > 0
          ? deposits.map(d => `- ${d.created_at}: Deposit of ${d.amount} USD via ${d.method}. Status: ${d.status}`).join('\n')
          : 'No deposits recorded.';

        // Last 10 Withdrawals
        const withdrawals = await db.all(
          "SELECT amount, status, method, created_at FROM withdrawals WHERE user_id = ? ORDER BY created_at DESC LIMIT 10",
          [user.id]
        );
        const withdrawalsStr = withdrawals.length > 0
          ? withdrawals.map(w => `- ${w.created_at}: Withdrawal of ${w.amount} USD via ${w.method}. Status: ${w.status}`).join('\n')
          : 'No withdrawals recorded.';

        // 6. Retrieve chat history
        const chatMessages = await db.all(
          `SELECT m.sender_id, m.text, m.created_at, u.username as sender_name, (u.role IN ('admin','employee')) as is_staff
           FROM chat_messages m
           LEFT JOIN users u ON m.sender_id = u.id
           WHERE m.conversation_id = ? AND m.is_deleted = false
           ORDER BY m.created_at DESC LIMIT 15`,
          [conversationId]
        );
        // Chronological order
        chatMessages.reverse();

        const historyStr = chatMessages.map(m => {
          const name = m.sender_id === botUserId ? 'GainEX AI Bot' : m.sender_name || 'User';
          return `${name}: ${m.text}`;
        }).join('\n');

        // 7. Construct system instructions & user prompt
        const systemInstructionText = `
${instructions}

YOU HAVE ACCESS TO THE CHATTING USER'S PROFILE AND TRANSACTION DATA BELOW. 
YOU MUST NOT DISCLOSE DATA BELONGING TO OTHER USERS. 
IF THE USER ASKS ABOUT THEIR BALANCE, STATUS, OR RECENT TRANSACTIONS, REFER TO THE INFORMATION BELOW:

User Profile:
- User ID: ${userProfile.id}
- Username: ${userProfile.username}
- Full Name: ${userProfile.full_name || 'N/A'}
- Email: ${userProfile.email}
- Account Balance: $${userProfile.balance} USD
- Account Status: ${userProfile.status || 'Active'}
- KYC Verification Status: ${kycStatus}
- Registration Date: ${userProfile.created_at}

User Recent Trades (Last 10):
${tradesStr}

User Recent Deposits (Last 10):
${depositsStr}

User Recent Withdrawals (Last 10):
${withdrawalsStr}

Keep your responses concise, helpful, and professional. Speak directly to the user.
IF THE USER WANTS TO TALK TO A HUMAN AGENT/REPRESENTATIVE, OR IF YOU ARE UNABLE TO HELP THEM WITH THEIR REQUEST, YOU MUST END YOUR RESPONSE WITH THE EXACT STRING: [TRANSFER_TO_AGENT].
`;

        const promptText = `
Below is the recent chat history for this conversation. Please generate the next response as GainEX AI Bot.

Chat History:
${historyStr}

GainEX AI Bot:`;

        // 8. Call Gemini API
        let payload = {
          contents: [{
            parts: [{ text: promptText }]
          }],
          systemInstruction: {
            parts: [{ text: systemInstructionText }]
          },
          generationConfig: {
            maxOutputTokens: 500,
            temperature: 0.7
          }
        };

        console.log(`[AI-SUPPORT-BOT] Querying Gemini for conversation #${conversationId}...`);
        const responseData = await postToGemini(apiKey, payload);
        
        let botResponseText = '';
        if (responseData.candidates && responseData.candidates[0] && responseData.candidates[0].content && responseData.candidates[0].content.parts[0]) {
          botResponseText = responseData.candidates[0].content.parts[0].text.trim();
        }

        if (!botResponseText) {
          console.warn('[AI-SUPPORT-BOT] Gemini returned empty response contents.');
          return;
        }

        // Check one more time before inserting to ensure admin did not accept in the meantime
        const finalCheck = await db.get("SELECT status, assigned_to FROM conversations WHERE id = ? AND type = 'support'", [conversationId]);
        if (!finalCheck || finalCheck.status === 'closed' || finalCheck.status === 'resolved') {
          return;
        }
        if (finalCheck.assigned_to !== null && Number(finalCheck.assigned_to) !== Number(botUserId)) {
          return;
        }

        // Handle AI-driven transfer response
        let isTransferResponse = false;
        if (botResponseText.includes('[TRANSFER_TO_AGENT]')) {
          isTransferResponse = true;
          botResponseText = botResponseText.replace('[TRANSFER_TO_AGENT]', '').trim();
          if (!botResponseText) {
            botResponseText = "I will transfer you to a human support agent now. Please wait, they will be with you shortly.";
          }
        }

        const statusToSet = isTransferResponse ? 'waiting' : 'assigned';
        const assignedToToSet = isTransferResponse ? null : botUserId;

        // 9. Save bot reply to database
        await db.run(
          `INSERT INTO chat_messages (conversation_id, sender_id, text, delivered_at) VALUES ($1,$2,$3,NOW())`,
          [conversationId, botUserId, botResponseText]
        );

        const botMessageRow = await db.get(
          `SELECT m.*, 'GainEX AI Bot' as sender_name, true as is_staff 
           FROM chat_messages m 
           WHERE m.conversation_id = ? AND m.sender_id = ? 
           ORDER BY m.created_at DESC LIMIT 1`,
          [conversationId, botUserId]
        );

        // Update conversation status and last message
        await db.run(
          `UPDATE conversations SET status = ?, assigned_to = ?, last_message_text = ?, last_message_at = NOW(), updated_at = NOW() WHERE id = ?`,
          [statusToSet, assignedToToSet, botResponseText.substring(0, 100), conversationId]
        );

        // 10. Broadcast via Ably
        if (process.env.ABLY_API_KEY) {
          const Ably = require('ably');
          const ablyRest = new Ably.Rest({ key: process.env.ABLY_API_KEY });
          ablyRest.channels.get(`support:conversation:${conversationId}`).publish('message', {
            ...botMessageRow,
            is_staff: true,
            is_bot: true,
            sender_name: 'GainEX AI Bot'
          });

          if (isTransferResponse) {
            ablyRest.channels.get(`support:conversation:${conversationId}`).publish('status_update', {
              status: 'waiting',
              assignedTo: null
            });
            ablyRest.channels.get('support:queue').publish('conversation_updated', {
              conversationId,
              status: 'waiting',
              assignedTo: null,
              transferredFromBot: true
            });
          }

          ablyRest.channels.get('support:queue').publish('message_update', {
            conversationId,
            lastMessage: botResponseText,
            updatedAt: new Date().toISOString(),
            status: statusToSet
          });
        }
        console.log(`[AI-SUPPORT-BOT] Replied successfully to conversation #${conversationId}`);
      } catch (e) {
        console.error('[AI-SUPPORT-BOT] Error during handling message:', e.message);
      } finally {
        if (typingInterval) {
          clearInterval(typingInterval);
        }
      }
    } catch (e) {
      console.error('[AI-SUPPORT-BOT] Error during handling message setup:', e.message);
    }
  }, 1000); // 1 second delay to simulate typing and natural flow
}

module.exports = {
  initSupportBotUser,
  handleUserMessage
};
