const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const axios = require('axios');
const fs = require('fs/promises'); 
const path = require('path');
const dayjs = require('dayjs');

const app = express();
app.use(express.json());

// --- Configuration ---
const PORT = 3000;
const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL || 'http://localhost:8000/webhook'; 
const SESSION_DIR = path.join(__dirname, '.wwebjs_auth');

// --- Enterprise Scaling Configuration ---
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes of inactivity before client is destroyed
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;    // Check for inactive clients every 5 minutes

// --- In-Memory Storage ---
// activeClients: Stores only the subset of clients that are currently READY and in use.
// Format: { sessionId: { client: Client, lastUsed: Date } }
const activeClients = {};
// initializingSessions: Tracks sessions currently starting up to prevent duplicates.
const initializingSessions = {};
let cleanupLoop; // To hold the interval reference

// --- Helper Functions ---

/**
 * Sends a webhook notification to the Laravel backend.
 * @param {string} endpoint - The specific webhook endpoint.
 * @param {object} data - The payload to send.
 */
const sendWebhook = (endpoint, data) => {
    axios.post(`${WEBHOOK_BASE_URL}${endpoint}`, data)
        .catch(err => {
            console.error(`[WEBHOOK_ERROR] Failed to send webhook to ${endpoint} for session ${data.sessionId || 'N/A'}:`, err);
        });
};

/**
 * Destroys and cleans up an inactive client from memory.
 * @param {string} sessionId
 */
