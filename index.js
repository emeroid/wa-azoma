const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const axios = require('axios');
const fs = require('fs/promises');
const path = require('path');
const dayjs = require('dayjs');

// To read the environment variables
require('dotenv').config();

const app = express();
app.use(express.json());

// --- Configuration ---
const PORT = process.env.PORT || 3000;
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL || 'http://localhost:8000/webhook';
const API_KEY = process.env.API_KEY; // **NEW: For securing webhooks**
const SESSION_DIR = path.join(__dirname, '.wwebjs_auth');

// --- Enterprise Scaling Configuration ---
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes of inactivity before client is destroyed
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;    // Check for inactive clients every 5 minutes
const QR_GENERATION_TIMEOUT_MS = 5 * 60 * 1000; // **NEW: 60-second timeout for QR scan**

// --- In-Memory Storage ---
// activeClients: Stores only the subset of clients that are currently READY and in use.
// Format: { sessionId: { client: Client, lastUsed: Date } }
const activeClients = {};
// initializingSessions: Tracks sessions currently starting up with additional metadata.
// Format: { sessionId: { client: Client, qr: string, timeoutId: NodeJS.Timeout } }
const initializingSessions = {};
let cleanupLoop; // To hold the interval reference

// --- Middleware for Security ---
const apiKeyMiddleware = (req, res, next) => {
    const providedKey = req.headers['x-api-key'];
    if (!API_KEY || providedKey === API_KEY) {
        return next();
    }
    res.status(401).json({ error: 'Unauthorized' });
};

app.use(apiKeyMiddleware); // **NEW: Apply middleware to all routes**

// --- Helper Functions ---

/**
 * Sends a webhook notification to the Laravel backend with retry logic.
 * @param {string} endpoint - The specific webhook endpoint.
 * @param {object} data - The payload to send.
 * @param {number} retries - Number of retries.
 */
const sendWebhook = async (endpoint, data, retries = 3) => {
    for (let i = 0; i < retries; i++) {
        try {
            await axios.post(`${WEBHOOK_BASE_URL}${endpoint}`, data, {
                headers: { 'X-API-KEY': API_KEY } // **NEW: Send API key back**
            });
            return; // Success
        } catch (err) {
            console.error(`[WEBHOOK_ERROR] Attempt ${i + 1} failed for ${endpoint}:`, err.message);
            if (i === retries - 1) {
                console.error(`[WEBHOOK_FATAL] All retries failed for ${endpoint}. Data:`, data);
            } else {
                await new Promise(res => setTimeout(res, 1000 * (i + 1))); // Exponential backoff
            }
        }
    }
};

/**
 * Destroys and cleans up an inactive client from memory.
 * @param {string} sessionId
 */
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
        clearTimeout(initEntry.timeoutId); // Clear any pending QR timeout
        // If there's a client instance being initialized, destroy it too
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
};

/**
 * Scans the SESSION_DIR to find all saved session IDs (folders).
 * This provides a low-memory way to get a list of all potential sessions.
 * @returns {Promise<string[]>}
 */
const getAvailableSessions = async () => {
    try {
        await fs.mkdir(SESSION_DIR, { recursive: true }); // Ensure directory exists
        const entries = await fs.readdir(SESSION_DIR, { withFileTypes: true });
        // Filter for directories that represent saved sessions
        return entries
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            console.error("[SCAN_ERROR] Failed to read session directory:", error);
        }
        return [];
    }
};

/**
 * Creates and configures a new client instance.
 * @param {string} sessionId
 * @returns {Client}
 */
const createClient = (sessionId) => {
    console.log(`[SETUP] Creating client for session: ${sessionId}`);
    return new Client({
        authStrategy: new LocalAuth({ clientId: sessionId }),
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process', 
                '--disable-gpu',
                '--disable-extensions' // **NEW**
            ],
        }
    });
};

/**
 * Sets up event handlers for a client instance.
 * @param {Client} client
 * @param {string} sessionId
 */
