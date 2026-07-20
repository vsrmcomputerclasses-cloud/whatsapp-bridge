import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";
import express from "express";
import qrcode from "qrcode";
import axios from "axios";
import pino from "pino";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const LARAVEL_WEBHOOK = "https://vsrm.in/api/whatsapp/webhook";
const LARAVEL_QUEUE = "https://vsrm.in/api/whatsapp/queue";
const LARAVEL_MARK_SENT = "https://vsrm.in/api/whatsapp/mark-sent";

// Active Sessions Store: { [sessionId]: { sock, connectionStatus, latestQr, authFolder } }
const sessions = {};

function sanitizeSessionId(id) {
    if (!id || id === 'undefined' || id === 'null') return 'main';
    return String(id).replace(/[^a-zA-Z0-9_-]/g, '');
}

async function getOrCreateSession(rawSessionId = 'main') {
    const sessionId = sanitizeSessionId(rawSessionId);

    if (sessions[sessionId] && sessions[sessionId].sock) {
        return sessions[sessionId];
    }

    const authFolder = path.join('auth_info_baileys', `session_${sessionId}`);
    if (!fs.existsSync(authFolder)) {
        fs.mkdirSync(authFolder, { recursive: true });
    }

    const sessionData = {
        sessionId,
        authFolder,
        sock: null,
        connectionStatus: 'disconnected', // disconnected, connecting, connected
        latestQr: null
    };

    sessions[sessionId] = sessionData;

    try {
        const { state, saveCreds } = await useMultiFileAuthState(authFolder);
        
        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' })
        });

        sessionData.sock = sock;

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;
            
            if (qr) {
                sessionData.latestQr = qr;
            }

            if (connection === 'close') {
                sessionData.connectionStatus = "disconnected";
                sessionData.latestQr = null;
                const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                console.log(`[Session: ${sessionId}] Connection closed, reconnecting: ${shouldReconnect}`);
                
                if (shouldReconnect) {
                    setTimeout(() => {
                        delete sessions[sessionId];
                        getOrCreateSession(sessionId);
                    }, 3000);
                } else {
                    // Session logged out -> clean up files
                    delete sessions[sessionId];
                    try {
                        fs.rmSync(authFolder, { recursive: true, force: true });
                    } catch (e) {}
                }
            } else if (connection === 'connecting') {
                sessionData.connectionStatus = "connecting";
            } else if (connection === 'open') {
                sessionData.connectionStatus = "connected";
                sessionData.latestQr = null;
                console.log(`🟢 [Session: ${sessionId}] WhatsApp connection opened successfully!`);
            }
        });

        sock.ev.on('creds.update', saveCreds);

        // Listen for incoming messages for this session
        sock.ev.on('messages.upsert', async (m) => {
            if (m.type !== 'notify') return;
            
            for (const msg of m.messages) {
                if (msg.key.fromMe) continue;
                if (msg.key.remoteJid.endsWith('@g.us')) continue;

                const senderPhone = msg.key.remoteJid.split('@')[0];
                const messageText = msg.message?.conversation || 
                                    msg.message?.extendedTextMessage?.text || 
                                    msg.message?.imageMessage?.caption || "";

                if (!messageText) continue;

                console.log(`[Session: ${sessionId}] Message from ${senderPhone}: ${messageText}`);

                // Forward to Laravel Webhook with session_id
                try {
                    await axios.post(LARAVEL_WEBHOOK, {
                        phone: senderPhone,
                        message: messageText,
                        session_id: sessionId,
                        franchise_id: sessionId
                    });
                } catch (err) {
                    console.error(`[Session: ${sessionId}] Webhook error:`, err.message);
                }
            }
        });

        return sessionData;

    } catch (err) {
        console.error(`Error initializing session ${sessionId}:`, err);
        sessionData.connectionStatus = 'error';
        return sessionData;
    }
}

// Auto-initialize 'main' session on startup
getOrCreateSession('main');

// Auto-initialize existing saved sessions on startup
if (fs.existsSync('auth_info_baileys')) {
    const folders = fs.readdirSync('auth_info_baileys');
    for (const f of folders) {
        if (f.startsWith('session_')) {
            const sid = f.replace('session_', '');
            if (sid && sid !== 'main') {
                getOrCreateSession(sid);
            }
        }
    }
}

