const { Client, LocalAuth } = require('whatsapp-web.js');
const fs = require('fs-extra');
const path = require('path');
const mime = require('mime-types');
const QRCode = require('qrcode-terminal');
const config = require('./config.json');

// --- SETUP ---
const client = new Client({
    // LocalAuth stores session data in the .wwebjs_auth directory
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

let lastQRTime = 0;

client.on('qr', (qr) => {
    // Display QR code directly in terminal using qrcode-terminal
    const now = Date.now();
    
    // Only display QR code every 3 seconds to avoid spam
    if (now - lastQRTime > 3000) {
        console.clear();
        console.log('\n⚡ QR CODE GENERATED! Scan with WhatsApp > Linked Devices:\n');
        QRCode.generate(qr, { small: true });
        console.log('\n📱 Open WhatsApp > Linked Devices and scan the QR code above\n');
        lastQRTime = now;
    }
});

client.on('ready', async () => {
    console.log('✅ Client is ready!');
    console.log('🔄 Starting Synchronization (Filling gaps since last log out)...');
    await syncRecentMessages(); // Triggers sync on startup
    console.log('✅ Sync Complete! Listening for new messages...');
});

// Real-time Message Listener (Used for both Sync and Real-time)
client.on('message_create', async (msg) => {
    await processMessage(msg);
});

// Error event handler
client.on('error', (error) => {
    console.error('❌ Client Error:', error.message);
});

// Disconnected event handler (MODIFIED FOR CLEAN EXIT)
client.on('disconnected', async (reason) => {
    console.log(`⚠️ Client disconnected. Reason: ${reason}. Triggering clean shutdown...`);
    
    try {
        // 1. Destroy the client instance to release resources/locks
        await client.destroy(); 
        console.log('✅ Client instance destroyed successfully.');
    } catch (err) {
        console.error('❌ Error during client destruction:', err.message);
    }
    
    // 2. Exit the current Node.js process. 
    // This is the signal for PM2 (or any other process manager) to restart the script.
    await new Promise(r => setTimeout(r, 2000)); // Wait a moment for OS cleanup
    console.log('🔄 Restarting application via process manager...');
    process.exit(0); 
});

// --- CORE FUNCTIONS ---

// 5. Helper: Get a safe, descriptive filename/folder name for the chat
async function getChatFilenameBase(chat, msgFrom) {
    let filenameBase = chat.id._serialized; // Default: full WhatsApp ID
    
    if (!chat.isGroup) {
        try {
            // Use getContactById() with chat.id._serialized (which is the partner's ID)
            const contact = await client.getContactById(chat.id._serialized);
            // Get the name, or fall back to pushname, or the raw number ID
            const contactName = contact.name || contact.pushname || contact.id.user; 
            
            if (contactName) {
                // Sanitize the name for use as a safe filename
                filenameBase = contactName.replace(/[^a-zA-Z0-9_\- ]/g, '_').trim();
            }
        } catch (contactErr) {
            // If contact retrieval fails, fall back to phone number from the message or chat ID
            const phoneNumber = msgFrom ? msgFrom.split('@')[0] : chat.id.user;
            if (phoneNumber && phoneNumber.length > 0) {
                filenameBase = phoneNumber;
            }
            // console.warn(`⚠️ Contact retrieval error for ${chat.id._serialized}:`, contactErr.message);
        }
    } else {
        // For groups, use the group subject/name if available
        filenameBase = (chat.name && chat.name.trim()) || chat.id._serialized;
        filenameBase = filenameBase.replace(/[^a-zA-Z0-9_\- ]/g, '_').trim();
    }
    return filenameBase;
}


// 1. Universal Message Processor (Handles Text, Media, View Once, and File Naming)
async function processMessage(msg) {
    try {
        const chat = await msg.getChat();
        // Check config to see if groups should be backed up
        if (chat.isGroup && !config.SAVE_GROUPS) return;

        // --- DYNAMIC FILE NAMING LOGIC ---
        // Pass msg.from to the helper to ensure we have a fallback phone number
        const filenameBase = await getChatFilenameBase(chat, msg.from); 

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

// 2. Synchronization Logic (Modified for Chronological Integrity)
async function syncRecentMessages() {
    try {
        const chats = await client.getChats();
        
        // Use 99999 as the reliable default for sync-all
        const limit = config.SYNC_LIMIT || 99999; 
        
        console.log(`📂 Found ${chats.length} active chats. Syncing last ${limit} messages each...`);

        for (const chat of chats) {
            if (chat.isGroup && !config.SAVE_GROUPS) continue;
            
            // Fetches messages from the chat history
            const messages = await chat.fetchMessages({ 
                limit: limit,
                fromMe: true // Include messages sent by me in the sync
            });
            
            // CRITICAL FIX: messages are returned newest-first. Reverse them to process 
            // oldest-first, ensuring chronological order in the log file.
            for (const msg of messages.reverse()) { 
                await processMessage(msg); // Deduplication handles skipping existing messages
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

// Initialize the client with error handling
client.initialize().catch((err) => {
    console.error('❌ Failed to initialize client:', err.message);
    process.exit(1);
});