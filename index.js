const express = require('express');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason,
    fetchLatestBaileysVersion,
    jidNormalizedUser,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode');
const axios = require('axios');
const fs = require('fs/promises');
const path = require('path');
const dayjs = require('dayjs');
const { v4: uuidv4 } = require('uuid');
const { createRedisClient, sendWebhook } = require('./shared');

require('dotenv').config();

const app = express();
app.use(express.json());

// --- Configuration ---
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const SESSIONS_DIR = path.join(__dirname, 'baileys_sessions'); 
const WORKER_ID = `whatsapp-web-${uuidv4()}`;

// --- Scaling Config ---
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
// **FIXED: 5 minutes is too long for a QR timeout. Set to 60 seconds.**
const QR_GENERATION_TIMEOUT_MS = 60 * 1000; 

// ... (Redis Client, In-Memory Storage, Middleware are all correct) ...
const redisClient = createRedisClient();
const activeClients = {};
const initializingSessions = {};
let cleanupLoop;
const apiKeyMiddleware = (req, res, next) => {
    const providedKey = req.headers['x-api-key'];
    if (!API_KEY || providedKey === API_KEY) return next();
    res.status(401).json({ error: 'Unauthorized' });
};
app.use(apiKeyMiddleware);

// --- Baileys Helper Functions ---

const cleanupClient = async (sessionId) => {
    const clientEntry = activeClients[sessionId];
    const initEntry = initializingSessions[sessionId];
    console.log(`[CLEANUP] Cleaning up session: ${sessionId}`);

    if (clientEntry) {
        try {
            clientEntry.sock.end(new Error('Inactive cleanup')); 
        } catch (e) {
            console.error(`[CLEANUP_ERROR] Failed to end Baileys socket ${sessionId}:`, e.message);
        }
    }
    if (initEntry) {
        clearTimeout(initEntry.timeoutId);
    }

    delete activeClients[sessionId];
    delete initializingSessions[sessionId];

    try {
        await redisClient.hDel('active_sessions', sessionId);
        console.log(`[REDIS] Confirmed deregistration of session ${sessionId}.`);
    } catch (e) {
        console.error(`[REDIS_ERROR] Failed to deregister session ${sessionId}:`, e.message);
    }
};