// Poll Outgoing Queue every 5 seconds
setInterval(async () => {
    try {
        const response = await axios.get(LARAVEL_QUEUE);
        if (response.data && response.data.success && Array.isArray(response.data.queue)) {
            for (const item of response.data.queue) {
                const { id, phone, message, session_id, franchise_id } = item;
                if (!phone || !message) continue;

                const targetSessionId = sanitizeSessionId(session_id || franchise_id || 'main');
                const session = await getOrCreateSession(targetSessionId);

                if (session.connectionStatus !== 'connected' || !session.sock) {
                    console.log(`[Queue Skip] Session ${targetSessionId} not connected for item ${id}`);
                    continue;
                }

                let cleanPhone = phone.replace(/[^0-9]/g, '');
                if (cleanPhone.length === 10) {
                    cleanPhone = '91' + cleanPhone;
                }
                const jid = `${cleanPhone}@s.whatsapp.net`;

                try {
                    await session.sock.sendMessage(jid, { text: message });
                    console.log(`✓ [Session: ${targetSessionId}] Sent message to ${cleanPhone} [${id}]`);

                    // Mark as sent in Laravel
                    await axios.post(LARAVEL_MARK_SENT, { id });
                } catch (sendErr) {
                    console.error(`[Session: ${targetSessionId}] Send error for ${cleanPhone}:`, sendErr.message);
                }
            }
        }
    } catch (err) {
        // Silent queue poll error
    }
}, 5000);

// REST API endpoint to send a message
app.post('/send-message', async (req, res) => {
    const { phone, message, session_id, franchise_id } = req.body;

    if (!phone || !message) {
        return res.status(400).json({ error: "Phone and message are required" });
    }

    const targetSessionId = sanitizeSessionId(session_id || franchise_id || 'main');
    const session = await getOrCreateSession(targetSessionId);

    if (session.connectionStatus !== 'connected' || !session.sock) {
        return res.status(503).json({ error: `WhatsApp session [${targetSessionId}] is not connected` });
    }

    try {
        let cleanPhone = phone.replace(/[^0-9]/g, '');
        if (cleanPhone.length === 10) {
            cleanPhone = '91' + cleanPhone;
        }
        const jid = `${cleanPhone}@s.whatsapp.net`;

        await session.sock.sendMessage(jid, { text: message });
        console.log(`[Session: ${targetSessionId}] Sent API message to ${cleanPhone}`);
        return res.json({ success: true, session_id: targetSessionId });
    } catch (err) {
        console.error(`[Session: ${targetSessionId}] Error:`, err);
        return res.status(500).json({ error: "Failed to send message", details: err.message });
    }
});

// JSON Status Endpoint per session
app.get('/status/:session_id?', async (req, res) => {
    const sid = sanitizeSessionId(req.params.session_id || req.query.session_id || 'main');
    const session = await getOrCreateSession(sid);
    return res.json({
        session_id: sid,
        status: session.connectionStatus,
        has_qr: !!session.latestQr
    });
});

// Logout session endpoint
app.post('/logout/:session_id', async (req, res) => {
    const sid = sanitizeSessionId(req.params.session_id);
    const session = sessions[sid];
    
    if (session && session.sock) {
        try {
            await session.sock.logout();
        } catch (e) {}
    }
    
    delete sessions[sid];
    const authFolder = path.join('auth_info_baileys', `session_${sid}`);
    try {
        fs.rmSync(authFolder, { recursive: true, force: true });
    } catch (e) {}

    return res.json({ success: true, message: `Session ${sid} logged out successfully` });
});

