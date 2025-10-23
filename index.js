const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const axios = require('axios');
const fs = require('fs/promises');
const path = require('path');
const dayjs = require('dayjs');
const { createClient } = require('redis');
const { v4: uuidv4 } = require('uuid');

// To read the environment variables
require('dotenv').config();

const app = express();
app.use(express.json());

// --- Configuration ---
const PORT = process.env.PORT || 3000;
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL || 'http://localhost:8000/webhook';
const API_KEY = process.env.API_KEY;
const SESSION_DIR = path.join(__dirname, '.wwebjs_auth');
const WORKER_ID = `whatsapp-worker-${uuidv4()}`; // A unique ID for this process instance

// --- Enterprise Scaling Configuration ---
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const QR_GENERATION_TIMEOUT_MS = 60 * 1000; // 60-second timeout

// --- Redis Client Setup ---
const redisClient = createClient({
    // Build the URL from your .env variables
    // redis[s]://[username:password@]host[:port][/database]
    url: `redis://${process.env.REDIS_HOST || '127.0.0.1'}:${process.env.REDIS_PORT || 6379}`,
    // The node-redis client handles 'null' passwords correctly,
    // but it's cleaner to only add the property if it exists.
    ...(process.env.REDIS_PASSWORD && process.env.REDIS_PASSWORD !== 'null' && { 
        password: process.env.REDIS_PASSWORD 
    })
});

redisClient.on('error', err => console.error('[REDIS_ERROR]', err));

// --- In-Memory Storage (for this worker only) ---
const activeClients = {};
const initializingSessions = {};
let cleanupLoop;

// --- Middleware for Security ---
const apiKeyMiddleware = (req, res, next) => {
    const providedKey = req.headers['x-api-key'];
    if (!API_KEY || providedKey === API_KEY) {
        return next();
    }
    res.status(401).json({ error: 'Unauthorized' });
};
app.use(apiKeyMiddleware);

// --- Helper Functions ---
const sendWebhook = async (endpoint, data, retries = 3) => {
    for (let i = 0; i < retries; i++) {
        try {
            await axios.post(`${WEBHOOK_BASE_URL}${endpoint}`, data, {
                headers: { 'X-API-KEY': API_KEY }
            });
            return;
        } catch (err) {
            console.error(`[WEBHOOK_ERROR] Attempt ${i + 1} failed for ${endpoint}:`, err.message);
            if (i === retries - 1) {
                console.error(`[WEBHOOK_FATAL] All retries failed for ${endpoint}. Data:`, data);
            } else {
                await new Promise(res => setTimeout(res, 1000 * (i + 1)));
            }
        }
    }
};

const cleanupClient = async (sessionId) => {
    const clientEntry = activeClients[sessionId];
    const initEntry = initializingSessions[sessionId];

    console.log(`[CLEANUP] Cleaning up session: ${sessionId}`);

    if (clientEntry) {
        try {
            await clientEntry.client.destroy();
        } catch (e) {
            console.error(`[CLEANUP_ERROR] Failed to destroy active client ${sessionId}:`, e.message);
        }
    }
    
    if (initEntry) {
        clearTimeout(initEntry.timeoutId);
        if (initEntry.client) {
            try {
                await initEntry.client.destroy();
            } catch (e) {
                console.error(`[CLEANUP_ERROR] Failed to destroy initializing client ${sessionId}:`, e.message);
            }
        }
    }

    delete activeClients[sessionId];
    delete initializingSessions[sessionId];

    // **Ensure Redis is also cleaned up**
    try {
        await redisClient.hDel('active_sessions', sessionId);
        console.log(`[REDIS] Confirmed deregistration of session ${sessionId} during cleanup.`);
    } catch (e) {
        console.error(`[REDIS_ERROR] Failed to deregister session ${sessionId} during cleanup:`, e.message);
    }
};

const getAvailableSessions = async () => {
    try {
        await fs.mkdir(SESSION_DIR, { recursive: true });
        const entries = await fs.readdir(SESSION_DIR, { withFileTypes: true });
        return entries.filter(dirent => dirent.isDirectory()).map(dirent => dirent.name);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error("[SCAN_ERROR] Failed to read session directory:", error);
        }
        return [];
    }
};