const createSessionClient = async (sessionId) => {
    console.log(`[SETUP] Creating Baileys client for session: ${sessionId}`);
    
    const sessionDir = path.join(SESSIONS_DIR, sessionId);
    await fs.mkdir(sessionDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    const { version } = await fetchLatestBaileysVersion();
    
    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['MyWebApp', 'Chrome', '1.0.0'],
    });

    // --- Setup Event Handlers ---

    // **IMPROVED: Connection Update Logic**
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        const sessionDir = path.join(SESSIONS_DIR, sessionId);

        if (qr) {
            console.log(`[QR] QR code received for ${sessionId}`);
            qrcode.toDataURL(qr, (err, url) => {
                if (err) return;
                if (initializingSessions[sessionId]) {
                    initializingSessions[sessionId].qr = qr;
                }
                sendWebhook('/qr-code-received', { sessionId, qrCodeUrl: url });
            });
        }

        if (connection === 'open') {
            console.log(`[READY] Client is ready for session: ${sessionId}`);
            if (initializingSessions[sessionId]) {
                clearTimeout(initializingSessions[sessionId].timeoutId);
            }
            activeClients[sessionId] = { sock, lastUsed: new Date() };
            delete initializingSessions[sessionId];

            try {
                await redisClient.hSet('active_sessions', sessionId, WORKER_ID);
                console.log(`[REDIS] Registered session ${sessionId} to WEB worker ${WORKER_ID}`);
            } catch (e) {
                console.error(`[REDIS_ERROR] Failed to register session ${sessionId}:`, e.message);
            }
            
            const phone = jidNormalizedUser(sock.user.id).split(':')[0].split('@')[0];
            sendWebhook('/connected', { sessionId, phone });
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect.error)?.output?.statusCode;
            
            // Remove from active list, as it's no longer active
            delete activeClients[sessionId];

            // Check if this was a fatal error
            if (statusCode === DisconnectReason.loggedOut) {
                console.log(`[AUTH_FAILURE] Device logged out: ${sessionId}. Cleaning up.`);
                sendWebhook('/disconnected', { sessionId, reason: 'logged_out' });
                
                // Clear from init list if it was there
                if(initializingSessions[sessionId]) {
                    clearTimeout(initializingSessions[sessionId].timeoutId);
                    delete initializingSessions[sessionId];
                }
                
                // Delete session files
                await fs.rm(sessionDir, { recursive: true, force: true });

            } else {
                // **THIS IS THE FIX**
                // Check if we are *supposed* to be running (i.e., we are still in the init map)
                // or if we were just cleaned up (in which case init map is empty)
                if (initializingSessions[sessionId]) {
                    console.log(`[RECONNECT] Connection closed (e.g., QR timeout). Retrying: ${sessionId}`);
                    
                    // We must restart the *entire* process, including the timeout
                    clearTimeout(initializingSessions[sessionId].timeoutId);
                    
                    const newTimeoutId = setTimeout(() => {
                        console.log(`[TIMEOUT] QR scan (retry) timeout for session: ${sessionId}`);
                        cleanupClient(sessionId); // This will kill the retry
                        sendWebhook('/qr-timeout', { sessionId });
                    }, QR_GENERATION_TIMEOUT_MS);
                    
                    initializingSessions[sessionId] = { qr: null, timeoutId: newTimeoutId };
                    
                    // Start the client again
                    createSessionClient(sessionId).catch(err => {
                        console.error(`[INIT_ERROR] (Retry) Failed to initialize ${sessionId}:`, err.message);
                        cleanupClient(sessionId);
                    });
                }
                // If it's not in initializingSessions, it means cleanupClient was called
                // and we should just stay closed.
            }
        }
    });

    // ... (Incoming Message Handler - sock.ev.on('messages.upsert', ...)) ...
    // Your existing code for this is correct.
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        const msg = m.messages[0];
        if (msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') return;
        
        console.log(`[INCOMING MESSAGE] Triggered for ${sessionId}. From: ${msg.key.remoteJid}`);
        if (activeClients[sessionId]) activeClients[sessionId].lastUsed = new Date();

        let body = ''; let type = 'chat';
        if (msg.message?.conversation) body = msg.message.conversation;
        else if (msg.message?.extendedTextMessage) body = msg.message.extendedTextMessage.text;
        else if (msg.message?.imageMessage) { body = msg.message.imageMessage.caption; type = 'image'; }
        else if (msg.message?.videoMessage) { body = msg.message.videoMessage.caption; type = 'video'; }
        else if (msg.message?.audioMessage) type = 'audio';
        else if (msg.message?.documentMessage) type = 'document';

        sendWebhook('/message', { sessionId, from: msg.key.remoteJid, body: body, isMedia: type !== 'chat', type: type });
    });

    // ... (Message Status Update Handler - sock.ev.on('messages.update', ...)) ...
    // Your existing code for this is correct.
    sock.ev.on('messages.update', (updates) => {
        for(const { key, update } of updates) {
            if (!key.fromMe) continue;
            let status;
            switch(update.status) {
                case 3: status = 'sent'; break;
                case 4: status = 'delivered'; break;
                case 5: status = 'read'; break;
                default: return;
            }
            console.log(`[STATUS_UPDATE] Session ${sessionId} - Message ${key.id} changed to: ${status}`);
            sendWebhook('/message-status-update', { sessionId, messageId: key.id, status, timestamp: dayjs().format('YYYY-MM-DD HH:mm:ss') });
        }
    });

    // ... (Save Credentials Handler - sock.ev.on('creds.update', ...)) ...
    // Your existing code for this is correct.
    sock.ev.on('creds.update', saveCreds);
};

// ... (startCleanupLoop is correct) ...
const startCleanupLoop = () => {
    cleanupLoop = setInterval(async () => {
        const now = Date.now();
        const activeSessionIds = Object.keys(activeClients);
        console.log(`[CLEANUP] Running inactivity check. Active clients: ${activeSessionIds.length}`);

        for (const sessionId of activeSessionIds) {
            const entry = activeClients[sessionId];
            let isAutoResponder = false;
            try {
                const settingsStr = await redisClient.hGet('device_settings', sessionId);
                if (settingsStr) {
                    isAutoResponder = JSON.parse(settingsStr).autoResponder === true;
                }
            } catch (e) {
                console.error(`[REDIS_CLEANUP_ERR] Could not check settings for ${sessionId}`, e.message);
            }
            if (!isAutoResponder && (now - entry.lastUsed.getTime() > INACTIVITY_TIMEOUT_MS)) {
                console.log(`[CLEANUP] Session ${sessionId} is idle. Cleaning up.`);
                await cleanupClient(sessionId);
            } else if (isAutoResponder) {
                entry.lastUsed = new Date();
            }
        }
    }, CLEANUP_INTERVAL_MS);
};

