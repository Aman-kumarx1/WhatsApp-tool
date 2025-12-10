const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs-extra');
const path = require('path');
const mime = require('mime-types');
const config = require('./config.json');

// --- SETUP ---
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: config.HEADLESS,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', // Fixes VM memory crashes
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    }
});

// --- EVENTS ---

client.on('qr', (qr) => {
    console.log('⚡ QR CODE GENERATED!');
    console.log('👉 A Chrome window has opened on your screen.');
    console.log('👉 Please scan the QR code inside that window.');
});

client.on('ready', async () => {
    console.log('✅ Client is ready!');
    console.log('🔄 Starting Synchronization (Filling gaps)...');
    await syncRecentMessages(); // Triggers sync on startup
    console.log('✅ Sync Complete! Listening for new messages...');
});

// Real-time Message Listener (Used for both Sync and Real-time)
client.on('message_create', async (msg) => {
    await processMessage(msg);
});

// --- CORE FUNCTIONS ---

// 1. Universal Message Processor (Handles Text, Media, View Once, and File Naming)
async function processMessage(msg) {
    try {
        const chat = await msg.getChat();
        // Check config to see if groups should be backed up
        if (chat.isGroup && !config.SAVE_GROUPS) return;

        // --- DYNAMIC FILE NAMING LOGIC ---
        let filenameBase = chat.id._serialized; // Default: full WhatsApp ID (number@c.us)
        
        if (!chat.isGroup) {
            const contact = await msg.getContact();
            // Get the name, or fall back to pushname, or the raw number ID
            const contactName = contact.name || contact.pushname || contact.id.user; 
            
            if (contactName) {
                // Sanitize the name for use as a safe filename (replaces invalid chars with _)
                filenameBase = contactName.replace(/[^a-zA-Z0-9_\- ]/g, '_').trim();
            }
        } else {
            // For groups, use the group subject/name if available
            filenameBase = chat.name || chat.id._serialized;
            filenameBase = filenameBase.replace(/[^a-zA-Z0-9_\- ]/g, '_').trim();
        }

        // --- PATH SETUP ---
        const dateStr = new Date(msg.timestamp * 1000).toISOString().split('T')[0];
        
        // 1. CHAT LOGS: Now saved in a contact-specific folder
        const contactChatDir = path.join(config.BACKUP_DIR, 'chats', filenameBase); 
        // 2. MEDIA: Saved in Date/Contact-specific folders
        const mediaDir = path.join(config.BACKUP_DIR, 'media', dateStr, filenameBase); 
        
        await fs.ensureDir(contactChatDir); // Ensure the contact's log folder exists

        // A. Save Text / Log
        if (config.SAVE_MESSAGES) {
            // The log file is now 'messages.json' inside the new contact-specific directory
            const logFile = path.join(contactChatDir, `messages.json`);
            
            const isDuplicate = await checkDuplicate(logFile, msg.id.id);
            
            if (!isDuplicate) {
                const messageData = {
                    id: msg.id.id,
                    from: msg.from,
                    to: msg.to,
                    author: msg.author || msg.from,
                    body: msg.body,
                    timestamp: new Date(msg.timestamp * 1000).toISOString(),
                    hasMedia: msg.hasMedia,
                    isSentByMe: msg.fromMe,
                    isViewOnce: msg.isViewOnce || false 
                };
                await appendToJson(logFile, messageData);
                console.log(`📝 Saved Log: ${msg.body.substring(0, 15)}... (${filenameBase})`);
            }
        }

        // B. Save Media (Standard & View Once)
        if (config.SAVE_MEDIA && msg.hasMedia) {
            
            if (msg.isViewOnce) {
                // Log to console when attempting to capture view once media
                console.log(`💣 VIEW ONCE MEDIA DETECTED! Attempting to capture: ${msg.id.id}`);
            }
            
            try {
                await fs.ensureDir(mediaDir);
                const media = await msg.downloadMedia();
                
                if (media) {
                    const extension = mime.extension(media.mimetype) || 'bin';
                    // Mark ViewOnce files in filename
                    const prefix = msg.isViewOnce ? 'VIEWONCE_' : '';
                    const filename = `${prefix}${msg.id.id}.${extension}`;
                    const filePath = path.join(mediaDir, filename);

                    if (!(await fs.pathExists(filePath))) {
                        await fs.writeFile(filePath, media.data, 'base64');
                        console.log(`💾 Media Saved: ${filename} to ${filenameBase}`);
                    }
                }
            } catch (err) {
                console.error(`❌ Failed to download media (${msg.id.id}):`, err.message);
            }
        }

    } catch (error) {
        console.error('Error processing message:', error.message);
    }
}
// 2. Synchronization Logic
async function syncRecentMessages() {
    try {
        const chats = await client.getChats();
        console.log(`📂 Found ${chats.length} active chats. Syncing last ${config.SYNC_LIMIT || 50} messages each...`);

        for (const chat of chats) {
            if (chat.isGroup && !config.SAVE_GROUPS) continue;
            
            const limit = config.SYNC_LIMIT || 50; 
            
            // Fetches messages from the chat history
            const messages = await chat.fetchMessages({ limit: limit });
            
            for (const msg of messages) {
                await processMessage(msg); // Uses the main processor to save if not duplicate
            }
            
            // Small delay to prevent banning/flooding
            await new Promise(r => setTimeout(r, 500)); 
        }
    } catch (err) {
        console.error('Sync Error:', err);
    }
}

// 3. Helper: Append safely to JSON
async function appendToJson(filePath, newData) {
    let data = [];
    try {
        if (await fs.pathExists(filePath)) data = await fs.readJson(filePath);
    } catch (err) { data = []; }
    
    // Check if the message is already the latest one (minor optimization)
    if (data.length > 0 && data[data.length - 1].id === newData.id) return;

    data.push(newData);
    await fs.writeJson(filePath, data, { spaces: 2 });
}

// 4. Helper: Check for duplicates
async function checkDuplicate(filePath, msgId) {
    try {
        if (await fs.pathExists(filePath)) {
            const data = await fs.readJson(filePath);
            return data.some(m => m.id === msgId);
        }
    } catch (err) { return false; }
    return false;
}

client.initialize();