const createSessionClient = (sessionId) => {
    console.log(`[SETUP] Creating client for session: ${sessionId}`);
    return new Client({
        authStrategy: new LocalAuth({ clientId: sessionId }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process'],
        }
    });
};

/**
 * --- MODIFIED: LAZY LOADING SESSION GETTER ---
 * Gets an existing active session. Does NOT create a new one.
 * This is used for sending messages where a session MUST be active.
 * @param {string} sessionId
 * @returns {Client|null}
 */
const getActiveClient = (sessionId) => {
    const entry = activeClients[sessionId];
    if (entry && entry.client.info) {
        entry.lastUsed = new Date();
        return entry.client;
    }
    return null;
};

const setupClientEvents = (client, sessionId) => {
    client.on('qr', (qr) => {
        console.log(`[QR] QR code received for ${sessionId}`);
        if (initializingSessions[sessionId]) {
            initializingSessions[sessionId].qr = qr;
            qrcode.toDataURL(qr, (err, url) => {
                if (err) return;
                sendWebhook('/qr-code-received', { sessionId, qrCodeUrl: url });
            });
        }
    });

    client.on('ready', async () => {
        console.log(`[READY] Client is ready for session: ${sessionId}`);
        
        if (initializingSessions[sessionId]) {
            clearTimeout(initializingSessions[sessionId].timeoutId);
        }

        activeClients[sessionId] = { client, lastUsed: new Date() };
        delete initializingSessions[sessionId];
        
        // **NEW: Announce to Redis that this worker now owns this session**
        try {
            await redisClient.hSet('active_sessions', sessionId, WORKER_ID);
            console.log(`[REDIS] Registered session ${sessionId} to worker ${WORKER_ID}`);
        } catch (e) {
            console.error(`[REDIS_ERROR] Failed to register session ${sessionId}:`, e.message);
        }
        
        sendWebhook('/connected', { sessionId, phone: client.info.wid.user });
    });
    
    // **Corrected message handler**
    client.on('message', (msg) => {
        if (msg.fromMe || msg.from === 'status@broadcast' || !msg.id.remote) {
            return;
        }
        console.log(`[INCOMING MESSAGE] Triggered for ${sessionId}. From: ${msg.from}`);
        if (activeClients[sessionId]) {
            activeClients[sessionId].lastUsed = new Date();
        }
        sendWebhook('/message', { sessionId, from: msg.from, body: msg.body, isMedia: msg.hasMedia, type: msg.type });
    });

    client.on('message_ack', (msg, ack) => {
        if (!msg.fromMe) return;
        let status;
        switch (ack) {
            case 1: status = 'sent'; break;
            case 2: status = 'delivered'; break;
            case 3: status = 'read'; break;
            case -1: status = 'failed'; break;
            default: return;
        }
        console.log(`[STATUS_UPDATE] Session ${sessionId} - Message ${msg.id._serialized} changed to: ${status}`);
        sendWebhook('/message-status-update', { sessionId, messageId: msg.id._serialized, status, timestamp: dayjs().format('YYYY-MM-DD HH:mm:ss') });
    });

    client.on('disconnected', async (reason) => {
        console.log(`[DISCONNECTED] Client for ${sessionId} was logged out. Reason: ${reason}`);
        sendWebhook('/disconnected', { sessionId, reason });
        
        // **NEW: Remove session from Redis on disconnect**
        try {
            await redisClient.hDel('active_sessions', sessionId);
            console.log(`[REDIS] Deregistered session ${sessionId}`);
        } catch (e) {
            console.error(`[REDIS_ERROR] Failed to deregister session ${sessionId}:`, e.message);
        }

        await cleanupClient(sessionId); 
    });

    client.on('auth_failure', (msg) => {
        console.error(`[AUTH_FAILURE] Session ${sessionId}:`, msg);
        delete initializingSessions[sessionId];
    });
};