// **IMPROVED: Baileys Message Helper (Now uses Content-Type)**
const getBaileysMessage = async (mediaUrl, message) => {
    if (mediaUrl) {
        let buffer, mimetype, typeKey;
        try {
            const response = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
            buffer = Buffer.from(response.data, 'binary');
            mimetype = response.headers['content-type'];
        } catch (e) {
            throw new Error(`Failed to download media from ${mediaUrl}: ${e.message}`);
        }
        
        // Determine the message type key for Baileys
        if (mimetype.startsWith('image/')) typeKey = 'image';
        else if (mimetype.startsWith('video/')) typeKey = 'video';
        else if (mimetype.startsWith('audio/')) typeKey = 'audio';
        else typeKey = 'document'; // Default to document

        // Build the message object
        if (typeKey === 'document') {
             // For documents, we must provide a mimetype and ideally a filename
             const fileName = message.substring(0, 15) || path.basename(new URL(mediaUrl).pathname) || 'file';
             return { document: buffer, caption: message, mimetype: mimetype, fileName: fileName };
        }
        if (typeKey === 'audio') {
            // Audio messages don't have captions
            return { audio: buffer, mimetype: mimetype };
        }
        // Image or Video
        return { [typeKey]: buffer, caption: message };
    }
    // Just text
    return { text: message };
};


// --- API Endpoints ---

// ... (app.post('/sessions/start', ...)) ...
// This logic is now correct, as the timeout will be reset by the new connection handler
app.post('/sessions/start', async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'Session ID is required.' });
    if (activeClients[sessionId]) {
        activeClients[sessionId].lastUsed = new Date();
        return res.status(200).json({ message: 'Session already active.' });
    }
    if (initializingSessions[sessionId]) {
        return res.status(202).json({ message: 'Session is already initializing.' });
    }
    
    console.log(`[START] Starting Baileys initialization for ${sessionId}`);
    
    const timeoutId = setTimeout(() => {
        console.log(`[TIMEOUT] QR scan timeout for session: ${sessionId}`);
        cleanupClient(sessionId);
        sendWebhook('/qr-timeout', { sessionId });
    }, QR_GENERATION_TIMEOUT_MS);
    
    initializingSessions[sessionId] = { qr: null, timeoutId };
    
    createSessionClient(sessionId).catch(err => {
        console.error(`[INIT_ERROR] Failed to initialize ${sessionId}:`, err.message);
        cleanupClient(sessionId);
    });
    
    res.status(202).json({ message: 'Session initialization process started.' });
});

// ... (app.get('/sessions/:sessionId/qr', ...)) ...
// Your existing code for this is correct.
app.get('/sessions/:sessionId/qr', (req, res) => {
    const { sessionId } = req.params;
    const session = initializingSessions[sessionId];
    if (session && session.qr) {
        qrcode.toDataURL(session.qr, (err, url) => {
            if (err) return res.status(500).json({ error: 'Failed to generate QR code URL.' });
            res.status(200).json({ qrCodeUrl: url });
        });
    } else {
        res.status(404).json({ error: 'QR code not available or session expired.' });
    }
});


// ... (app.post('/messages/send-internal', ...)) ...
// This endpoint is now using the improved getBaileysMessage helper
app.post('/messages/send-internal', async (req, res) => {
    const { sessionId, to, message, mediaUrl, tempMessageId } = req.body;

    const clientEntry = activeClients[sessionId];
    if (!clientEntry) {
        return res.status(404).json({ error: 'Session not active on this worker. Please re-queue.' });
    }

    const { sock } = clientEntry;
    try {
        const jid = `${to}@s.whatsapp.net`;
        // Use the improved helper
        const baileysMessage = await getBaileysMessage(mediaUrl, message); 

        const result = await sock.sendMessage(jid, baileysMessage);

        sendWebhook('/message-sent', {
            tempMessageId,
            finalMessageId: result.key.id,
            sessionId
        });
        
        clientEntry.lastUsed = new Date();
        res.status(200).json({ success: true, id: result.key.id });

    } catch (error) {
        console.error(`[SEND-INTERNAL-ERROR] Session ${sessionId}:`, error.message);
        res.status(500).json({ success: false, error: 'Failed to send message.', details: error.message });
    }
});