const cleanupClient = async (sessionId) => {
    const clientEntry = activeClients[sessionId];
    if (clientEntry) {
        console.log(`[CLEANUP] Destroying inactive client: ${sessionId}`);
        try {
            await clientEntry.client.destroy();
        } catch (e) {
            console.error(`[CLEANUP_ERROR] Failed to destroy client ${sessionId}:`, e.message);
        }
        delete activeClients[sessionId];
        delete initializingSessions[sessionId]; 
    }
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
                '--disable-gpu'
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
        qrcode.toDataURL(qr, (err, url) => {

            if (err) return console.error(`[QR_ERROR] Failed to generate QR for ${sessionId}:`, err.message);
            sendWebhook('/qr-code-received', { sessionId, qrCodeUrl: url });
        });
    });

    client.on('ready', () => {
        console.log(`[READY] Client is ready for session: ${sessionId}`);
        activeClients[sessionId] = { client, lastUsed: new Date() }; // Add to active clients pool with timestamp
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
 * --- LAZY LOADING SESSION GETTER ---
 * Gets an existing active session or initializes a new one.
 * Also updates the lastUsed timestamp.
 * @param {string} sessionId
 * @returns {Promise<Client|null>}
 */
const getSession = (sessionId) => {
    return new Promise((resolve, reject) => {
        // 1. If the client is already ready, return it and update timestamp
        if (activeClients[sessionId] && activeClients[sessionId].client.info) {
            activeClients[sessionId].lastUsed = new Date(); // **UPDATE TIMESTAMP**
            console.log(`[SESSION] Using active session: ${sessionId}`);
            return resolve(activeClients[sessionId].client);
        }

        // 2. If a session is currently initializing, wait for it
        if (initializingSessions[sessionId]) {
            console.log(`[SESSION] Waiting for session to initialize: ${sessionId}`);
            
            // Wait for the client to enter the 'ready' state which resolves this promise
            // Note: This relies on the 'ready' event listener in setupClientEvents
            const checkInterval = setInterval(() => {
                if (activeClients[sessionId]) {
                    clearInterval(checkInterval);
                    resolve(activeClients[sessionId].client);
                }
                // Implement a realistic timeout (e.g., 60s) in a real-world app
            }, 1000); 
            return;
        }

        // 3. If no session exists, create, setup, and initialize it
        console.log(`[SESSION] Initializing new session: ${sessionId}`);
        initializingSessions[sessionId] = true; 

        const client = createClient(sessionId);
        setupClientEvents(client, sessionId);

        client.once('ready', () => {
             // The ready listener already adds to activeClients and deletes initializingSessions
             resolve(client);
        });

        client.initialize().catch(err => {
            console.error(`[INIT_ERROR] Failed to initialize session ${sessionId}:`, err.message);
            delete initializingSessions[sessionId];
            // Since initialization failed, we should try to destroy the client object if it exists
            try { client.destroy(); } catch (e) { /* ignore */ }
            reject(new Error('Initialization failed.'));
        });
    });
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
 * Ensures a session is started.
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
    
    // Respond immediately to Laravel
    res.status(202).json({ message: 'Session initialization process started.' });
    
    // Start initialization in the background
    try {
        await getSession(sessionId);
        console.log(`[START] Background initialization complete for ${sessionId}`);
    } catch (error) {
        console.error(`[START_FAIL] Background initialization failed for ${sessionId}:`, error.message);
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
 * Sends a message from a specific session.
 */
app.post('/messages/send', async (req, res) => {
    const { sessionId, to, message, mediaUrl } = req.body;
    if (!sessionId || !to || !message) {
        return res.status(400).json({ error: 'Missing required parameters.' });
    }

    try {
        // This will load the client if it is not active
        const client = await getSession(sessionId); 
        if (!client) {
            return res.status(404).json({ error: 'Session not ready or failed to initialize.' });
        }
        
        // **CRUCIAL: Update lastUsed timestamp on outbound activity**
        if (activeClients[sessionId]) {
            activeClients[sessionId].lastUsed = new Date();
        }

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
    console.log('Mode: LAZY-LOADED & ON-DEMAND (Low Memory at Startup)');
    console.log(`Inactivity Timeout: ${INACTIVITY_TIMEOUT_MS / 60000} minutes`);
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
// const fs = require('fs/promises'); // Use promises for async file operations
// const path = require('path');

// const app = express();
// app.use(express.json());

// // --- Configuration ---
// const PORT = 3000;
// const WEBHOOK_BASE_URL = 'http://localhost:8000/webhook'; // Your Laravel webhook endpoint
// const SESSION_DIR = path.join(__dirname, '.wwebjs_auth');

// // --- In-Memory Storage ---
// // clients: Stores active, ready-to-use client instances.
// // initializingSessions: Tracks sessions currently in the process of starting up to prevent duplicates.
// const clients = {};
// const initializingSessions = {};

// // --- Helper Functions ---

// /**
//  * Sends a webhook notification to the Laravel backend.
//  * @param {string} endpoint - The specific webhook endpoint (e.g., '/qr-code-received').
//  * @param {object} data - The payload to send.
//  */
// const sendWebhook = (endpoint, data) => {
//     axios.post(`${WEBHOOK_BASE_URL}${endpoint}`, data)
//         .catch(err => {
//             console.error(`[WEBHOOK_ERROR] Failed to send webhook to ${endpoint} for session ${data.sessionId}:`, err.message);
//         });
// };


// /**
//  * Creates and configures a new client instance, but does not initialize it.
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
//                 '--single-process', // Crucial for resource saving
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
//             if (err) return console.error(`[QR_ERROR] Failed to generate QR for ${sessionId}:`, err);
//             sendWebhook('/qr-code-received', { sessionId, qrCodeUrl: url });
//         });
//     });

//     client.on('ready', () => {
//         console.log(`[READY] Client is ready for session: ${sessionId}`);
//         clients[sessionId] = client; // Add to active clients pool
//         delete initializingSessions[sessionId]; // Remove from initializing tracker
//         sendWebhook('/connected', { sessionId, phone: client.info.wid.user });
//     });

//     // client.on('message', (msg) => {
//     //     console.log(`[INCOMING MESSAGE] Incoming message from Client: ${sessionId}`);
//     //     sendWebhook('/message', { sessionId, from: msg.from, body: msg.body });
//     // });

//     // message_create fires for all messages (incoming and outgoing), so we must filter it.
//     // --- RE-ENABLING ROBUST MESSAGE LISTENER (message_create) ---
//     // This listener is more reliable than 'message' and is filtered to ensure only incoming messages trigger webhooks.
//     client.on('message_create', (msg) => {
//         // Only process incoming messages (not status messages or our own outgoing messages)
//         if (msg.fromMe || !msg.id.remote) {
//             return;
//         }

//         console.log(`[INCOMING MESSAGE] Triggered for ${sessionId}. From: ${msg.from}`);
//         sendWebhook('/message', { 
//             sessionId, 
//             from: msg.from, 
//             body: msg.body,
//             isMedia: msg.hasMedia,
//             type: msg.type 
//         });
//     });
    
//     client.on('message_ack', (msg, ack) => {
//         const statusMap = { 1: 'sent', 2: 'delivered', 3: 'read', 4: 'played' };
//         // if (statusMap[ack]) {
//         //     sendWebhook('/update-status', { message_id: msg.id._serialized, status: statusMap[ack] });
//         // }
//     });

//     client.on('disconnected', async (reason) => {
//         console.log(`[DISCONNECTED] Client for ${sessionId} was logged out. Reason: ${reason}`);
//         sendWebhook('/disconnected', { sessionId, reason });
//         // Clean up
//         if (clients[sessionId]) {
//             await clients[sessionId].destroy();
//             delete clients[sessionId];
//         }
//     });

//     client.on('auth_failure', (msg) => {
//         console.error(`[AUTH_FAILURE] Session ${sessionId}:`, msg);
//         delete initializingSessions[sessionId];
//     });
// };


// /**
//  * --- LAZY LOADING SESSION GETTER ---
//  * The core of the solution. Gets an existing session or initializes a new one.
//  * @param {string} sessionId
//  * @returns {Promise<Client|null>}
//  */
// const getSession = (sessionId) => {
//     return new Promise((resolve, reject) => {
//         // 1. If the client is already ready, return it immediately
//         if (clients[sessionId] && clients[sessionId].info) {
//             console.log(`[SESSION] Using active session: ${sessionId}`);
//             return resolve(clients[sessionId]);
//         }

//         // 2. If a session is currently initializing, wait for it to be ready
//         if (initializingSessions[sessionId]) {
//             console.log(`[SESSION] Waiting for session to initialize: ${sessionId}`);
//             // Poll or use an event emitter; here we'll use a simple interval
//             const interval = setInterval(() => {
//                 if (clients[sessionId]) {
//                     clearInterval(interval);
//                     resolve(clients[sessionId]);
//                 }
//                 // Add a timeout condition here in a real-world app
//             }, 2000);
//             return;
//         }

//         // 3. If no session exists, create, setup, and initialize it
//         console.log(`[SESSION] Initializing new session: ${sessionId}`);
//         initializingSessions[sessionId] = true; // Mark as initializing

//         const client = createClient(sessionId);
//         setupClientEvents(client, sessionId);

//         client.once('ready', () => {
//              resolve(client);
//         });

//         client.initialize().catch(err => {
//             console.error(`[INIT_ERROR] Failed to initialize session ${sessionId}:`, err.message);
//             delete initializingSessions[sessionId];
//             reject(new Error('Initialization failed.'));
//         });
//     });
// };


// // --- API Endpoints ---

// /**
//  * POST /sessions/start
//  * Ensures a session is started. Called by Laravel to "wake up" a device.
//  */
// app.post('/sessions/start', async (req, res) => {
//     const { sessionId } = req.body;
//     if (!sessionId) {
//         return res.status(400).json({ error: 'Session ID is required.' });
//     }

//     // If already active, just confirm.
//     if (clients[sessionId]) {
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
//  * POST /messages/send
//  * Sends a message from a specific session.
//  */
// app.post('/messages/send', async (req, res) => {
//     const { sessionId, to, message, mediaUrl } = req.body;
//     if (!sessionId || !to || !message) {
//         return res.status(400).json({ error: 'Missing required parameters.' });
//     }

//     try {
//         const client = await getSession(sessionId);
//         if (!client) {
//             return res.status(404).json({ error: 'Session not ready or failed to initialize.' });
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
//     const client = clients[sessionId];

//     if (!client) {
//         return res.status(404).json({ error: 'Session not found or not active.' });
//     }

//     try {
//         await client.logout(); // This clears the session from the .wwebjs_auth folder
//         console.log(`[LOGOUT] Session ${sessionId} logged out.`);
//     } catch (err) {
//         console.error(`[LOGOUT_ERROR] Error during logout for ${sessionId}:`, err.message);
//     } finally {
//         if (clients[sessionId]) {
//            await clients[sessionId].destroy(); // Kill the puppeteer instance
//            delete clients[sessionId]; // Remove from active clients
//         }
//         res.status(200).json({ message: 'Session logged out and cleaned up.' });
//     }
// });


// // --- Server Startup ---
// app.listen(PORT, () => {
//     console.log(`WhatsApp Gateway running on port ${PORT}`);
//     console.log('Ready to handle requests. Sessions will be loaded on demand.');
// });

// // --- Graceful Shutdown ---
// const cleanup = async () => {
//     console.log('\n[SHUTDOWN] Cleaning up sessions...');
//     const shutdownPromises = Object.values(clients).map(client => client.destroy());
//     await Promise.all(shutdownPromises);
//     console.log('[SHUTDOWN] All sessions destroyed. Exiting.');
//     process.exit(0);
// };

// process.on('SIGINT', cleanup); // Catches Ctrl+C
// process.on('SIGTERM', cleanup); // Catches kill commands

// const express = require('express');
// const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
// const qrcode = require('qrcode');
// const axios = require('axios');

// const app = express();
// app.use(express.json());

// const clients = {};

// /**
//  * POST /sessions/start
//  * Starts a new session and returns a QR code for authentication.
//  * Body: { sessionId: "some-unique-id" }
//  */
// app.post('/sessions/start', (req, res) => {
//     const sessionId = req.body.sessionId;
//     if (!sessionId) {
//         return res.status(400).json({ error: 'Session ID is required.' });
//     }

//     if (clients[sessionId] && clients[sessionId].info) {
//         return res.status(200).json({ message: 'Session already exists and is connected.' });
//     }
    
//     console.log(`Starting session: ${sessionId}`);

//     // 1. Respond immediately to the Laravel request.
//     // This prevents the Laravel controller from timing out.
//     res.status(202).json({
//         message: 'Session process started. Waiting for QR code.',
//         sessionId: sessionId 
//     });

//     const client = new Client({
//         authStrategy: new LocalAuth({ clientId: sessionId }),
//         puppeteer: {
//             headless: true,
//             args: [
//                 '--no-sandbox', 
//                 '--disable-setuid-sandbox',
//                 '--disable-dev-shm-usage', // <-- FIX 1: Prevent crashes due to limited shared memory (essential in Docker/Linux)
//                 '--disable-accelerated-2d-canvas', // <-- FIX 2: Reduce GPU usage
//                 '--no-first-run',
//                 '--no-zygote',
//                 '--single-process', // <-- FIX 3: Use a single browser process, saving resources
//                 '--disable-gpu' // <-- FIX 4: Disable GPU hardware acceleration
//             ]
//         },
//         // FIX 5: Set a longer timeout (e.g., 60 seconds) for navigation
//         webVersionCache: {
//             type: 'remote',
//             remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
//         },
//         // Explicitly configure page-level timeout
//         options: {
//             timeout: 60000 // 60 seconds (1 minute)
//         }
//     });

//     client.on('qr', (qr) => {
//         console.log(`QR received for ${sessionId}`);
        
//         // THE FIX: Only send the response if the flag is false.
//         // if (!qrSent) {
//         //     qrcode.toDataURL(qr, (err, url) => {
//         //         if (err) {
//         //             res.status(500).json({ error: 'Failed to generate QR code.' });
//         //         } else {
//         //             res.status(200).json({ qr: url });
//         //         }
//         //         // THE FIX: Set the flag to true after sending the response.
//         //         qrSent = true; 
//         //     });
//         // }

//        // Instead of responding to the initial request,
//         // send the QR code back to the LARAVEL APPLICATION via a webhook.
//         qrcode.toDataURL(qr, (err, url) => {
//             if (err) {
//                 console.error(`QR generation error for ${sessionId}:`, err.message);
//                 return;
//             }
            
//             // NEW WEBHOOK: Send QR Code back to Laravel/React via a dedicated endpoint
//             axios.post('http://localhost:8000/webhook/qr-code-received', { 
//                 sessionId: sessionId,
//                 qrCodeUrl: url
//             }).catch(err => {
//                 console.error(`QR Webhook failed for ${sessionId}:`, err);
//             });
//         });

//     });

//     client.on('ready', () => {
//         console.log(`Client is ready for session: ${sessionId}`);
//         const clientInfo = client.info;
        
//         // FIX 2 & 3: Use http for local dev and add error handling
//         axios.post('http://localhost:8000/webhook/device-connected', {
//             sessionId: sessionId,
//             phone: clientInfo.wid.user 
//         }).catch(err => {
//             console.error(`Webhook for session ${sessionId} (ready) failed:`, err.message);
//         });
//     });

//     client.on('message', async (msg) => {
//         console.log(`Message received for ${sessionId}:`, msg.body);
        
//         // FIX 2 & 3: Use http for local dev and add error handling
//         axios.post('http://localhost:8000/webhook/message', { 
//             sessionId: sessionId, 
//             from: msg.from, 
//             body: msg.body 
//         }).catch(err => {
//             console.error(`Webhook for session ${sessionId} (message) failed:`, err.message);
//         });
//     });
    
//     client.on('disconnected', (reason) => {
//         console.log(`Client was logged out for ${sessionId}:`, reason);
//         delete clients[sessionId];
//     });

//     client.on('message_ack', (msg, ack) => {
//         const statusMap = {
//             1: 'sent',
//             2: 'delivered',
//             3: 'read'
//         };
        
//         if (statusMap[ack]) {
//             console.log(`ACK received for ${msg.id._serialized}: ${statusMap[ack]}`);
            
//             // FIX 2: Use http for local dev
//             axios.post('http://localhost:8000/webhook/status-update', {
//                 message_id: msg.id._serialized,
//                 status: statusMap[ack]
//             }).catch(err => console.error("ACK Webhook failed:", err.message));
//         }
//     });

//     client.initialize();
//     clients[sessionId] = client;
// });


// /**
//  * POST /messages/send
//  * Sends a message from a specific session.
//  * Body: { sessionId: "some-unique-id", to: "1234567890", message: "Hello!", mediaUrl?: "http://..." }
// */
// app.post('/messages/send', async (req, res) => {
//     const { sessionId, to, message, mediaUrl } = req.body;
    
//     if (!sessionId || !to || !message) {
//         return res.status(400).json({ error: 'Missing required parameters: sessionId, to, message.' });
//     }

//     const client = clients[sessionId];
//     if (!client || !(await client.getState() === 'CONNECTED')) {
//         return res.status(404).json({ error: 'Session not found or not connected.' });
//     }

//     try {
//         const chatId = `${to}@c.us`; // Format number to WhatsApp Chat ID

//         let finalMessage = message;

//         if (mediaUrl) {
//             // Send media (image/video/sticker)
//             const media = await MessageMedia.fromUrl(mediaUrl, { unsafeMime: true });
//             await client.sendMessage(chatId, media, { caption: message });
//         } else {
//             // Send plain text
//             await client.sendMessage(chatId, finalMessage);
//         }
        
//         res.status(200).json({ success: true, message: 'Message sent successfully.' });
//     } catch (error) {
//         console.error(error);
//         res.status(500).json({ success: false, error: 'Failed to send message.' });
//     }
// });


// const PORT = 3000;
// app.listen(PORT, () => {
//     console.log(`WhatsApp Gateway running on port ${PORT}`);
// });