// --- System Control & Message Queue ---
const startCleanupLoop = () => {
    cleanupLoop = setInterval(async () => {
        const now = Date.now();
        const activeSessionIds = Object.keys(activeClients);
        console.log(`[CLEANUP] Running inactivity check. Active clients: ${activeSessionIds.length}`);

        for (const sessionId of activeSessionIds) {
            const entry = activeClients[sessionId];
            let isAutoResponder = false;

            try {
                // **Check the setting in Redis**
                const settingsStr = await redisClient.hGet('device_settings', sessionId);
                if (settingsStr) {
                    isAutoResponder = JSON.parse(settingsStr).autoResponder === true;
                }
            } catch (e) {
                console.error(`[REDIS_CLEANUP_ERR] Could not check settings for ${sessionId}`, e.message);
            }

            // **Only clean up if it's NOT an auto-responder device AND it's idle**
            if (!isAutoResponder && (now - entry.lastUsed.getTime() > INACTIVITY_TIMEOUT_MS)) {
                console.log(`[CLEANUP] Session ${sessionId} is idle and not an auto-responder. Cleaning up.`);
                await cleanupClient(sessionId);
            } else if (isAutoResponder) {
                // It's an auto-responder device, so we just update its 'lastUsed' timestamp
                // to prevent it from *ever* being seen as idle, even if it has no activity.
                entry.lastUsed = new Date();
            }
        }
    }, CLEANUP_INTERVAL_MS);
};

const listenForMessages = async () => {
    const subscriber = redisClient.duplicate();
    await subscriber.connect();
    const channelName = process.env.LARAVEL_CHANNEL;
    console.log('[REDIS] Subscriber connected, listening to "whatsapp:send_queue"');

    await subscriber.subscribe(channelName, async (message) => {

        let sessionId, tempMessageId;

        try {
            const job = JSON.parse(message);
            console.log('[REDIS] Laravel Job Payload', job);

            // Destructure and assign directly to the outer variables
            ({ sessionId, tempMessageId } = job); 
            
            const { to, message: text, mediaUrl } = job; // Other variables can remain scoped

            // const { sessionId, to, message: text, tempMessageId, mediaUrl } = job;

            const clientEntry = activeClients[sessionId];

            if (clientEntry) {
                console.log(`[QUEUE] Worker ${WORKER_ID} processing job for session ${sessionId}`);
                const client = clientEntry.client;
                const chatId = `${to}@c.us`;
                
                let result;

                // **THIS IS THE FINAL LOGIC FOR MEDIA + CAPTIONS**
                if (mediaUrl) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    const media = await MessageMedia.fromUrl(mediaUrl, { unsafeMime: true });
                    result = await client.sendMessage(chatId, media, { caption: text });
                } else {
                    result = await client.sendMessage(chatId, text);
                }

                sendWebhook('/message-sent', {
                    tempMessageId,
                    finalMessageId: result.id._serialized,
                    sessionId
                });
                clientEntry.lastUsed = new Date();
            }

        } catch (err) {
            console.error(`[QUEUE_ERROR] Failed to process job:`, err);
            console.error(`[QUEUE_ERROR] Original Job Payload:`, message);

            sendWebhook('/message-failed', { // **NEW WEBHOOK**
                tempMessageId,
                sessionId,
                reason: err.message // Send the actual error message
            });
        }
    });
};

// --- API Endpoints ---
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
    
    console.log(`[START] Starting initialization for ${sessionId}`);
    const client = createSessionClient(sessionId);
    setupClientEvents(client, sessionId);
    const timeoutId = setTimeout(() => {
        console.log(`[TIMEOUT] QR scan timeout for session: ${sessionId}`);
        cleanupClient(sessionId);
        sendWebhook('/qr-timeout', { sessionId });
    }, QR_GENERATION_TIMEOUT_MS);
    initializingSessions[sessionId] = { client, qr: null, timeoutId };
    client.initialize().catch(err => {
        console.error(`[INIT_ERROR] Failed to initialize ${sessionId}:`, err.message);
        cleanupClient(sessionId);
    });
    res.status(202).json({ message: 'Session initialization process started.' });
});

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

/**
 * POST /messages/send
 * **MODIFIED:** Uses the new `getActiveClient` helper.
 */