// ... (app.get('/sessions', ...)) ...
// Your existing code for this is correct.
app.get('/sessions', async (req, res) => {
    try {
        await fs.mkdir(SESSIONS_DIR, { recursive: true });
        const entries = await fs.readdir(SESSIONS_DIR);
        const allSessions = entries.filter(entry => {
             // Simple check to ensure it's a directory
            try {
                return fs.statSync(path.join(SESSIONS_DIR, entry)).isDirectory();
            } catch (e) {
                return false;
            }
        });
        
        const activeSessionData = await redisClient.hGetAll('active_sessions');
        
        const sessionStatus = allSessions.map(id => ({
            sessionId: id,
            status: activeSessionData[id] ? 'active' : 'saved',
            workerId: activeSessionData[id] || 'N/A'
        }));
        
        res.status(200).json({ sessions: sessionStatus });
    } catch (error) {
        console.error(`[LIST_ERROR]`, error.message);
        res.status(500).json({ error: 'Failed to retrieve sessions list.' });
    }
});

// ... (app.post('/sessions/logout', ...)) ...
// Your existing code for this is correct.
app.post('/sessions/logout', async (req, res) => {
    const { sessionId } = req.body;
    const clientEntry = activeClients[sessionId];

    if (clientEntry) {
        try {
            await clientEntry.sock.logout();
            console.log(`[LOGOUT] Session ${sessionId} logged out.`);
        } catch (err) {
            console.error(`[LOGOUT_ERROR] Error during client logout for ${sessionId}:`, err.message);
        }
    }

    await cleanupClient(sessionId); 
    try {
        const sessionDir = path.join(SESSIONS_DIR, sessionId);
        await fs.rm(sessionDir, { recursive: true, force: true });
        console.log(`[LOGOUT] Cleaned up disk data for session ${sessionId}.`);
    } catch (err) {
        if (err.code !== 'ENOENT') {
             console.error(`[LOGOUT_ERROR] Error cleaning disk data for ${sessionId}:`, err.message);
        }
    }
    
    res.status(200).json({ message: 'Session logged out and cleaned up.' });
});


// ... (Server Startup and Graceful Shutdown are all correct) ...
const startServer = async () => {
    await redisClient.connect();
    console.log('[REDIS] Web server connected.');
    
    app.listen(PORT, () => {
        console.log(`\n======================================================`);
        console.log(`WhatsApp Web Server (ID: ${WORKER_ID}) [Baileys]`);
        console.log(`Running on port ${PORT}`);
        console.log(`======================================================\n`);
    });
    startCleanupLoop();
};
startServer();

const cleanup = async () => {
    console.log('\n[SHUTDOWN] Cleaning up sessions...');
    clearInterval(cleanupLoop);
    const shutdownPromises = [];
    for (const sessionId of Object.keys(activeClients)) {
        shutdownPromises.push(
            (async () => {
                await activeClients[sessionId].sock.end(new Error('Server shutdown'));
                await redisClient.hDel('active_sessions', sessionId);
                console.log(`[SHUTDOWN] Deregistered ${sessionId}.`);
            })()
        );
    }
    await Promise.allSettled(shutdownPromises);
    await redisClient.quit();
    console.log('[SHUTDOWN] Redis connection closed. Exiting.');
    process.exit(0);
};

process.on('SIGINT', cleanup); 
process.on('SIGTERM', cleanup);



// const express = require('express');
// const { 
//     default: makeWASocket, 
//     useMultiFileAuthState, 
//     DisconnectReason,
//     fetchLatestBaileysVersion,
//     // MessageUpsertType,
//     jidNormalizedUser,
// } = require('@whiskeysockets/baileys');
// const pino = require('pino');
// const qrcode = require('qrcode');
// const axios = require('axios'); // Needed for downloading media
// const fs = require('fs/promises');
// const path = require('path');
// const dayjs = require('dayjs');
// const { v4: uuidv4 } = require('uuid');
// const { createRedisClient, sendWebhook } = require('./shared');