const setupClientEvents = (client, sessionId) => {
    client.on('qr', (qr) => {
        console.log(`[QR] QR code received for ${sessionId}`);
        if (initializingSessions[sessionId]) {
            // Store the QR code for polling
            initializingSessions[sessionId].qr = qr;
            
            // Send to webhook so Laravel DB can be updated
            qrcode.toDataURL(qr, (err, url) => {
                if (err) return;
                sendWebhook('/qr-code-received', { sessionId, qrCodeUrl: url });
            });
        }
    });

    client.on('ready', () => {
        console.log(`[READY] Client is ready for session: ${sessionId}`);
        
        // Clear the QR timeout
        if (initializingSessions[sessionId]) {
            clearTimeout(initializingSessions[sessionId].timeoutId);
        }

        activeClients[sessionId] = { client, lastUsed: new Date() };
        delete initializingSessions[sessionId];
        
        sendWebhook('/connected', { sessionId, phone: client.info.wid.user });
    });

    client.on('message_create', (msg) => {
        // Only process incoming messages
        if (msg.fromMe || !msg.id.remote) {
            return;
        }

        console.log(`[INCOMING MESSAGE] Triggered for ${sessionId}. From: ${msg.from}`);
        
        // **CRUCIAL: Update lastUsed timestamp on inbound activity**
        if (activeClients[sessionId]) {
            activeClients[sessionId].lastUsed = new Date();
        }

        sendWebhook('/message', { 
            sessionId, 
            from: msg.from, 
            body: msg.body,
            isMedia: msg.hasMedia,
            type: msg.type 
        });
    });

    client.on('message_ack', (msg, ack) => {
        // Only monitor messages we SENT (which will have a proper message ID)
        if (!msg.fromMe) {
            return;
        }

        let status;
        
        switch (ack) {
            case 1:
                status = 'sent';
                break;
            case 2:
                status = 'delivered';
                break;
            case 3:
                status = 'read';
                break;
            case -1:
                status = 'failed'; // We'll treat auth_failure as a failure to deliver
                break;
            default:
                return; // Ignore other states/ack types
        }
        
        console.log(`[STATUS_UPDATE] Session ${sessionId} - Message ${msg.id._serialized} changed status to: ${status}`);

        // Send the webhook to Laravel
        sendWebhook('/message-status-update', { 
            sessionId: sessionId,
            messageId: msg.id._serialized, // The unique ID saved in your MessageLog
            status: status,
            timestamp: dayjs(new Date()).format('YYYY-MM-DD HH:mm:ss')
        });
    });

    client.on('disconnected', async (reason) => {
        console.log(`[DISCONNECTED] Client for ${sessionId} was logged out. Reason: ${reason}`);
        sendWebhook('/disconnected', { sessionId, reason });
        // Clean up
        await cleanupClient(sessionId); 
    });

    client.on('auth_failure', (msg) => {
        console.error(`[AUTH_FAILURE] Session ${sessionId}:`, msg);
        delete initializingSessions[sessionId];
    });

    // Optionally add 'change_state' listener to track connection issues
    // client.on('change_state', (state) => console.log(`[STATE] ${sessionId} changed state to ${state}`));
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

// --- System Control Loop ---

/**
 * The main loop to monitor and destroy inactive clients, freeing up resources.
 */
const startCleanupLoop = () => {
    cleanupLoop = setInterval(async () => {
        const now = Date.now();
        const activeSessionIds = Object.keys(activeClients);
        console.log(`[CLEANUP] Running inactivity check. Active clients: ${activeSessionIds.length}`);
        
        for (const sessionId of activeSessionIds) {
            const entry = activeClients[sessionId];
            if (now - entry.lastUsed.getTime() > INACTIVITY_TIMEOUT_MS) {
                await cleanupClient(sessionId);
            }
        }
    }, CLEANUP_INTERVAL_MS);
};

// --- API Endpoints ---

/**
 * POST /sessions/start
 * **MODIFIED:** This now starts the initialization process with a timeout.
 * It doesn't wait for the QR code. It responds immediately.
 */
app.post('/sessions/start', async (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) {
        return res.status(400).json({ error: 'Session ID is required.' });
    }

    // If already active, just confirm and update timestamp
    if (activeClients[sessionId]) {
        activeClients[sessionId].lastUsed = new Date();
        return res.status(200).json({ message: 'Session already active.' });
    }

    if (initializingSessions[sessionId]) {
        return res.status(202).json({ message: 'Session is already initializing.' });
    }
    
    console.log(`[START] Starting initialization for ${sessionId}`);

    const client = createClient(sessionId);
    setupClientEvents(client, sessionId);

    // Set a timeout to kill the initialization if QR is not scanned
    const timeoutId = setTimeout(() => {
        console.log(`[TIMEOUT] QR scan timeout for session: ${sessionId}`);
        cleanupClient(sessionId);
        sendWebhook('/qr-timeout', { sessionId }); // **NEW WEBHOOK**
    }, QR_GENERATION_TIMEOUT_MS);

    initializingSessions[sessionId] = { client, qr: null, timeoutId };

    client.initialize().catch(err => {
        console.error(`[INIT_ERROR] Failed to initialize ${sessionId}:`, err.message);
        cleanupClient(sessionId); // Clean up on failure
    });
    
    res.status(202).json({ message: 'Session initialization process started.' });
});