app.post('/messages/send', async (req, res) => {
    const { sessionId, to, message, mediaUrl } = req.body;
    if (!sessionId || !to || !message) {
        return res.status(400).json({ error: 'Missing required parameters.' });
    }

    // **MODIFIED:** Use getActiveClient instead of getSession
    const client = getActiveClient(sessionId);
    if (!client) {
        // **IMPORTANT:** We DO NOT create a session here. A message can only be sent from an already-connected device.
        return res.status(404).json({ error: 'Session is not active. Please ensure the device is connected.' });
    }

    try {
        const chatId = `${to}@c.us`;
        let result;

        if (mediaUrl) {
            const media = await MessageMedia.fromUrl(mediaUrl, { unsafeMime: true });
            result = await client.sendMessage(chatId, media, { caption: message });
        } else {
            result = await client.sendMessage(chatId, message);
        }

        res.status(200).json({ success: true, id: result.id._serialized });

    } catch (error) {
        console.error(`[SEND_ERROR] Session ${sessionId}:`, error.message);
        res.status(500).json({ success: false, error: 'Failed to send message.', details: error.message });
    }
});

app.get('/sessions', async (req, res) => {
    try {
        const allSessions = await getAvailableSessions();
        // **NEW: Fetch active session data from Redis for a global view**
        const activeSessionData = await redisClient.hGetAll('active_sessions');
        
        const sessionStatus = allSessions.map(id => ({
            sessionId: id,
            status: activeSessionData[id] ? 'active' : 'saved',
            workerId: activeSessionData[id] || 'N/A'
        }));
        
        res.status(200).json({ 
            sessions: sessionStatus
        });
    } catch (error) {
        console.error(`[LIST_ERROR]`, error.message);
        res.status(500).json({ error: 'Failed to retrieve sessions list.' });
    }
});

/**
 * POST /sessions/logout
 * Logs out a session and completely deletes its data.
 */
app.post('/sessions/logout', async (req, res) => {
    const { sessionId } = req.body;
    const clientEntry = activeClients[sessionId];

    if (!clientEntry) {
        // If not active, try to clean the persistent data anyway
        try {
            const sessionPath = path.join(SESSION_DIR, sessionId);
            await fs.rm(sessionPath, { recursive: true, force: true });
            console.log(`[LOGOUT] Cleaned up disk data for inactive session ${sessionId}.`);
            return res.status(200).json({ message: 'Session data cleaned from disk (was inactive).' });
        } catch (err) {
            // Ignore common ENOENT errors if folder doesn't exist
            if (err.code !== 'ENOENT') {
                 console.error(`[LOGOUT_ERROR] Error cleaning disk data for ${sessionId}:`, err.message);
            }
            return res.status(404).json({ error: 'Session not found or not active.' });
        }
    }

    try {
        await clientEntry.client.logout(); 
        console.log(`[LOGOUT] Session ${sessionId} logged out.`);
    } catch (err) {
        console.error(`[LOGOUT_ERROR] Error during client logout for ${sessionId}:`, err.message);
    } finally {
        await cleanupClient(sessionId); // Cleans up memory and kills Puppeteer
        res.status(200).json({ message: 'Session logged out and cleaned up.' });
    }
});

// --- Server Startup ---
const startServer = async () => {
    await redisClient.connect();
    console.log('[REDIS] Main client connected.');
    
    await listenForMessages(); // Start the message queue listener

    app.listen(PORT, () => {
        console.log(`\n======================================================`);
        console.log(`WhatsApp Gateway Worker ID: ${WORKER_ID}`);
        console.log(`Server running on port ${PORT}`);
        console.log('Mode: SCALABLE (Redis State & Pub/Sub Queue)');
        console.log(`======================================================\n`);
    });
    startCleanupLoop();
};

startServer();

// --- Graceful Shutdown ---
const cleanup = async () => {
    console.log('\n[SHUTDOWN] Cleaning up...');
    clearInterval(cleanupLoop);
    const sessionIds = Object.keys(activeClients);
    for (const sessionId of sessionIds) {
        await redisClient.hDel('active_sessions', sessionId);
        console.log(`[SHUTDOWN] Deregistered ${sessionId} from Redis.`);
    }
    await redisClient.quit();
    console.log('[SHUTDOWN] Redis connection closed.');
    process.exit(0);
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);


// const express = require('express');
// const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
// const qrcode = require('qrcode');
// const axios = require('axios');
// const fs = require('fs/promises');
// const path = require('path');
// const dayjs = require('dayjs');

// // To read the environment variables
// require('dotenv').config();

// const app = express();
// app.use(express.json());

// // --- Configuration ---
// const PORT = process.env.PORT || 3000;
// const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL || 'http://localhost:8000/webhook';
// const API_KEY = process.env.API_KEY; // **NEW: For securing webhooks**
// const SESSION_DIR = path.join(__dirname, '.wwebjs_auth');

