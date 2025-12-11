const fs = require('fs-extra');
const path = require('path');
const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const backupDir = path.join(__dirname, 'backup', 'chats');

async function listChats() {
    try {
        const chatFolders = await fs.readdir(backupDir);
        
        if (chatFolders.length === 0) {
            console.log('\n📭 No chats found. Start the backup tool first!\n');
            rl.close();
            return;
        }

        console.log('\n📱 Available Chats:\n');
        chatFolders.forEach((folder, index) => {
            console.log(`${index + 1}. ${folder}`);
        });

        rl.question('\nSelect a chat number to view (or 0 to exit): ', async (answer) => {
            const num = parseInt(answer);
            
            if (num === 0) {
                rl.close();
                return;
            }

            if (num > 0 && num <= chatFolders.length) {
                const selectedChat = chatFolders[num - 1];
                await displayChat(selectedChat);
            } else {
                console.log('\n❌ Invalid selection!\n');
                rl.close();
            }
        });
    } catch (err) {
        console.error('Error reading chats:', err.message);
        rl.close();
    }
}

async function displayChat(chatName) {
    try {
        const messagesFile = path.join(backupDir, chatName, 'messages.json');
        
        if (!(await fs.pathExists(messagesFile))) {
            console.log('\n❌ No messages found for this chat!\n');
            rl.close();
            return;
        }

        const messages = await fs.readJson(messagesFile);
        
        console.log('\n' + '='.repeat(80));
        console.log(`💬 Chat: ${chatName}`);
        console.log('='.repeat(80) + '\n');

        messages.forEach((msg, index) => {
            const timestamp = new Date(msg.timestamp).toLocaleString();
            const sender = msg.isSentByMe ? '👤 You' : `👥 ${msg.author}`;
            const viewOnceLabel = msg.isViewOnce ? ' [VIEW ONCE]' : '';
            const mediaLabel = msg.hasMedia ? ` [${msg.mediaType?.toUpperCase() || 'MEDIA'}${viewOnceLabel}]` : '';

            console.log(`[${index + 1}] ${timestamp}`);
            console.log(`${sender}`);
            console.log(`${msg.body}${mediaLabel}`);
            console.log('---\n');
        });

        console.log('='.repeat(80));
        console.log(`📊 Total Messages: ${messages.length}`);
        console.log('='.repeat(80) + '\n');

        rl.close();
    } catch (err) {
        console.error('Error displaying chat:', err.message);
        rl.close();
    }
}

// Start
listChats();
