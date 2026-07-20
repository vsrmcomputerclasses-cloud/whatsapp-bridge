import makeWASocket, { useMultiFileAuthState, DisconnectReason } from "@whiskeysockets/baileys";
import express from "express";
import qrcode from "qrcode";
import axios from "axios";
import pino from "pino";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const LARAVEL_WEBHOOK = "https://vsrm.in/api/whatsapp/webhook";
const LARAVEL_QUEUE = "https://vsrm.in/api/whatsapp/queue";
const LARAVEL_MARK_SENT = "https://vsrm.in/api/whatsapp/mark-sent";

let sock = null;
let latestQr = null;
let connectionStatus = "disconnected"; // disconnected, connecting, connected

async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    
    sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' })
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            latestQr = qr;
        }

        if (connection === 'close') {
            connectionStatus = "disconnected";
            latestQr = null;
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Connection closed due to ', lastDisconnect?.error, ', reconnecting: ', shouldReconnect);
            if (shouldReconnect) {
                setTimeout(connectToWhatsApp, 3000);
            }
        } else if (connection === 'connecting') {
            connectionStatus = "connecting";
        } else if (connection === 'open') {
            connectionStatus = "connected";
            latestQr = null;
            console.log('WhatsApp connection opened successfully!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // Listen for incoming messages
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        
        for (const msg of m.messages) {
            // Ignore messages from ourselves or groups
            if (msg.key.fromMe) continue;
            if (msg.key.remoteJid.endsWith('@g.us')) continue;

            const senderPhone = msg.key.remoteJid.split('@')[0];
            const messageText = msg.message?.conversation || 
                                msg.message?.extendedTextMessage?.text || 
                                msg.message?.imageMessage?.caption || "";

            if (!messageText) continue;

            console.log(`Received message from ${senderPhone}: ${messageText}`);

            // Forward message to Laravel Webhook
            try {
                await axios.post(LARAVEL_WEBHOOK, {
                    phone: senderPhone,
                    message: messageText
                });
            } catch (err) {
                console.error("Failed to forward message to Laravel:", err.message);
            }
        }
    });
}

// Poll Outgoing Queue every 5 seconds
setInterval(async () => {
    if (connectionStatus !== 'connected' || !sock) return;

    try {
        const response = await axios.get(LARAVEL_QUEUE);
        if (response.data && response.data.success && Array.isArray(response.data.queue)) {
            for (const item of response.data.queue) {
                const { id, phone, message } = item;
                if (!phone || !message) continue;

                let cleanPhone = phone.replace(/[^0-9]/g, '');
                if (cleanPhone.length === 10) {
                    cleanPhone = '91' + cleanPhone;
                }
                const jid = `${cleanPhone}@s.whatsapp.net`;

                try {
                    await sock.sendMessage(jid, { text: message });
                    console.log(`✓ Queued Message Sent to ${cleanPhone} [${id}]`);

                    // Mark as sent in Laravel
                    await axios.post(LARAVEL_MARK_SENT, { id });
                } catch (sendErr) {
                    console.error(`Failed to send queued message to ${cleanPhone}:`, sendErr.message);
                }
            }
        }
    } catch (err) {
        // Silent queue poll error
    }
}, 5000);

// REST API endpoint to send a message
app.post('/send-message', async (req, res) => {
    const { phone, message } = req.body;

    if (!phone || !message) {
        return res.status(400).json({ error: "Phone and message are required" });
    }

    if (connectionStatus !== 'connected' || !sock) {
        return res.status(503).json({ error: "WhatsApp client is not connected" });
    }

    try {
        // Clean phone number and convert to JID format
        let cleanPhone = phone.replace(/[^0-9]/g, '');
        if (cleanPhone.length === 10) {
            cleanPhone = '91' + cleanPhone;
        }
        const jid = `${cleanPhone}@s.whatsapp.net`;

        await sock.sendMessage(jid, { text: message });
        console.log(`Sent message to ${cleanPhone}`);
        return res.json({ success: true });
    } catch (err) {
        console.error("Error sending message:", err);
        return res.status(500).json({ error: "Failed to send message", details: err.message });
    }
});