// require('dotenv').config();

// const app = express();
// app.use(express.json());

// // --- Configuration ---
// const PORT = process.env.PORT || 3000;
// const API_KEY = process.env.API_KEY;
// // **NEW: Baileys sessions directory**
// const SESSIONS_DIR = path.join(__dirname, 'baileys_sessions'); 
// const WORKER_ID = `whatsapp-web-${uuidv4()}`;

// // --- Scaling Config ---
// const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
// const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
// const QR_GENERATION_TIMEOUT_MS = 300 * 1000;

// // --- Redis Client ---
// const redisClient = createRedisClient();

// // --- In-Memory Storage ---
// // activeClients: { sessionId: { sock: BaileysSocket, lastUsed: Date } }
// const activeClients = {};
// // initializingSessions: { sessionId: { qr: string, timeoutId: NodeJS.Timeout } }
// const initializingSessions = {};
// let cleanupLoop;

// // --- Middleware (Unchanged) ---
// const apiKeyMiddleware = (req, res, next) => {
//     const providedKey = req.headers['x-api-key'];
//     if (!API_KEY || providedKey === API_KEY) return next();
//     res.status(401).json({ error: 'Unauthorized' });
// };
// app.use(apiKeyMiddleware);

// // --- Baileys Helper Functions ---

// /**
//  * Destroys and cleans up a client
//  */
// const cleanupClient = async (sessionId) => {
//     const clientEntry = activeClients[sessionId];
//     const initEntry = initializingSessions[sessionId];
//     console.log(`[CLEANUP] Cleaning up session: ${sessionId}`);

//     if (clientEntry) {
//         try {
//             // End the connection
//             clientEntry.sock.end(new Error('Inactive cleanup')); 
//         } catch (e) {
//             console.error(`[CLEANUP_ERROR] Failed to end Baileys socket ${sessionId}:`, e.message);
//         }
//     }
//     if (initEntry) {
//         clearTimeout(initEntry.timeoutId);
//     }

//     delete activeClients[sessionId];
//     delete initializingSessions[sessionId];

//     try {
//         await redisClient.hDel('active_sessions', sessionId);
//         console.log(`[REDIS] Confirmed deregistration of session ${sessionId}.`);
//     } catch (e) {
//         console.error(`[REDIS_ERROR] Failed to deregister session ${sessionId}:`, e.message);
//     }
// };

// /**
//  * Creates a new Baileys socket client and sets up its events
//  */
// const createSessionClient = async (sessionId) => {
//     console.log(`[SETUP] Creating Baileys client for session: ${sessionId}`);
    
//     const sessionDir = path.join(SESSIONS_DIR, sessionId);
//     await fs.mkdir(sessionDir, { recursive: true });

//     // Use Baileys file-based auth
//     const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
//     const { version } = await fetchLatestBaileysVersion();
    
//     const sock = makeWASocket({
//         version,
//         auth: state,
//         printQRInTerminal: false,
//         logger: pino({ level: 'silent' }), // Set to 'debug' for verbose logs
//         browser: ['MyWebApp', 'Chrome', '1.0.0'], // Optional
//     });

//     // --- Setup Event Handlers ---

//     // 1. Handle Connection Updates (QR, Ready, Disconnect)
//     sock.ev.on('connection.update', async (update) => {
//         const { connection, lastDisconnect, qr } = update;

//         if (qr) {
//             console.log(`[QR] QR code received for ${sessionId}`);
//             qrcode.toDataURL(qr, (err, url) => {
//                 if (err) return;
//                 // Store QR for polling
//                 if (initializingSessions[sessionId]) {
//                     initializingSessions[sessionId].qr = qr;
//                 }
//                 // Send to Laravel
//                 sendWebhook('/qr-code-received', { sessionId, qrCodeUrl: url });
//             });
//         }

//         if (connection === 'open') {
//             console.log(`[READY] Client is ready for session: ${sessionId}`);
//             if (initializingSessions[sessionId]) {
//                 clearTimeout(initializingSessions[sessionId].timeoutId);
//             }
//             activeClients[sessionId] = { sock, lastUsed: new Date() };
//             delete initializingSessions[sessionId];