// // --- Enterprise Scaling Configuration ---
// const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes of inactivity before client is destroyed
// const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;    // Check for inactive clients every 5 minutes
// const QR_GENERATION_TIMEOUT_MS = 5 * 60 * 1000; // **NEW: 60-second timeout for QR scan**

// // --- In-Memory Storage ---
// // activeClients: Stores only the subset of clients that are currently READY and in use.
// // Format: { sessionId: { client: Client, lastUsed: Date } }
// const activeClients = {};
// // initializingSessions: Tracks sessions currently starting up with additional metadata.
// // Format: { sessionId: { client: Client, qr: string, timeoutId: NodeJS.Timeout } }
// const initializingSessions = {};
// let cleanupLoop; // To hold the interval reference

// // --- Middleware for Security ---
// const apiKeyMiddleware = (req, res, next) => {
//     const providedKey = req.headers['x-api-key'];
//     if (!API_KEY || providedKey === API_KEY) {
//         return next();
//     }
//     res.status(401).json({ error: 'Unauthorized' });
// };

// app.use(apiKeyMiddleware); // **NEW: Apply middleware to all routes**

// // --- Helper Functions ---

// /**
//  * Sends a webhook notification to the Laravel backend with retry logic.
//  * @param {string} endpoint - The specific webhook endpoint.
//  * @param {object} data - The payload to send.
//  * @param {number} retries - Number of retries.
//  */
// const sendWebhook = async (endpoint, data, retries = 3) => {
//     for (let i = 0; i < retries; i++) {
//         try {
//             await axios.post(`${WEBHOOK_BASE_URL}${endpoint}`, data, {
//                 headers: { 'X-API-KEY': API_KEY } // **NEW: Send API key back**
//             });
//             return; // Success
//         } catch (err) {
//             console.error(`[WEBHOOK_ERROR] Attempt ${i + 1} failed for ${endpoint}:`, err.message);
//             if (i === retries - 1) {
//                 console.error(`[WEBHOOK_FATAL] All retries failed for ${endpoint}. Data:`, data);
//             } else {
//                 await new Promise(res => setTimeout(res, 1000 * (i + 1))); // Exponential backoff
//             }
//         }
//     }
// };

// /**
//  * Destroys and cleans up an inactive client from memory.
//  * @param {string} sessionId
//  */
// const cleanupClient = async (sessionId) => {
//     const clientEntry = activeClients[sessionId];
//     const initEntry = initializingSessions[sessionId];

//     console.log(`[CLEANUP] Cleaning up session: ${sessionId}`);

//     if (clientEntry) {
//         try {
//             await clientEntry.client.destroy();
//         } catch (e) {
//             console.error(`[CLEANUP_ERROR] Failed to destroy active client ${sessionId}:`, e.message);
//         }
//     }
    
//     if (initEntry) {
//         clearTimeout(initEntry.timeoutId); // Clear any pending QR timeout
//         // If there's a client instance being initialized, destroy it too
//         if (initEntry.client) {
//             try {
//                 await initEntry.client.destroy();
//             } catch (e) {
//                 console.error(`[CLEANUP_ERROR] Failed to destroy initializing client ${sessionId}:`, e.message);
//             }
//         }
//     }

//     delete activeClients[sessionId];
//     delete initializingSessions[sessionId];
// };

// /**
//  * Scans the SESSION_DIR to find all saved session IDs (folders).
//  * This provides a low-memory way to get a list of all potential sessions.
//  * @returns {Promise<string[]>}
//  */
// const getAvailableSessions = async () => {
//     try {
//         await fs.mkdir(SESSION_DIR, { recursive: true }); // Ensure directory exists
//         const entries = await fs.readdir(SESSION_DIR, { withFileTypes: true });
//         // Filter for directories that represent saved sessions
//         return entries
//             .filter(dirent => dirent.isDirectory())
//             .map(dirent => dirent.name);
//     } catch (error) {
//         if (error.code !== 'ENOENT') {
//             console.error("[SCAN_ERROR] Failed to read session directory:", error);
//         }
//         return [];
//     }
// };

