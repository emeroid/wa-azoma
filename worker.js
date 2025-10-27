const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { createRedisClient, sendWebhook, classifyError } = require('./shared');

require('dotenv').config();

// --- Redis Clients ---
const redisClient = createRedisClient(); // For re-queueing
const queueClient = redisClient.duplicate(); // For blocking pop

// --- Config ---
const WORKER_ID = `whatsapp-queue-${uuidv4()}`;
const CHANNEL_NAME = process.env.LARAVEL_CHANNEL || 'whatsapp:send_queue';
const WEB_SERVER_URL = `http://localhost:${process.env.PORT || 3000}`;

const listenForMessages = async () => {
    await redisClient.connect();
    await queueClient.connect();
    console.log(`[REDIS] Queue worker ${WORKER_ID} connected and listening to list "${CHANNEL_NAME}"`);

    // The reliable BRPOP loop
    while (true) {
        let jobPayload = null;
        let job = null;

        try {
            // Wait forever for a job
            const result = await queueClient.brPop(CHANNEL_NAME, 0);
            jobPayload = result.element;
            job = JSON.parse(jobPayload);
            
            // const { sessionId, tempMessageId } = job;

            // Ask the Web Server (index.js) to send the message
            await axios.post(`${WEB_SERVER_URL}/messages/send-internal`, job, {
                headers: { 'X-API-KEY': process.env.API_KEY }
            });

        } catch (err) {
            console.error(`[QUEUE_ERROR] Failed to process job:`, err.message);
            
            let errorToReport = err;
            
            if (err.response) {
                // This was an error from the Web Server (index.js)
                errorToReport = new Error(err.response.data?.details || err.response.data?.error || 'Failed in web server');
                
                if (err.response.status === 404 && jobPayload) {
                    // 404 = Session not active on that worker. Re-queue it.
                    console.warn(`[QUEUE] Web server ${WEB_SERVER_URL} did not have session ${job.sessionId}. Re-queueing.`);
                    await redisClient.rPush(CHANNEL_NAME, jobPayload);
                    await new Promise(res => setTimeout(res, 1000)); // Wait 1s
                    continue; // Skip failure report
                }
            }

            // Report the failure to Laravel
            if (job && job.tempMessageId) {
                const errorDetails = classifyError(errorToReport);
                sendWebhook('/message-failed', {
                    tempMessageId: job.tempMessageId,
                    sessionId: job.sessionId,
                    reason: errorDetails.raw,
                    errorCode: errorDetails.code,
                    friendlyError: errorDetails.friendly
                });
            } else if (jobPayload) {
                // Job was invalid JSON
                console.error(`[QUEUE_FATAL] Could not parse job. Moving to failed_jobs list.`);
                await redisClient.lPush('whatsapp:failed_jobs', jobPayload);
            }
        }
    }
};

listenForMessages();