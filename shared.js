const { createClient } = require('redis');
const axios = require('axios');

// --- Shared Redis Client ---
const createRedisClient = () => {
    const client = createClient({
        url: `redis://${process.env.REDIS_HOST || '127.0.0.1'}:${process.env.REDIS_PORT || 6379}`,
        ...(process.env.REDIS_PASSWORD && process.env.REDIS_PASSWORD !== 'null' && { 
            password: process.env.REDIS_PASSWORD 
        })
    });
    client.on('error', err => console.error('[REDIS_ERROR]', err));
    return client;
};

// --- Shared Webhook Helper ---
const sendWebhook = async (endpoint, data, retries = 3) => {
    const WEBHOOK_BASE_URL = process.env.WEBHOOK_BASE_URL || 'http://localhost:8000/webhook';
    const API_KEY = process.env.API_KEY;

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

// --- **NEW: Baileys Error Classifier** ---
const classifyError = (err) => {
    const rawMessage = err.message || 'Unknown error.';
    
    // Baileys-specific errors
    if (rawMessage.includes('invalid jid')) {
        return {
            code: 'invalid_number_format',
            friendly: 'The phone number format is incorrect (e.g., missing 62).',
            raw: rawMessage
        };
    }
    if (rawMessage.includes('rate-overlimit')) {
         return {
            code: 'rate_limit',
            friendly: 'You are sending messages too quickly. The system will pause.',
            raw: rawMessage
        };
    }
    if (rawMessage.includes('item-not-found')) {
         return {
            code: 'not_on_whatsapp',
            friendly: 'This phone number is not registered on WhatsApp.',
            raw: rawMessage
        };
    }
    if (rawMessage.includes('Connection Closed')) {
         return {
            code: 'connection_lost',
            friendly: 'The connection to the device was lost.',
            raw: rawMessage
        };
    }
    if (rawMessage.includes('failed to download') || rawMessage.includes('Could not find a valid URL')) {
        return {
            code: 'media_failed',
            friendly: 'The system could not download the media file.',
            raw: rawMessage
        };
    }

    // Default
    return {
        code: 'unknown',
        friendly: 'An unknown error occurred. See logs for details.',
        raw: rawMessage
    };
};

module.exports = {
    createRedisClient,
    sendWebhook,
    classifyError,
};