// /**
//  * Creates and configures a new client instance.
//  * @param {string} sessionId
//  * @returns {Client}
//  */
// const createClient = (sessionId) => {
//     console.log(`[SETUP] Creating client for session: ${sessionId}`);
//     return new Client({
//         authStrategy: new LocalAuth({ clientId: sessionId }),
//         puppeteer: {
//             headless: true,
//             args: [
//                 '--no-sandbox',
//                 '--disable-setuid-sandbox',
//                 '--disable-dev-shm-usage',
//                 '--disable-accelerated-2d-canvas',
//                 '--no-first-run',
//                 '--no-zygote',
//                 '--single-process', 
//                 '--disable-gpu',
//                 '--disable-extensions' // **NEW**
//             ],
//         }
//     });
// };

// /**
//  * Sets up event handlers for a client instance.
//  * @param {Client} client
//  * @param {string} sessionId
//  */
// const setupClientEvents = (client, sessionId) => {
//     client.on('qr', (qr) => {
//         console.log(`[QR] QR code received for ${sessionId}`);
//         if (initializingSessions[sessionId]) {
//             // Store the QR code for polling
//             initializingSessions[sessionId].qr = qr;
            
//             // Send to webhook so Laravel DB can be updated
//             qrcode.toDataURL(qr, (err, url) => {
//                 if (err) return;
//                 sendWebhook('/qr-code-received', { sessionId, qrCodeUrl: url });
//             });
//         }
//     });

//     client.on('ready', () => {
//         console.log(`[READY] Client is ready for session: ${sessionId}`);
        
//         // Clear the QR timeout
//         if (initializingSessions[sessionId]) {
//             clearTimeout(initializingSessions[sessionId].timeoutId);
//         }

//         activeClients[sessionId] = { client, lastUsed: new Date() };
//         delete initializingSessions[sessionId];
        
//         sendWebhook('/connected', { sessionId, phone: client.info.wid.user });
//     });

//     client.on('message', (msg) => {
//         // Only process incoming messages
//         if (msg.fromMe || msg.from === 'status@broadcast' || !msg.id.remote) {
//             return;
//         }

//         console.log(`[INCOMING MESSAGE] Triggered for ${sessionId}. From: ${msg.from}`);
        
//         // **CRUCIAL: Update lastUsed timestamp on inbound activity**
//         if (activeClients[sessionId]) {
//             activeClients[sessionId].lastUsed = new Date();
//         }

//         sendWebhook('/message', { 
//             sessionId, 
//             from: msg.from, 
//             body: msg.body,
//             isMedia: msg.hasMedia,
//             type: msg.type 
//         });
//     });

//     client.on('message_ack', (msg, ack) => {
//         // Only monitor messages we SENT (which will have a proper message ID)
//         if (!msg.fromMe) {
//             return;
//         }

//         let status;
        
//         switch (ack) {
//             case 1:
//                 status = 'sent';
//                 break;
//             case 2:
//                 status = 'delivered';
//                 break;
//             case 3:
//                 status = 'read';
//                 break;
//             case -1:
//                 status = 'failed'; // We'll treat auth_failure as a failure to deliver
//                 break;
//             default:
//                 return; // Ignore other states/ack types
//         }
        
//         console.log(`[STATUS_UPDATE] Session ${sessionId} - Message ${msg.id._serialized} changed status to: ${status}`);

//         // Send the webhook to Laravel
//         sendWebhook('/message-status-update', { 
//             sessionId: sessionId,
//             messageId: msg.id._serialized, // The unique ID saved in your MessageLog
//             status: status,
//             timestamp: dayjs(new Date()).format('YYYY-MM-DD HH:mm:ss')
//         });
//     });

//     client.on('disconnected', async (reason) => {
//         console.log(`[DISCONNECTED] Client for ${sessionId} was logged out. Reason: ${reason}`);
//         sendWebhook('/disconnected', { sessionId, reason });
//         // Clean up
//         await cleanupClient(sessionId); 
//     });

//     client.on('auth_failure', (msg) => {
//         console.error(`[AUTH_FAILURE] Session ${sessionId}:`, msg);
//         delete initializingSessions[sessionId];
//     });

//     // Optionally add 'change_state' listener to track connection issues
//     // client.on('change_state', (state) => console.log(`[STATE] ${sessionId} changed state to ${state}`));
// };