// Main Landing Page showing connection status or QR code
app.get('/', async (req, res) => {
    res.setHeader('Content-Type', 'text/html');

    if (connectionStatus === 'connected') {
        return res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>WhatsApp Chatbot Status</title>
                <style>
                    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; text-align: center; background-color: #f0f2f5; padding-top: 50px; }
                    .card { background: white; padding: 40px; border-radius: 10px; display: inline-block; box-shadow: 0 4px 15px rgba(0,0,0,0.1); }
                    .status { font-weight: bold; color: #25D366; font-size: 1.5em; margin-bottom: 20px; }
                </style>
            </head>
            <body>
                <div class="card">
                    <div style="font-size: 4em; margin-bottom: 10px;">🟢</div>
                    <div class="status">WhatsApp Chatbot is Connected!</div>
                    <p>Your AI counselor chatbot is active and listening for queries on this WhatsApp number.</p>
                </div>
            </body>
            </html>
        `);
    }

    if (latestQr) {
        try {
            const qrDataUrl = await qrcode.toDataURL(latestQr);
            return res.send(`
                <!DOCTYPE html>
                <html>
                <head>
                    <title>WhatsApp QR Code Setup</title>
                    <style>
                        body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; text-align: center; background-color: #f0f2f5; padding-top: 50px; }
                        .card { background: white; padding: 40px; border-radius: 10px; display: inline-block; box-shadow: 0 4px 15px rgba(0,0,0,0.1); max-width: 500px; }
                        .status { font-weight: bold; color: #ff9800; font-size: 1.3em; margin-bottom: 20px; }
                        .qr-box { margin: 20px 0; border: 1px solid #ddd; padding: 10px; display: inline-block; background: #fff; }
                        ol { text-align: left; margin-top: 20px; }
                        li { margin-bottom: 10px; }
                    </style>
                    <script>
                        // Auto refresh the page every 15 seconds to fetch new QR if it expires
                        setTimeout(function() {
                            window.location.reload();
                        }, 15000);
                    </script>
                </head>
                <body>
                    <div class="card">
                        <div style="font-size: 3em; margin-bottom: 10px;">⏳</div>
                        <div class="status">WhatsApp Setup Required</div>
                        <p>Scan this QR code using your WhatsApp to link the AI Chatbot:</p>
                        
                        <div class="qr-box">
                            <img src="${qrDataUrl}" alt="Scan QR Code" style="width: 250px; height: 250px;" />
                        </div>
                        
                        <ol>
                            <li>Open <strong>WhatsApp</strong> on your phone.</li>
                            <li>Tap <strong>Menu</strong> or <strong>Settings</strong> and select <strong>Linked Devices</strong>.</li>
                            <li>Tap on <strong>Link a Device</strong> and point your camera to this QR code.</li>
                        </ol>
                        
                        <p style="color: #666; font-size: 0.9em; margin-top: 20px;">This page auto-refreshes every 15s.</p>
                    </div>
                </body>
                </html>
            `);
        } catch (err) {
            return res.send("Error rendering QR code: " + err.message);
        }
    }

    return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>WhatsApp Bot Connecting</title>
            <style>
                body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; text-align: center; background-color: #f0f2f5; padding-top: 80px; }
                .loader { border: 8px solid #f3f3f3; border-top: 8px solid #3498db; border-radius: 50%; width: 50px; height: 50px; animation: spin 2s linear infinite; display: inline-block; margin-bottom: 20px; }
                @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
            </style>
            <script>
                setTimeout(function() {
                    window.location.reload();
                }, 4000);
            </script>
        </head>
        <body>
            <div class="loader"></div>
            <h3>Generating QR Code, please wait...</h3>
            <p>The page will automatically reload once the QR is ready.</p>
        </body>
        </html>
    `);
});

// Start Express server and initiate WhatsApp connection
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    connectToWhatsApp();
});