// Helper function to render QR page HTML
async function renderQrHtml(session) {
    const { sessionId, connectionStatus, latestQr } = session;

    if (connectionStatus === 'connected') {
        return `
            <!DOCTYPE html>
            <html>
            <head>
                <title>WhatsApp Chatbot Status - ${sessionId}</title>
                <style>
                    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; text-align: center; background-color: #f0f2f5; padding-top: 50px; }
                    .card { background: white; padding: 40px; border-radius: 10px; display: inline-block; box-shadow: 0 4px 15px rgba(0,0,0,0.1); max-width: 500px; }
                    .status { font-weight: bold; color: #25D366; font-size: 1.5em; margin-bottom: 10px; }
                    .badge { background: #e8f5e9; color: #2e7d32; padding: 5px 12px; border-radius: 15px; font-weight: bold; display: inline-block; margin-bottom: 20px; }
                    .btn-danger { background: #ff5252; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; font-weight: bold; text-decoration: none; display: inline-block; margin-top: 15px; }
                </style>
            </head>
            <body>
                <div class="card">
                    <div style="font-size: 4em; margin-bottom: 10px;">🟢</div>
                    <div class="status">WhatsApp Connected!</div>
                    <div class="badge">Session: ${sessionId}</div>
                    <p>This WhatsApp device is active and sending notifications.</p>
                    <button class="btn-danger" onclick="logoutSession()">Disconnect / Logout</button>
                </div>
                <script>
                    async function logoutSession() {
                        if (confirm("Disconnect this WhatsApp device?")) {
                            await fetch('/logout/${sessionId}', { method: 'POST' });
                            window.location.reload();
                        }
                    }
                </script>
            </body>
            </html>
        `;
    }

    if (latestQr) {
        try {
            const qrDataUrl = await qrcode.toDataURL(latestQr);
            return `
                <!DOCTYPE html>
                <html>
                <head>
                    <title>WhatsApp Setup - ${sessionId}</title>
                    <style>
                        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; text-align: center; background-color: #f0f2f5; padding-top: 40px; }
                        .card { background: white; padding: 35px; border-radius: 10px; display: inline-block; box-shadow: 0 4px 15px rgba(0,0,0,0.1); max-width: 480px; }
                        .status { font-weight: bold; color: #ff9800; font-size: 1.3em; margin-bottom: 15px; }
                        .qr-box { margin: 15px 0; border: 1px solid #ddd; padding: 10px; display: inline-block; background: #fff; border-radius: 8px; }
                        ol { text-align: left; margin-top: 15px; font-size: 0.95em; }
                        li { margin-bottom: 8px; }
                        .badge { background: #fff3e0; color: #e65100; padding: 4px 10px; border-radius: 12px; font-weight: bold; display: inline-block; }
                    </style>
                    <script>
                        setTimeout(function() {
                            window.location.reload();
                        }, 12000);
                    </script>
                </head>
                <body>
                    <div class="card">
                        <div class="status">WhatsApp Setup Required</div>
                        <div class="badge">Session: ${sessionId}</div>
                        <p style="margin-top: 10px;">Scan this QR code using WhatsApp on your phone:</p>
                        
                        <div class="qr-box">
                            <img src="${qrDataUrl}" alt="Scan QR Code" style="width: 240px; height: 240px;" />
                        </div>
                        
                        <ol>
                            <li>Open <strong>WhatsApp</strong> on your phone.</li>
                            <li>Tap <strong>Menu</strong> or <strong>Settings</strong> -> <strong>Linked Devices</strong>.</li>
                            <li>Tap <strong>Link a Device</strong> and point your camera to this QR code.</li>
                        </ol>
                    </div>
                </body>
                </html>
            `;
        } catch (err) {
            return "Error rendering QR code: " + err.message;
        }
    }

    return `
        <!DOCTYPE html>
        <html>
        <head>
            <title>WhatsApp Connecting - ${sessionId}</title>
            <style>
                body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; text-align: center; background-color: #f0f2f5; padding-top: 80px; }
                .loader { border: 6px solid #f3f3f3; border-top: 6px solid #25D366; border-radius: 50%; width: 45px; height: 45px; animation: spin 1.5s linear infinite; display: inline-block; margin-bottom: 20px; }
                @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
            </style>
            <script>
                setTimeout(function() {
                    window.location.reload();
                }, 3000);
            </script>
        </head>
        <body>
            <div class="loader"></div>
            <h3>Connecting session [${sessionId}], please wait...</h3>
            <p>Page auto-refreshes every 3 seconds.</p>
        </body>
        </html>
    `;
}

// Session-specific QR Landing Page
app.get('/qr/:session_id?', async (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    const sid = sanitizeSessionId(req.params.session_id || req.query.session_id || 'main');
    const session = await getOrCreateSession(sid);
    const html = await renderQrHtml(session);
    return res.send(html);
});

// Default Landing Page
app.get('/', async (req, res) => {
    res.setHeader('Content-Type', 'text/html');
    const sid = sanitizeSessionId(req.query.session_id || req.query.franchise_id || 'main');
    const session = await getOrCreateSession(sid);
    const html = await renderQrHtml(session);
    return res.send(html);
});

// Start Express server
app.listen(PORT, () => {
    console.log(`🟢 Multi-Session WhatsApp Bridge running on port ${PORT}`);
});