// /**
//  * --- MODIFIED: LAZY LOADING SESSION GETTER ---
//  * Gets an existing active session. Does NOT create a new one.
//  * This is used for sending messages where a session MUST be active.
//  * @param {string} sessionId
//  * @returns {Client|null}
//  */
// const getActiveClient = (sessionId) => {
//     const entry = activeClients[sessionId];
//     if (entry && entry.client.info) {
//         entry.lastUsed = new Date();
//         return entry.client;
//     }
//     return null;
// };

// // --- System Control Loop ---

// /**
//  * The main loop to monitor and destroy inactive clients, freeing up resources.
//  */
// const startCleanupLoop = () => {
//     cleanupLoop = setInterval(async () => {
//         const now = Date.now();
//         const activeSessionIds = Object.keys(activeClients);
//         console.log(`[CLEANUP] Running inactivity check. Active clients: ${activeSessionIds.length}`);
        
//         for (const sessionId of activeSessionIds) {
//             const entry = activeClients[sessionId];
//             if (now - entry.lastUsed.getTime() > INACTIVITY_TIMEOUT_MS) {
//                 await cleanupClient(sessionId);
//             }
//         }
//     }, CLEANUP_INTERVAL_MS);
// };

// // --- API Endpoints ---

// /**
//  * POST /sessions/start
//  * **MODIFIED:** This now starts the initialization process with a timeout.
//  * It doesn't wait for the QR code. It responds immediately.
//  */
// app.post('/sessions/start', async (req, res) => {
//     const { sessionId } = req.body;
//     if (!sessionId) {
//         return res.status(400).json({ error: 'Session ID is required.' });
//     }

//     // If already active, just confirm and update timestamp
//     if (activeClients[sessionId]) {
//         activeClients[sessionId].lastUsed = new Date();
//         return res.status(200).json({ message: 'Session already active.' });
//     }

//     if (initializingSessions[sessionId]) {
//         return res.status(202).json({ message: 'Session is already initializing.' });
//     }
    
//     console.log(`[START] Starting initialization for ${sessionId}`);

//     const client = createClient(sessionId);
//     setupClientEvents(client, sessionId);

//     // Set a timeout to kill the initialization if QR is not scanned
//     const timeoutId = setTimeout(() => {
//         console.log(`[TIMEOUT] QR scan timeout for session: ${sessionId}`);
//         cleanupClient(sessionId);
//         sendWebhook('/qr-timeout', { sessionId }); // **NEW WEBHOOK**
//     }, QR_GENERATION_TIMEOUT_MS);

//     initializingSessions[sessionId] = { client, qr: null, timeoutId };

//     client.initialize().catch(err => {
//         console.error(`[INIT_ERROR] Failed to initialize ${sessionId}:`, err.message);
//         cleanupClient(sessionId); // Clean up on failure
//     });
    
//     res.status(202).json({ message: 'Session initialization process started.' });
// });

// /**
//  * **NEW ENDPOINT**
//  * GET /sessions/:sessionId/qr
//  * Allows the frontend to poll for the QR code.
//  */
// app.get('/sessions/:sessionId/qr', (req, res) => {
//     const { sessionId } = req.params;
//     const session = initializingSessions[sessionId];

//     if (session && session.qr) {
//         qrcode.toDataURL(session.qr, (err, url) => {
//             if (err) return res.status(500).json({ error: 'Failed to generate QR code URL.' });
//             res.status(200).json({ qrCodeUrl: url });
//         });
//     } else {
//         // This could mean it's not ready yet, or it has timed out
//         res.status(404).json({ error: 'QR code not available or session expired.' });
//     }
// });

// /**
//  * GET /sessions
//  * Lists all known session IDs by scanning the disk (low memory).
//  */
// app.get('/sessions', async (req, res) => {
//     try {
//         const allSessions = await getAvailableSessions();
//         const activeSessionIds = Object.keys(activeClients);

//         const sessionStatus = allSessions.map(id => ({
//             sessionId: id,
//             status: activeSessionIds.includes(id) ? 'active' : 'saved',
//             lastUsed: activeClients[id] ? activeClients[id].lastUsed.toISOString() : 'N/A'
//         }));
        
//         res.status(200).json({ 
//             totalSessions: allSessions.length,
//             activeCount: activeSessionIds.length,
//             sessions: sessionStatus
//         });
//     } catch (error) {
//         console.error(`[LIST_ERROR]`, error.message);
//         res.status(500).json({ error: 'Failed to retrieve sessions list.' });
//     }
// });