/**
 * **NEW ENDPOINT**
 * GET /sessions/:sessionId/qr
 * Allows the frontend to poll for the QR code.
 */
app.get('/sessions/:sessionId/qr', (req, res) => {
    const { sessionId } = req.params;
    const session = initializingSessions[sessionId];

    if (session && session.qr) {
        qrcode.toDataURL(session.qr, (err, url) => {
            if (err) return res.status(500).json({ error: 'Failed to generate QR code URL.' });
            res.status(200).json({ qrCodeUrl: url });
        });
    } else {
        // This could mean it's not ready yet, or it has timed out
        res.status(404).json({ error: 'QR code not available or session expired.' });
    }
});

/**
 * GET /sessions
 * Lists all known session IDs by scanning the disk (low memory).
 */
app.get('/sessions', async (req, res) => {
    try {
        const allSessions = await getAvailableSessions();
        const activeSessionIds = Object.keys(activeClients);

        const sessionStatus = allSessions.map(id => ({
            sessionId: id,
            status: activeSessionIds.includes(id) ? 'active' : 'saved',
            lastUsed: activeClients[id] ? activeClients[id].lastUsed.toISOString() : 'N/A'
        }));
        
        res.status(200).json({ 
            totalSessions: allSessions.length,
            activeCount: activeSessionIds.length,
            sessions: sessionStatus
        });
    } catch (error) {
        console.error(`[LIST_ERROR]`, error.message);
        res.status(500).json({ error: 'Failed to retrieve sessions list.' });
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
app.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`WhatsApp Gateway running on port ${PORT}`);
    console.log(`Webhook Base URL: ${WEBHOOK_BASE_URL}`);
    console.log('Mode: LAZY-LOADED & ON-DEMAND (Low Memory at Startup)');
    console.log(`Inactivity Timeout: ${INACTIVITY_TIMEOUT_MS / 60000} minutes`);
    console.log(`QR Timeout: ${QR_GENERATION_TIMEOUT_MS / 1000} seconds`);
    console.log(`======================================================\n`);
    startCleanupLoop(); // Start the memory management loop
});