//             try {
//                 await redisClient.hSet('active_sessions', sessionId, WORKER_ID);
//                 console.log(`[REDIS] Registered session ${sessionId} to WEB worker ${WORKER_ID}`);
//             } catch (e) {
//                 console.error(`[REDIS_ERROR] Failed to register session ${sessionId}:`, e.message);
//             }
            
//             const phone = jidNormalizedUser(sock.user.id).split(':')[0];
//             sendWebhook('/connected', { sessionId, phone });
//         }

//         if (connection === 'close') {
//             const statusCode = (lastDisconnect.error)?.output?.statusCode;
//             console.log(`[DISCONNECTED] Session ${sessionId} closed. Reason: ${DisconnectReason[statusCode] || 'Unknown'}`);

//             // 401 = Logged out from another device
//             if (statusCode === DisconnectReason.loggedOut) {
//                 console.log(`[AUTH_FAILURE] Device logged out: ${sessionId}. Cleaning up.`);
//                 sendWebhook('/disconnected', { sessionId, reason: 'logged_out' });
//                 await cleanupClient(sessionId);
//                 // Also delete the session directory
//                 await fs.rm(sessionDir, { recursive: true, force: true });
//             } else {
//                 // Don't auto-reconnect if cleaned up manually
//                 if (activeClients[sessionId]) {
//                     console.log(`[RECONNECT] Attempting to reconnect: ${sessionId}`);
//                     createSessionClient(sessionId); // Re-create the client
//                 }
//             }
//         }
//     });

//     // 2. Handle Incoming Messages
//     sock.ev.on('messages.upsert', async (m) => {
//         if (m.type !== 'notify') return;
        
//         const msg = m.messages[0];
//         if (msg.key.fromMe || msg.key.remoteJid === 'status@broadcast') {
//             return;
//         }

//         console.log(`[INCOMING MESSAGE] Triggered for ${sessionId}. From: ${msg.key.remoteJid}`);
//         if (activeClients[sessionId]) {
//             activeClients[sessionId].lastUsed = new Date();
//         }

//         // Extract message type and body
//         let body = '';
//         let type = 'chat';
//         if (msg.message.conversation) {
//             body = msg.message.conversation;
//         } else if (msg.message.extendedTextMessage) {
//             body = msg.message.extendedTextMessage.text;
//         } else if (msg.message.imageMessage) {
//             body = msg.message.imageMessage.caption;
//             type = 'image';
//         } else if (msg.message.videoMessage) {
//             body = msg.message.videoMessage.caption;
//             type = 'video';
//         } else if (msg.message.audioMessage) {
//             type = 'audio';
//         } else if (msg.message.documentMessage) {
//             type = 'document';
//         }

//         sendWebhook('/message', { 
//             sessionId, 
//             from: msg.key.remoteJid, 
//             body: body,
//             isMedia: type !== 'chat',
//             type: type 
//         });
//     });

//     // 3. Handle Message Status Updates (Sent, Delivered, Read)
//     sock.ev.on('messages.update', (updates) => {
//         for(const { key, update } of updates) {
//             if (!key.fromMe) continue;
            
//             let status;
//             switch(update.status) {
//                 case 3: status = 'sent'; break; // WAMessageStatus.SERVER_ACK
//                 case 4: status = 'delivered'; break; // WAMessageStatus.DELIVERY_ACK
//                 case 5: status = 'read'; break; // WAMessageStatus.READ
//                 default: return; // Ignore pending, etc.
//             }
            
//             console.log(`[STATUS_UPDATE] Session ${sessionId} - Message ${key.id} changed to: ${status}`);
//             sendWebhook('/message-status-update', { 
//                 sessionId, 
//                 messageId: key.id, // Baileys uses a different ID format
//                 status, 
//                 timestamp: dayjs().format('YYYY-MM-DD HH:mm:ss') 
//             });
//         }
//     });

//     // 4. Save Credentials
//     sock.ev.on('creds.update', saveCreds);
// };

// const startCleanupLoop = () => {
//     cleanupLoop = setInterval(async () => {
//         const now = Date.now();
//         const activeSessionIds = Object.keys(activeClients);
//         console.log(`[CLEANUP] Running inactivity check. Active clients: ${activeSessionIds.length}`);

//         for (const sessionId of activeSessionIds) {
//             const entry = activeClients[sessionId];
//             let isAutoResponder = false;