// /**
//  * POST /messages/send
//  * **MODIFIED:** Uses the new `getActiveClient` helper.
//  */
// app.post('/messages/send', async (req, res) => {
//     const { sessionId, to, message, mediaUrl } = req.body;
//     if (!sessionId || !to || !message) {
//         return res.status(400).json({ error: 'Missing required parameters.' });
//     }

//     // **MODIFIED:** Use getActiveClient instead of getSession
//     const client = getActiveClient(sessionId);
//     if (!client) {
//         // **IMPORTANT:** We DO NOT create a session here. A message can only be sent from an already-connected device.
//         return res.status(404).json({ error: 'Session is not active. Please ensure the device is connected.' });
//     }

//     try {
//         const chatId = `${to}@c.us`;
//         let result;

//         if (mediaUrl) {
//             const media = await MessageMedia.fromUrl(mediaUrl, { unsafeMime: true });
//             result = await client.sendMessage(chatId, media, { caption: message });
//         } else {
//             result = await client.sendMessage(chatId, message);
//         }

//         res.status(200).json({ success: true, id: result.id._serialized });

//     } catch (error) {
//         console.error(`[SEND_ERROR] Session ${sessionId}:`, error.message);
//         res.status(500).json({ success: false, error: 'Failed to send message.', details: error.message });
//     }
// });

// /**
//  * POST /sessions/logout
//  * Logs out a session and completely deletes its data.
//  */
// app.post('/sessions/logout', async (req, res) => {
//     const { sessionId } = req.body;
//     const clientEntry = activeClients[sessionId];

//     if (!clientEntry) {
//         // If not active, try to clean the persistent data anyway
//         try {
//             const sessionPath = path.join(SESSION_DIR, sessionId);
//             await fs.rm(sessionPath, { recursive: true, force: true });
//             console.log(`[LOGOUT] Cleaned up disk data for inactive session ${sessionId}.`);
//             return res.status(200).json({ message: 'Session data cleaned from disk (was inactive).' });
//         } catch (err) {
//             // Ignore common ENOENT errors if folder doesn't exist
//             if (err.code !== 'ENOENT') {
//                  console.error(`[LOGOUT_ERROR] Error cleaning disk data for ${sessionId}:`, err.message);
//             }
//             return res.status(404).json({ error: 'Session not found or not active.' });
//         }
//     }

//     try {
//         await clientEntry.client.logout(); 
//         console.log(`[LOGOUT] Session ${sessionId} logged out.`);
//     } catch (err) {
//         console.error(`[LOGOUT_ERROR] Error during client logout for ${sessionId}:`, err.message);
//     } finally {
//         await cleanupClient(sessionId); // Cleans up memory and kills Puppeteer
//         res.status(200).json({ message: 'Session logged out and cleaned up.' });
//     }
// });

// // --- Server Startup ---
// app.listen(PORT, () => {
//     console.log(`\n======================================================`);
//     console.log(`WhatsApp Gateway running on port ${PORT}`);
//     console.log(`Webhook Base URL: ${WEBHOOK_BASE_URL}`);
//     console.log('Mode: LAZY-LOADED & ON-DEMAND (Low Memory at Startup)');
//     console.log(`Inactivity Timeout: ${INACTIVITY_TIMEOUT_MS / 60000} minutes`);
//     console.log(`QR Timeout: ${QR_GENERATION_TIMEOUT_MS / 1000} seconds`);
//     console.log(`======================================================\n`);
//     startCleanupLoop(); // Start the memory management loop
// });

// // --- Graceful Shutdown ---
// const cleanup = async () => {
//     console.log('\n[SHUTDOWN] Cleaning up sessions...');
//     clearInterval(cleanupLoop); // Stop the cleanup loop
//     const shutdownPromises = Object.values(activeClients).map(entry => entry.client.destroy().catch(e => console.error(`[SHUTDOWN_ERR] Failed to destroy client:`, e.message)));
//     await Promise.allSettled(shutdownPromises);
//     console.log('[SHUTDOWN] All active sessions destroyed. Exiting.');
//     process.exit(0);
// };

// process.on('SIGINT', cleanup); 
// process.on('SIGTERM', cleanup);