// --- Graceful Shutdown ---
const cleanup = async () => {
    console.log('\n[SHUTDOWN] Cleaning up sessions...');
    clearInterval(cleanupLoop); // Stop the cleanup loop
    const shutdownPromises = Object.values(activeClients).map(entry => entry.client.destroy().catch(e => console.error(`[SHUTDOWN_ERR] Failed to destroy client:`, e.message)));
    await Promise.allSettled(shutdownPromises);
    console.log('[SHUTDOWN] All active sessions destroyed. Exiting.');
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

// // To read the environment variables (WEBHOOK_BASE_URL)
// require('dotenv').config();

// const app = express();
// app.use(express.json());

// // --- Configuration ---
// const PORT = 3000;
// const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL || 'http://localhost:8000/webhook'; 
// const SESSION_DIR = path.join(__dirname, '.wwebjs_auth');

// // --- Enterprise Scaling Configuration ---
// const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes of inactivity before client is destroyed
// const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;    // Check for inactive clients every 5 minutes

// // --- In-Memory Storage ---
// // activeClients: Stores only the subset of clients that are currently READY and in use.
// // Format: { sessionId: { client: Client, lastUsed: Date } }
// const activeClients = {};
// // initializingSessions: Tracks sessions currently starting up to prevent duplicates.
// const initializingSessions = {};
// let cleanupLoop; // To hold the interval reference

// // --- Helper Functions ---

// /**
//  * Sends a webhook notification to the Laravel backend.
//  * @param {string} endpoint - The specific webhook endpoint.
//  * @param {object} data - The payload to send.
//  */
// const sendWebhook = (endpoint, data) => {
//     axios.post(`${WEBHOOK_BASE_URL}${endpoint}`, data)
//         .catch(err => {
//             console.error(`[WEBHOOK_ERROR] Failed to send webhook to ${WEBHOOK_BASE_URL}${endpoint} for session ${data.sessionId || 'N/A'}:`, err);
//         });
// };

// /**
//  * Destroys and cleans up an inactive client from memory.
//  * @param {string} sessionId
//  */
// const cleanupClient = async (sessionId) => {
//     const clientEntry = activeClients[sessionId];
//     if (clientEntry) {
//         console.log(`[CLEANUP] Destroying inactive client: ${sessionId}`);
//         try {
//             await clientEntry.client.destroy();
//         } catch (e) {
//             console.error(`[CLEANUP_ERROR] Failed to destroy client ${sessionId}:`, e.message);
//         }
//         delete activeClients[sessionId];
//         delete initializingSessions[sessionId]; 
//     }
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
//                 '--disable-gpu'
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
//         qrcode.toDataURL(qr, (err, url) => {

//             if (err) return console.error(`[QR_ERROR] Failed to generate QR for ${sessionId}:`, err.message);
//             sendWebhook('/qr-code-received', { sessionId, qrCodeUrl: url });
//         });
//     });

//     client.on('ready', () => {
//         console.log(`[READY] Client is ready for session: ${sessionId}`);
//         activeClients[sessionId] = { client, lastUsed: new Date() }; // Add to active clients pool with timestamp
//         delete initializingSessions[sessionId]; 
//         sendWebhook('/connected', { sessionId, phone: client.info.wid.user });
//     });

//     client.on('message_create', (msg) => {
//         // Only process incoming messages
//         if (msg.fromMe || !msg.id.remote) {
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
//  * --- LAZY LOADING SESSION GETTER ---
//  * Gets an existing active session or initializes a new one.
//  * Also updates the lastUsed timestamp.
//  * @param {string} sessionId
//  * @returns {Promise<Client|null>}
//  */
// const getSession = (sessionId) => {
//     return new Promise((resolve, reject) => {
//         // 1. If the client is already ready, return it and update timestamp
//         if (activeClients[sessionId] && activeClients[sessionId].client.info) {
//             activeClients[sessionId].lastUsed = new Date(); // **UPDATE TIMESTAMP**
//             console.log(`[SESSION] Using active session: ${sessionId}`);
//             return resolve(activeClients[sessionId].client);
//         }

//         // 2. If a session is currently initializing, wait for it
//         if (initializingSessions[sessionId]) {
//             console.log(`[SESSION] Waiting for session to initialize: ${sessionId}`);
            
//             // Wait for the client to enter the 'ready' state which resolves this promise
//             // Note: This relies on the 'ready' event listener in setupClientEvents
//             const checkInterval = setInterval(() => {
//                 if (activeClients[sessionId]) {
//                     clearInterval(checkInterval);
//                     resolve(activeClients[sessionId].client);
//                 }
//                 // Implement a realistic timeout (e.g., 60s) in a real-world app
//             }, 1000); 
//             return;
//         }

//         // 3. If no session exists, create, setup, and initialize it
//         console.log(`[SESSION] Initializing new session: ${sessionId}`);
//         initializingSessions[sessionId] = true; 

//         const client = createClient(sessionId);
//         setupClientEvents(client, sessionId);

//         client.once('ready', () => {
//              // The ready listener already adds to activeClients and deletes initializingSessions
//              resolve(client);
//         });

//         client.initialize().catch(err => {
//             console.error(`[INIT_ERROR] Failed to initialize session ${sessionId}:`, err.message);
//             delete initializingSessions[sessionId];
//             // Since initialization failed, we should try to destroy the client object if it exists
//             try { client.destroy(); } catch (e) { /* ignore */ }
//             reject(new Error('Initialization failed.'));
//         });
//     });
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
//  * Ensures a session is started.
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
    
//     // Respond immediately to Laravel
//     res.status(202).json({ message: 'Session initialization process started.' });
    
//     // Start initialization in the background
//     try {
//         await getSession(sessionId);
//         console.log(`[START] Background initialization complete for ${sessionId}`);
//     } catch (error) {
//         console.error(`[START_FAIL] Background initialization failed for ${sessionId}:`, error.message);
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
//  * Sends a message from a specific session.
//  */
// app.post('/messages/send', async (req, res) => {
//     const { sessionId, to, message, mediaUrl } = req.body;
//     if (!sessionId || !to || !message) {
//         return res.status(400).json({ error: 'Missing required parameters.' });
//     }

//     try {
//         // This will load the client if it is not active
//         const client = await getSession(sessionId); 
//         if (!client) {
//             return res.status(404).json({ error: 'Session not ready or failed to initialize.' });
//         }
        
//         // **CRUCIAL: Update lastUsed timestamp on outbound activity**
//         if (activeClients[sessionId]) {
//             activeClients[sessionId].lastUsed = new Date();
//         }

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
//     console.log(`Webhook Base URL: ${WEBHOOK_BASE_URL}`); // Display the resolved URL
//     console.log('Mode: LAZY-LOADED & ON-DEMAND (Low Memory at Startup)');
//     console.log(`Inactivity Timeout: ${INACTIVITY_TIMEOUT_MS / 60000} minutes`);
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