//             try {
//                 // **Check the setting in Redis**
//                 const settingsStr = await redisClient.hGet('device_settings', sessionId);
//                 if (settingsStr) {
//                     isAutoResponder = JSON.parse(settingsStr).autoResponder === true;
//                 }
//             } catch (e) {
//                 console.error(`[REDIS_CLEANUP_ERR] Could not check settings for ${sessionId}`, e.message);
//             }

//             // **Only clean up if it's NOT an auto-responder device AND it's idle**
//             if (!isAutoResponder && (now - entry.lastUsed.getTime() > INACTIVITY_TIMEOUT_MS)) {
//                 console.log(`[CLEANUP] Session ${sessionId} is idle and not an auto-responder. Cleaning up.`);
//                 await cleanupClient(sessionId);
//             } else if (isAutoResponder) {
//                 // It's an auto-responder device, so we just update its 'lastUsed' timestamp
//                 // to prevent it from *ever* being seen as idle, even if it has no activity.
//                 entry.lastUsed = new Date();
//             }
//         }
//     }, CLEANUP_INTERVAL_MS);
// };

// /**
//  * --- **NEW: Baileys Message Helper** ---
//  * Prepares the message object for Baileys
//  */
// const getBaileysMessage = async (mediaUrl, message) => {
//     if (mediaUrl) {
//         let buffer, type;
//         try {
//             const response = await axios.get(mediaUrl, { responseType: 'arraybuffer' });
//             buffer = Buffer.from(response.data, 'binary');
//         } catch (e) {
//             throw new Error(`Failed to download media from ${mediaUrl}: ${e.message}`);
//         }
        
//         // Infer type from URL (simple version)
//         if (mediaUrl.match(/\.(jpg|jpeg|png|webp)$/i)) {
//             type = 'image';
//         } else if (mediaUrl.match(/\.(mp4|avi|mkv)$/i)) {
//             type = 'video';
//         } else if (mediaUrl.match(/\.(mp3|ogg|aac)$/i)) {
//             type = 'audio';
//         } else {
//             type = 'document'; // Default to document
//         }
        
//         return { [type]: buffer, caption: message };
//     }
//     // Just text
//     return { text: message };
// };


// // --- API Endpoints ---
// app.post('/sessions/start', async (req, res) => {
//     const { sessionId } = req.body;
//     if (!sessionId) return res.status(400).json({ error: 'Session ID is required.' });
//     if (activeClients[sessionId]) {
//         activeClients[sessionId].lastUsed = new Date();
//         return res.status(200).json({ message: 'Session already active.' });
//     }
//     if (initializingSessions[sessionId]) {
//         return res.status(202).json({ message: 'Session is already initializing.' });
//     }
    
//     console.log(`[START] Starting Baileys initialization for ${sessionId}`);
    
//     const timeoutId = setTimeout(() => {
//         console.log(`[TIMEOUT] QR scan timeout for session: ${sessionId}`);
//         cleanupClient(sessionId);
//         sendWebhook('/qr-timeout', { sessionId });
//     }, QR_GENERATION_TIMEOUT_MS);
    
//     initializingSessions[sessionId] = { qr: null, timeoutId };
    
//     // Start the client, but don't wait for it
//     createSessionClient(sessionId).catch(err => {
//         console.error(`[INIT_ERROR] Failed to initialize ${sessionId}:`, err.message);
//         cleanupClient(sessionId);
//     });
    
//     res.status(202).json({ message: 'Session initialization process started.' });
// });

// app.get('/sessions/:sessionId/qr', (req, res) => {
//     const { sessionId } = req.params;
//     const session = initializingSessions[sessionId];
//     if (session && session.qr) {
//         qrcode.toDataURL(session.qr, (err, url) => {
//             if (err) return res.status(500).json({ error: 'Failed to generate QR code URL.' });
//             res.status(200).json({ qrCodeUrl: url });
//         });
//     } else {
//         res.status(404).json({ error: 'QR code not available or session expired.' });
//     }
// });

// // **This is the internal endpoint called by worker.js**
// app.post('/messages/send-internal', async (req, res) => {
//     const { sessionId, to, message, mediaUrl, tempMessageId } = req.body;

//     const clientEntry = activeClients[sessionId];
//     if (!clientEntry) {
//         return res.status(404).json({ error: 'Session not active on this worker. Please re-queue.' });
//     }

//     const { sock } = clientEntry;
//     try {
//         const jid = `${to}@s.whatsapp.net`;
//         const baileysMessage = await getBaileysMessage(mediaUrl, message);

//         // Send the message
//         const result = await sock.sendMessage(jid, baileysMessage);

//         // Send success webhook back to Laravel
//         sendWebhook('/message-sent', {
//             tempMessageId,
//             finalMessageId: result.key.id, // Baileys ID
//             sessionId
//         });
        
//         clientEntry.lastUsed = new Date();
//         res.status(200).json({ success: true, id: result.key.id });

//     } catch (error) {
//         console.error(`[SEND-INTERNAL-ERROR] Session ${sessionId}:`, error.message);
//         res.status(500).json({ success: false, error: 'Failed to send message.', details: error.message });
//     }
// });

// app.get('/sessions', async (req, res) => {
//     try {
//         await fs.mkdir(SESSIONS_DIR, { recursive: true });
//         const entries = await fs.readdir(SESSIONS_DIR);
//         const allSessions = entries.filter(entry => fs.statSync(path.join(SESSIONS_DIR, entry)).isDirectory());
        
//         const activeSessionData = await redisClient.hGetAll('active_sessions');
        
//         const sessionStatus = allSessions.map(id => ({
//             sessionId: id,
//             status: activeSessionData[id] ? 'active' : 'saved',
//             workerId: activeSessionData[id] || 'N/A'
//         }));
        
//         res.status(200).json({ sessions: sessionStatus });
//     } catch (error) {
//         console.error(`[LIST_ERROR]`, error.message);
//         res.status(500).json({ error: 'Failed to retrieve sessions list.' });
//     }
// });

// app.post('/sessions/logout', async (req, res) => {
//     const { sessionId } = req.body;
//     const clientEntry = activeClients[sessionId];

//     if (clientEntry) {
//         try {
//             await clientEntry.sock.logout();
//             console.log(`[LOGOUT] Session ${sessionId} logged out.`);
//         } catch (err) {
//             console.error(`[LOGOUT_ERROR] Error during client logout for ${sessionId}:`, err.message);
//         }
//     }

//     // Always cleanup files and memory
//     await cleanupClient(sessionId); 
//     try {
//         const sessionDir = path.join(SESSIONS_DIR, sessionId);
//         await fs.rm(sessionDir, { recursive: true, force: true });
//         console.log(`[LOGOUT] Cleaned up disk data for session ${sessionId}.`);
//     } catch (err) {
//         if (err.code !== 'ENOENT') {
//              console.error(`[LOGOUT_ERROR] Error cleaning disk data for ${sessionId}:`, err.message);
//         }
//     }
    
//     res.status(200).json({ message: 'Session logged out and cleaned up.' });
// });

// // --- Server Startup ---
// const startServer = async () => {
//     await redisClient.connect();
//     console.log('[REDIS] Web server connected.');
    
//     app.listen(PORT, () => {
//         console.log(`\n======================================================`);
//         console.log(`WhatsApp Web Server (ID: ${WORKER_ID}) [Baileys]`);
//         console.log(`Running on port ${PORT}`);
//         console.log(`======================================================\n`);
//     });
//     startCleanupLoop();
// };

// startServer();

// // --- Graceful Shutdown ---
// const cleanup = async () => {
//     // ... (Your graceful shutdown code is good, but let's make it Baileys-specific)
//     console.log('\n[SHUTDOWN] Cleaning up sessions...');
//     clearInterval(cleanupLoop);
//     const shutdownPromises = [];
//     for (const sessionId of Object.keys(activeClients)) {
//         shutdownPromises.push(
//             (async () => {
//                 await activeClients[sessionId].sock.end(new Error('Server shutdown'));
//                 await redisClient.hDel('active_sessions', sessionId);
//                 console.log(`[SHUTDOWN] Deregistered ${sessionId}.`);
//             })()
//         );
//     }
//     await Promise.allSettled(shutdownPromises);
//     await redisClient.quit();
//     console.log('[SHUTDOWN] Redis connection closed. Exiting.');
//     process.exit(0);
// };

// process.on('SIGINT', cleanup); 
// process.on('SIGTERM', cleanup);