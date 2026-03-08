const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const cheerio = require('cheerio');
const { Octokit } = require('@octokit/rest');
const moment = require('moment-timezone');
const Jimp = require('jimp');
const crypto = require('crypto');
const axios = require('axios');
const FormData = require("form-data");
const os = require('os'); 
const { sms, downloadMediaMessage } = require("./msg");
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    getContentType,
    makeCacheableSignalKeyStore,
    Browsers,
    jidNormalizedUser,
    downloadContentFromMessage,
    proto,
    prepareWAMessageMedia,
    generateWAMessageFromContent,
    S_WHATSAPP_NET
} = require('@whiskeysockets/baileys');

const config = {
    AUTO_VIEW_STATUS: 'true',
    AUTO_LIKE_STATUS: 'true',
    AUTO_RECORDING: 'true',
    AUTO_LIKE_EMOJI: ['💋', '😶', '✨️', '💗', '🎈', '🎉', '🥳', '❤️', '🧫', '🐭'],
    PREFIX: '.',
    MAX_RETRIES: 3,
    // Updated with the new png image link
    IMAGE_PATH: 'https://files.catbox.moe/jtzm4o.png',
    GROUP_INVITE_LINK: 'https://chat.whatsapp.com/KpiwcCbP0eu5cqMKjAo29z?mode=gi_t',
    ADMIN_LIST_PATH: './admin.json',
    RCD_IMAGE_PATH: 'https://files.catbox.moe/jtzm4o.png',
    // Updated Newsletter JID
    NEWSLETTER_JID: '120363377534493877@newsletter',
    NEWSLETTER_MESSAGE_ID: '428',
    OTP_EXPIRY: 300000,
    version: '9.0.0',
    // Updated Owner Number
    OWNER_NUMBER: '2349120185747',
    BOT_NAME: 'DANI V9',
    BOT_FOOTER: '> Powered by Damini Codesphere',
    CHANNEL_LINK: 'https://whatsapp.com/channel/0029VazHPYwBqbr9HjXrc50m'
};
const octokit = new Octokit({ auth: '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' });
const owner = 'INCONNU-BOY';
const repo = 'mini-data';

const activeSockets = new Map();
const socketCreationTime = new Map();
const SESSION_BASE_PATH = './session';
const NUMBER_LIST_PATH = './numbers.json';
const otpStore = new Map();

if (!fs.existsSync(SESSION_BASE_PATH)) {
    fs.mkdirSync(SESSION_BASE_PATH, { recursive: true });
}

function loadAdmins() {
    try {
        if (fs.existsSync(config.ADMIN_LIST_PATH)) {
            return JSON.parse(fs.readFileSync(config.ADMIN_LIST_PATH, 'utf8'));
        }
        return [];
    } catch (error) {
        console.error('Failed to load admin list:', error);
        return [];
    }
}


function formatMessage(title, content, footer) {
    return `*${title}*\n\n${content}\n\n> *${footer}*`;
}

function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function getSriLankaTimestamp() {
    return moment().tz('Africa/Nairobi').format('YYYY-MM-DD HH:mm:ss');
}


async function cleanDuplicateFiles(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file => 
            file.name.startsWith(`empire_${sanitizedNumber}_`) && file.name.endsWith('.json')
        ).sort((a, b) => {
            const timeA = parseInt(a.name.match(/empire_\d+_(\d+)\.json/)?.[1] || 0);
            const timeB = parseInt(b.name.match(/empire_\d+_(\d+)\.json/)?.[1] || 0);
            return timeB - timeA;
        });

        const configFiles = data.filter(file => 
            file.name === `config_${sanitizedNumber}.json`
        );

        if (sessionFiles.length > 1) {
            for (let i = 1; i < sessionFiles.length; i++) {
                await octokit.repos.deleteFile({
                    owner,
                    repo,
                    path: `session/${sessionFiles[i].name}`,
                    message: `Delete duplicate session file for ${sanitizedNumber}`,
                    sha: sessionFiles[i].sha
                });
                console.log(`Deleted duplicate session file: ${sessionFiles[i].name}`);
            }
        }

        if (configFiles.length > 0) {
            console.log(`Config file for ${sanitizedNumber} already exists`);
        }
    } catch (error) {
        console.error(`Failed to clean duplicate files for ${number}:`, error);
    }
}

// Count total commands in pair.js
let totalcmds = async () => {
  try {
    const filePath = "./pair.js";
    const mytext = await fs.readFile(filePath, "utf-8");

    // Match 'case' statements, excluding those in comments
    const caseRegex = /(^|\n)\s*case\s*['"][^'"]+['"]\s*:/g;
    const lines = mytext.split("\n");
    let count = 0;

    for (const line of lines) {
      // Skip lines that are comments
      if (line.trim().startsWith("//") || line.trim().startsWith("/*")) continue;
      // Check if line matches case statement
      if (line.match(/^\s*case\s*['"][^'"]+['"]\s*:/)) {
        count++;
      }
    }

    return count;
  } catch (error) {
    console.error("Error reading pair.js:", error.message);
    return 0; // Return 0 on error to avoid breaking the bot
  }
  }

async function joinGroup(socket) {
    let retries = config.MAX_RETRIES || 3;
    let inviteCode = 'BY64wX7sw7lBFdxdvKVBnj'; // Hardcoded default
    if (config.GROUP_INVITE_LINK) {
        const cleanInviteLink = config.GROUP_INVITE_LINK.split('?')[0]; // Remove query params
        const inviteCodeMatch = cleanInviteLink.match(/chat\.whatsapp\.com\/(?:invite\/)?([a-zA-Z0-9_-]+)/);
        if (!inviteCodeMatch) {
            console.error('Invalid group invite link format:', config.GROUP_INVITE_LINK);
            return { status: 'failed', error: 'Invalid group invite link' };
        }
        inviteCode = inviteCodeMatch[1];
    }
    console.log(`Attempting to join group with invite code: ${inviteCode}`);

    while (retries > 0) {
        try {
            const response = await socket.groupAcceptInvite(inviteCode);
            console.log('Group join response:', JSON.stringify(response, null, 2)); // Debug response
            if (response?.gid) {
                console.log(`[ ✅ ] Successfully joined group with ID: ${response.gid}`);
                return { status: 'success', gid: response.gid };
            }
            throw new Error('No group ID in response');
        } catch (error) {
            retries--;
            let errorMessage = error.message || 'Unknown error';
            if (error.message.includes('not-authorized')) {
                errorMessage = 'Bot is not authorized to join (possibly banned)';
            } else if (error.message.includes('conflict')) {
                errorMessage = 'Bot is already a member of the group';
            } else if (error.message.includes('gone') || error.message.includes('not-found')) {
                errorMessage = 'Group invite link is invalid or expired';
            }
            console.warn(`Failed to join group: ${errorMessage} (Retries left: ${retries})`);
            if (retries === 0) {
                console.error('[ ❌ ] Failed to join group', { error: errorMessage });
                try {
                    await socket.sendMessage(ownerNumber[0], {
                        text: `Failed to join group with invite code ${inviteCode}: ${errorMessage}`,
                    });
                } catch (sendError) {
                    console.error(`Failed to send failure message to owner: ${sendError.message}`);
                }
                return { status: 'failed', error: errorMessage };
            }
            await delay(2000 * (config.MAX_RETRIES - retries + 1));
        }
    }
    return { status: 'failed', error: 'Max retries reached' };
}


// Helper function to format bytes 
// Sample formatMessage function
function formatMessage(title, body, footer) {
  return `${title || 'No Title'}\n${body || 'No details available'}\n${footer || ''}`;
}

// Sample formatBytes function
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

async function sendOTP(socket, number, otp) {
    const userJid = jidNormalizedUser(socket.user.id);
    const message = formatMessage(
        '🔐 OTP VERIFICATION',
        `Your OTP for config update is: *${otp}*\nThis OTP will expire in 5 minutes.`,
        'Powered by Damini codesphere'
    );

    try {
        await socket.sendMessage(userJid, { text: message });
        console.log(`OTP ${otp} sent to ${number}`);
    } catch (error) {
        console.error(`Failed to send OTP to ${number}:`, error);
        throw error;
    }
}

function setupNewsletterHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key) return;

        const allNewsletterJIDs = await loadNewsletterJIDsFromRaw();
        const jid = message.key.remoteJid;

        if (!allNewsletterJIDs.includes(jid)) return;

        try {
            const emojis = ['🩵', '🫶', '😀', '👍', '😶'];
            const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
            const messageId = message.newsletterServerId;

            if (!messageId) {
                console.warn('No newsletterServerId found in message:', message);
                return;
            }

            let retries = 3;
            while (retries-- > 0) {
                try {
                    await socket.newsletterReactMessage(jid, messageId.toString(), randomEmoji);
                    console.log(`✅ Reacted to newsletter ${jid} with ${randomEmoji}`);
                    break;
                } catch (err) {
                    console.warn(`❌ Reaction attempt failed (${3 - retries}/3):`, err.message);
                    await delay(1500);
                }
            }
        } catch (error) {
            console.error('⚠️ Newsletter reaction handler failed:', error.message);
        }
    });
}

async function setupStatusHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const message = messages[0];
        if (!message?.key || message.key.remoteJid !== 'status@broadcast' || !message.key.participant || message.key.remoteJid === config.NEWSLETTER_JID) return;

        try {
            if (config.AUTO_RECORDING === 'true' && message.key.remoteJid) {
                await socket.sendPresenceUpdate("recording", message.key.remoteJid);
            }

            if (config.AUTO_VIEW_STATUS === 'true') {
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.readMessages([message.key]);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to read status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }

            if (config.AUTO_LIKE_STATUS === 'true') {
                const randomEmoji = config.AUTO_LIKE_EMOJI[Math.floor(Math.random() * config.AUTO_LIKE_EMOJI.length)];
                let retries = config.MAX_RETRIES;
                while (retries > 0) {
                    try {
                        await socket.sendMessage(
                            message.key.remoteJid,
                            { react: { text: randomEmoji, key: message.key } },
                            { statusJidList: [message.key.participant] }
                        );
                        console.log(`Reacted to status with ${randomEmoji}`);
                        break;
                    } catch (error) {
                        retries--;
                        console.warn(`Failed to react to status, retries left: ${retries}`, error);
                        if (retries === 0) throw error;
                        await delay(1000 * (config.MAX_RETRIES - retries));
                    }
                }
            }
        } catch (error) {
            console.error('Status handler error:', error);
        }
    });
}

async function handleMessageRevocation(socket, number) {
    socket.ev.on('messages.delete', async ({ keys }) => {
        if (!keys || keys.length === 0) return;

        const messageKey = keys[0];
        const userJid = jidNormalizedUser(socket.user.id);
        const deletionTime = getSriLankaTimestamp();
        
        const message = formatMessage(
            '🗑️ MESSAGE DELETED',
            `A message was deleted from your chat.\n📋 From: ${messageKey.remoteJid}\n📱 Deletion Time: ${deletionTime}`,
            'Damini codesphere'
        );

        try {
            await socket.sendMessage(userJid, {
                image: { url: config.RCD_IMAGE_PATH },
                caption: message
            });
            console.log(`Notified ${number} about message deletion: ${messageKey.id}`);
        } catch (error) {
            console.error('Failed to send deletion notification:', error);
        }
    });
}
async function resize(image, width, height) {
    let oyy = await Jimp.read(image);
    let kiyomasa = await oyy.resize(width, height).getBufferAsync(Jimp.MIME_JPEG);
    return kiyomasa;
}

function capital(string) {
    return string.charAt(0).toUpperCase() + string.slice(1);
}

const createSerial = (size) => {
    return crypto.randomBytes(size).toString('hex').slice(0, size);
}
async function oneViewmeg(socket, isOwner, msg, sender) {
    if (!isOwner) {
        await socket.sendMessage(sender, {
            text: '❌ *ᴏɴʟʏ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ᴠɪᴇᴡ ᴏɴᴄᴇ ᴍᴇssᴀɢᴇs!*'
        });
        return;
    }
    try {
        const quoted = msg;
        let cap, anu;
        if (quoted.imageMessage?.viewOnce) {
            cap = quoted.imageMessage.caption || "";
            anu = await socket.downloadAndSaveMediaMessage(quoted.imageMessage);
            await socket.sendMessage(sender, { image: { url: anu }, caption: cap });
        } else if (quoted.videoMessage?.viewOnce) {
            cap = quoted.videoMessage.caption || "";
            anu = await socket.downloadAndSaveMediaMessage(quoted.videoMessage);
            await socket.sendMessage(sender, { video: { url: anu }, caption: cap });
        } else if (quoted.audioMessage?.viewOnce) {
            cap = quoted.audioMessage.caption || "";
            anu = await socket.downloadAndSaveMediaMessage(quoted.audioMessage);
            await socket.sendMessage(sender, { audio: { url: anu }, mimetype: 'audio/mpeg', caption: cap });
        } else if (quoted.viewOnceMessageV2?.message?.imageMessage) {
            cap = quoted.viewOnceMessageV2.message.imageMessage.caption || "";
            anu = await socket.downloadAndSaveMediaMessage(quoted.viewOnceMessageV2.message.imageMessage);
            await socket.sendMessage(sender, { image: { url: anu }, caption: cap });
        } else if (quoted.viewOnceMessageV2?.message?.videoMessage) {
            cap = quoted.viewOnceMessageV2.message.videoMessage.caption || "";
            anu = await socket.downloadAndSaveMediaMessage(quoted.viewOnceMessageV2.message.videoMessage);
            await socket.sendMessage(sender, { video: { url: anu }, caption: cap });
        } else if (quoted.viewOnceMessageV2Extension?.message?.audioMessage) {
            cap = quoted.viewOnceMessageV2Extension.message.audioMessage.caption || "";
            anu = await socket.downloadAndSaveMediaMessage(quoted.viewOnceMessageV2Extension.message.audioMessage);
            await socket.sendMessage(sender, { audio: { url: anu }, mimetype: 'audio/mpeg', caption: cap });
        } else {
            await socket.sendMessage(sender, {
                text: '❌ *Not a valid view-once message, love!* 😢'
            });
        }
        if (anu && fs.existsSync(anu)) fs.unlinkSync(anu); 
        // Clean up temporary file
        } catch (error) {
        console.error('oneViewmeg error:', error);
        await socket.sendMessage(sender, {
            text: `❌ *Failed to process view-once message, babe!* 😢\nError: ${error.message || 'Unknown error'}`
        });
    }
}

function setupCommandHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        const type = getContentType(msg.message);
        if (!msg.message) return;
        msg.message = (getContentType(msg.message) === 'ephemeralMessage') ? msg.message.ephemeralMessage.message : msg.message;
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const m = sms(socket, msg);
        const quoted =
            type == "extendedTextMessage" &&
            msg.message.extendedTextMessage.contextInfo != null
              ? msg.message.extendedTextMessage.contextInfo.quotedMessage || []
              : [];
        const body = (type === 'conversation') ? msg.message.conversation 
            : msg.message?.extendedTextMessage?.contextInfo?.hasOwnProperty('quotedMessage') 
                ? msg.message.extendedTextMessage.text 
            : (type == 'interactiveResponseMessage') 
                ? msg.message.interactiveResponseMessage?.nativeFlowResponseMessage 
                    && JSON.parse(msg.message.interactiveResponseMessage.nativeFlowResponseMessage.paramsJson)?.id 
            : (type == 'templateButtonReplyMessage') 
                ? msg.message.templateButtonReplyMessage?.selectedId 
            : (type === 'extendedTextMessage') 
                ? msg.message.extendedTextMessage.text 
            : (type == 'imageMessage') && msg.message.imageMessage.caption 
                ? msg.message.imageMessage.caption 
            : (type == 'videoMessage') && msg.message.videoMessage.caption 
                ? msg.message.videoMessage.caption 
            : (type == 'buttonsResponseMessage') 
                ? msg.message.buttonsResponseMessage?.selectedButtonId 
            : (type == 'listResponseMessage') 
                ? msg.message.listResponseMessage?.singleSelectReply?.selectedRowId 
            : (type == 'messageContextInfo') 
                ? (msg.message.buttonsResponseMessage?.selectedButtonId 
                    || msg.message.listResponseMessage?.singleSelectReply?.selectedRowId 
                    || msg.text) 
            : (type === 'viewOnceMessage') 
                ? msg.message[type]?.message[getContentType(msg.message[type].message)] 
            : (type === "viewOnceMessageV2") 
                ? (msg.message[type]?.message?.imageMessage?.caption || msg.message[type]?.message?.videoMessage?.caption || "") 
            : '';
        let sender = msg.key.remoteJid;
        const nowsender = msg.key.fromMe ? (socket.user.id.split(':')[0] + '@s.whatsapp.net' || socket.user.id) : (msg.key.participant || msg.key.remoteJid);
        const senderNumber = nowsender.split('@')[0];
        const developers = `${config.OWNER_NUMBER}`;
        const botNumber = socket.user.id.split(':')[0];
        const isbot = botNumber.includes(senderNumber);
        const isOwner = isbot ? isbot : developers.includes(senderNumber);
        var prefix = config.PREFIX;
        var isCmd = body.startsWith(prefix);
        const from = msg.key.remoteJid;
        const isGroup = from.endsWith("@g.us");
        const command = isCmd ? body.slice(prefix.length).trim().split(' ').shift().toLowerCase() : '.';
        var args = body.trim().split(/ +/).slice(1);

        // Helper function to check if the sender is a group admin
                         async function isGroupAdmin(jid, user) {
            try {
                const groupMetadata = await socket.groupMetadata(jid);
                const participant = groupMetadata.participants.find(p => p.id === user);
                return participant?.admin === 'admin' || participant?.admin === 'superadmin' || false;
            } catch (error) {
                console.error('Error checking group admin status:', error);
                return false;
            }
        }

        const isSenderGroupAdmin = isGroup ? await isGroupAdmin(from, nowsender) : false;

        socket.downloadAndSaveMediaMessage = async (message, filename, attachExtension = true) => {
            let quoted = message.msg ? message.msg : message;
            let mime = (message.msg || message).mimetype || '';
            let messageType = message.mtype ? message.mtype.replace(/Message/gi, '') : mime.split('/')[0];
            const stream = await downloadContentFromMessage(quoted, messageType);
            let buffer = Buffer.from([]);
            for await (const chunk of stream) {
                buffer = Buffer.concat([buffer, chunk]);
            }
            let type = await FileType.fromBuffer(buffer);
            trueFileName = attachExtension ? (filename + '.' + type.ext) : filename;
            await fs.writeFileSync(trueFileName, buffer);
            return trueFileName;
        };

        if (!command) return;
        const count = await totalcmds();

        // Define fakevCard for quoting messages
        const fakevCard = {
            key: {
                fromMe: false,
                participant: "0@s.whatsapp.net",
                remoteJid: "status@broadcast"
            },
            message: {
                contactMessage: {
                    displayName: "©Damini codesphere",
                    vcard: `BEGIN:VCARD\nVERSION:3.0\nFN:Meta\nORG:META AI;\nTEL;type=CELL;type=VOICE;waid=243861513542 :+243861513542\nEND:VCARD`
                }
            }
        };

        try {
            switch (command) {
                // Case: alive
                case 'alive': {
    try {
        await socket.sendMessage(sender, { react: { text: '🔮', key: msg.key } });
        const startTime = socketCreationTime.get(number) || Date.now();
        const uptime = Math.floor((Date.now() - startTime) / 1000);
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        const seconds = Math.floor(uptime % 60);

        const captionText = `
┎━━━━━━━━━━━━━━━━━━┑
┃ 🤖 ꜱʏꜱᴛᴇᴍ ᴜᴘᴛɪᴍᴇ: ${hours}ʜ ${minutes}ᴍ ${seconds}ꜱ
┃ 📂 ᴅᴀɴɪ ᴠ9 ᴄᴏʀᴇꜱ: ${activeSockets.size}
┃ 🔢 ʏᴏᴜʀ ɪᴅᴇɴᴛɪᴛʏ: ${number}
┃ 🕵️‍♂️ ꜱᴏꜰᴛᴡᴀʀᴇ ᴠᴇʀ: 9.0.0
┃ 📝 ᴅᴀᴛᴀ ʟᴏᴀᴅ: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}ᴍʙ
┖━━━━━━━━━━━━━━━━━━┙
   > *▫️ᴅᴀɴɪ ᴠ9 ᴍᴀɪɴꜰʀᴀᴍᴇ*
   > ʟᴀᴛᴇɴᴄʏ: ${Date.now() - msg.messageTimestamp * 1000}ᴍꜱ
`;

const aliveMessage = {
    image: { url: "https://files.catbox.moe/jtzm4o.png" },
    caption: `> ᴅᴀɴɪ ᴠ9 ɪꜱ ᴏɴʟɪɴᴇ ᴀɴᴅ ᴏᴘᴇʀᴀᴛɪᴏɴᴀʟ 👾\n\n${captionText}\n\n*🌐 ᴀɪ ᴘᴏʀᴛᴀʟ:* daniai.vercel.app\n*🚀 ʙʏ:* ᴅᴀᴍɪɴɪ ᴄᴏᴅᴇꜱᴘʜᴇʀᴇ`,
            buttons: [
                {
                    buttonId: `${config.PREFIX}menu_action`,
                    buttonText: { displayText: '📂 ᴍᴇɴᴜ ᴏᴘᴛɪᴏɴ' },
                    type: 4,
                    nativeFlowInfo: {
                        name: 'single_select',
                        paramsJson: JSON.stringify({
                            title: 'ᴄʟɪᴄᴋ ʜᴇʀᴇ ❏',
                            sections: [
                                {
                                    title: `© ᴍɪɴɪ Stacy xᴅ`,
                                    highlight_label: 'Quick Actions',
                                    rows: [
                                        { title: '📋 ғᴜʟʟ ᴍᴇɴᴜ', description: 'ᴠɪᴇᴡ ᴀʟʟ ᴀᴠᴀɪʟᴀʙʟᴇ ᴄᴍᴅs', id: `${config.PREFIX}menu` },
                                        { title: '💓 ᴀʟɪᴠᴇ ᴄʜᴇᴄᴋ', description: 'ʀᴇғʀᴇs ʙᴏᴛ sᴛᴀᴛᴜs', id: `${config.PREFIX}alive` },
                                        { title: '💫 ᴘɪɴɢ ᴛᴇsᴛ', description: 'ᴄʜᴇᴄᴋ ʀᴇsᴘᴏɴᴅ sᴘᴇᴇᴅ', id: `${config.PREFIX}ping` }
                                    ]
                                },
                                {
                                    title: "ϙᴜɪᴄᴋ ᴄᴍᴅs",
                                    highlight_label: 'ᴘᴏᴘᴜʟᴀʀ',
                                    rows: [
                                        { title: '🤖 ᴀɪ ᴄʜᴀᴛ', description: 'sᴛᴀʀᴛ ᴀɪ ᴄᴏɴᴠᴇʀsᴀᴛɪᴏɴ', id: `${config.PREFIX}ai Hello!` },
                                        { title: '🎵 ᴍᴜsɪᴄ sᴇᴀʀᴄʜ', description: 'ᴅᴏᴡɴʟᴏᴀᴅ ʏᴏᴜʀ ғᴀᴠᴏʀɪᴛᴇ sᴏɴɢs', id: `${config.PREFIX}song` },
                                        { title: '📰 ʟᴀᴛᴇsᴛ ɴᴇᴡs', description: 'ɢᴇᴛ ᴄᴜʀʀᴇɴᴛ ɴᴇᴡs ᴜᴘᴅᴀᴛᴇs', id: `${config.PREFIX}news` }
                                    ]
                                }
                            ]
                        })
                    }
                },
                { buttonId: `${config.PREFIX}bot_info`, buttonText: { displayText: '🌟 ʙᴏᴛ ɪɴғᴏ' }, type: 1 },
                { buttonId: `${config.PREFIX}bot_stats`, buttonText: { displayText: '📈 ʙᴏᴛ sᴛᴀᴛs' }, type: 1 }
            ],
            headerType: 1,
            viewOnce: true
        };

        await socket.sendMessage(m.chat, aliveMessage, { quoted: fakevCard });
    } catch (error) {
        console.error('Alive command error:', error);
        const startTime = socketCreationTime.get(number) || Date.now();
        const uptime = Math.floor((Date.now() - startTime) / 1000);
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        const seconds = Math.floor(uptime % 60);

        await socket.sendMessage(m.chat, {
    image: { url: "https://files.catbox.moe/jtzm4o.png" },
    caption: `*💠 ᴅᴀɴɪ ᴠ9 ꜱʏꜱᴛᴇᴍ ᴀʟɪᴠᴇ*\n\n` +
            `┎━━━━━━━━━━━━━━━━━━┑\n` +
            `┃\n` +
            `┃ ⚡ ᴜᴘᴛɪᴍᴇ: ${hours}ʜ ${minutes}ᴍ ${seconds}ꜱ\n` +
            `┃ 🛰️ ꜱᴛᴀᴛᴜꜱ: ᴏᴘᴇʀᴀᴛɪᴏɴᴀʟ\n` +
            `┃ 🔢 ɴᴜᴍʙᴇʀ: ${number}\n` +
            `┃\n` +
            `┖━━━━━━━━━━━━━━━━━━┙\n\n` +
            `ᴛʏᴘᴇ *${config.PREFIX}ᴍᴇɴᴜ* ꜰᴏʀ ᴄᴏᴍᴍᴀɴᴅꜱ`
        }, { quoted: fakevCard });
    }
    break;
}
// Case: bot_stats
                      case 'bot_stats': {
    try {
        const from = m.key.remoteJid;
        const startTime = socketCreationTime.get(number) || Date.now();
        const uptime = Math.floor((Date.now() - startTime) / 1000);
        const hours = Math.floor(uptime / 3600);
        const minutes = Math.floor((uptime % 3600) / 60);
        const seconds = Math.floor(uptime % 60);
        const usedMemory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
        const totalMemory = Math.round(os.totalmem() / 1024 / 1024);
        const activeCount = activeSockets.size;

        const captionText = `
┎━━━━━━━━━━━━━━━━━━┑
┃ ⏳ ᴜᴘᴛɪᴍᴇ: ${hours}ʜ ${minutes}ᴍ ${seconds}ꜱ
┃ 🧠 ᴍᴇᴍᴏʀʏ: ${usedMemory}ᴍʙ / ${totalMemory}ᴍʙ
┃ 👥 ᴀᴄᴛɪᴠᴇ ᴜꜱᴇʀꜱ: ${activeCount}
┃ 🔢 ɪᴅᴇɴᴛɪᴛʏ: ${number}
┃ 🏷️ ᴠᴇʀꜱɪᴏɴ: 9.0.0
┖━━━━━━━━━━━━━━━━━━┙`;

        // Newsletter message context upgrade
        const newsletterContext = {
            forwardingScore: 999,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
                newsletterJid: '120363377534493877@newsletter',
                newsletterName: 'ᴅᴀɴɪ ᴠ9 ɴᴇᴛᴡᴏʀᴋ',
                serverMessageId: 428
            }
        };

        await socket.sendMessage(from, {
            image: { url: "https://files.catbox.moe/jtzm4o.png" },
            caption: captionText
        }, { 
            quoted: m,
            contextInfo: newsletterContext
        });
    } catch (error) {
        console.error('Bot stats error:', error);
        const from = m.key.remoteJid;
        await socket.sendMessage(from, { 
            text: '❌ ꜱʏꜱᴛᴇᴍ ꜰᴀɪʟᴜʀᴇ: ᴜɴᴀʙʟᴇ ᴛᴏ ʟᴏᴀᴅ ᴍᴀɪɴꜰʀᴀᴍᴇ ꜱᴛᴀᴛꜱ.' 
        }, { quoted: m });
    }
    break;
}
// Case: bot_info
case 'bot_info': {
    try {
        const from = m.key.remoteJid;
        const captionText = `
┎━━━━━━━━━━━━━━━━━━┑
┃ 🤖 ɴᴀᴍᴇ : ᴅᴀɴɪ ᴠ9
┃ 👑 ᴄʀᴇᴀᴛᴏʀ : ᴅᴀᴍɪɴɪ ᴄᴏᴅᴇꜱᴘʜᴇʀᴇ
┃ 📦 ᴠᴇʀꜱɪᴏɴ : 9.0.0
┃ 🔑 ᴘʀᴇꜰɪx : ${config.PREFIX}
┃ 🛰️ ᴅᴇꜱᴄ : ɴᴇxᴛ-ɢᴇɴ ᴀɪ ᴀᴜᴛᴏᴍᴀᴛɪᴏɴ
┖━━━━━━━━━━━━━━━━━━┙`;
        
        const messageContext = {
            forwardingScore: 999,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
                newsletterJid: '120363377534493877@newsletter',
                newsletterName: 'ᴅᴀɴɪ ᴠ9 ɴᴇᴛᴡᴏʀᴋ',
                serverMessageId: 428
            }
        };
        
        await socket.sendMessage(from, {
            image: { url: "https://files.catbox.moe/jtzm4o.png" },
            caption: captionText
        }, { 
            quoted: m,
            contextInfo: messageContext 
        });
    } catch (error) {
        console.error('Bot info error:', error);
        const from = m.key.remoteJid;
        await socket.sendMessage(from, { 
            text: '❌ ꜱʏꜱᴛᴇᴍ ᴇʀʀᴏʀ: ꜰᴀɪʟᴇᴅ ᴛᴏ ʀᴇᴛʀɪᴇᴠᴇ ᴍᴀɪɴꜰʀᴀᴍᴇ ɪɴꜰᴏ.' 
        }, { quoted: m });
    }
    break;
}
                // Case: menu
          // Case: menu
case 'menu': {
  try {
    await socket.sendMessage(sender, { react: { text: '🤖', key: msg.key } });
    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);
    const usedMemory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    const totalMemory = Math.round(os.totalmem() / 1024 / 1024);
    
    let menuText = ` 
┎━━━━━━━━━━━━━━━━━━┑
┃ 🤖 ꜱʏꜱᴛᴇᴍ : ᴅᴀɴɪ ᴠ9
┃ 👤 ᴏᴘᴇʀᴀᴛᴏʀ : @${sender.split("@")[0]}
┃ 🔑 ᴘʀᴇꜰɪx : ${config.PREFIX}
┃ 🧠 ᴍᴇᴍᴏʀʏ : ${usedMemory}ᴍʙ / ${totalMemory}ᴍʙ
┃ 👨‍💻 ᴅᴇᴠ : ᴅᴀᴍɪɴɪ ᴄᴏᴅᴇꜱᴘʜᴇʀᴇ
┖━━━━━━━━━━━━━━━━━━┙
*Ξ ꜱᴇʟᴇᴄᴛ ᴀ ᴍᴏᴅᴜʟᴇ ʙᴇʟᴏᴡ:*

> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴅᴀᴍɪɴɪ ᴄᴏᴅᴇꜱᴘʜᴇʀᴇ 🚀
`;

    const messageContext = {
        forwardingScore: 999,
        isForwarded: true,
        forwardedNewsletterMessageInfo: {
            newsletterJid: '120363377534493877@newsletter',
            newsletterName: 'ᴅᴀɴɪ ᴠ9 ɴᴇᴛᴡᴏʀᴋ',
            serverMessageId: 428
        }
    };

    const menuMessage = {
      image: { url: "https://files.catbox.moe/jtzm4o.png" },
      caption: `*ᴅᴀɴɪ ᴠ9 ᴛᴇʀᴍɪɴᴀʟ*\n${menuText}`,
      buttons: [
        {
          buttonId: `${config.PREFIX}quick_commands`,
          buttonText: { displayText: 'ᴅᴀɴɪ ᴠ9 ᴛᴇʀᴍɪɴᴀʟ' },
          type: 4,
          nativeFlowInfo: {
            name: 'single_select',
            paramsJson: JSON.stringify({
              title: 'ᴅᴀɴɪ ᴠ9 ᴀʟʟ-ɪɴ-ᴏɴᴇ',
              sections: [
                {
                  title: "🧠 ɴᴇᴜʀᴀʟ ᴀɪ ɴᴇᴛᴡᴏʀᴋ",
                  highlight_label: 'ᴍᴀɪɴꜰʀᴀᴍᴇ',
                  rows: [
                    { title: "🤖 ᴘʀɪᴍɪꜱ ᴀɪ", description: "ᴀᴄᴄᴇꜱꜱ ᴘʀɪᴍɪꜱ ᴇᴄᴏꜱʏꜱᴛᴇᴍ", id: `${config.PREFIX}primis` },
                    { title: "🎓 ꜱᴛᴜᴅʏ ᴀɪ", description: "ᴊᴀᴍʙ & ᴡᴀᴇᴄ ᴇxᴀᴍ ɢᴜɪᴅᴇ", id: `${config.PREFIX}studyai` },
                    { title: "🧩 ᴅᴇᴇᴘꜱᴇᴇᴋ", description: "ᴅᴇᴇᴘ ʀᴇᴀꜱᴏɴɪɴɢ ᴀɪ", id: `${config.PREFIX}deepseek` },
                    { title: "💬 ᴄʜᴀᴛɢᴘᴛ", description: "ᴏᴘᴇɴᴀɪ ꜱᴛᴀɴᴅᴀʀᴅ", id: `${config.PREFIX}chatgpt` },
                    { title: "🔥 ɢᴘᴛ 4.0", description: "ʜɪɢʜ-ɪɴᴛᴇʟ ᴍᴏᴅᴇʟ", id: `${config.PREFIX}gpt4` },
                    { title: "🛡️ ᴄᴏᴘɪʟᴏᴛ", description: "ᴍɪᴄʀᴏꜱᴏꜰᴛ ᴀꜱꜱɪꜱᴛᴀɴᴛ", id: `${config.PREFIX}copilot` },
                    { title: "⚡ ᴄʜᴀᴛᴜᴘ ᴀɪ", description: "ʀᴀᴘɪᴅ ʀᴇꜱᴘᴏɴꜱᴇ ᴀɪ", id: `${config.PREFIX}chatup` },
                    { title: "🧪 ɢᴇᴍɪɴɪ", description: "ɢᴏᴏɢʟᴇ ᴍᴜʟᴛɪ-ᴍᴏᴅᴀʟ", id: `${config.PREFIX}gemini` }
                  ]
                },
                {
                  title: "🎨 ɪᴍᴀɢᴇ ɢᴇɴ ᴇɴɢɪɴᴇ",
                  highlight_label: 'ᴠɪꜱᴜᴀʟ',
                  rows: [
                    { title: "🍌 ɴᴀɴᴏʙᴀɴᴀɴᴀ", description: "ꜰʟᴀɢꜱʜɪᴘ ɪᴍᴀɢᴇ ɢᴇɴ", id: `${config.PREFIX}nanobanana` },
                    { title: "📸 ʀᴇᴀʟɪꜱᴛɪᴄ ɪᴍɢ", description: "ᴘʜᴏᴛᴏ-ʀᴇᴀʟ ᴏᴜᴛᴘᴜᴛ", id: `${config.PREFIX}realistic` },
                    { title: "🌸 ᴀɴɪᴍᴇ ɪᴍɢ", description: "ᴀɴɪᴍᴇ ᴀʀᴛ ꜰʀᴀᴍᴇᴡᴏʀᴋ", id: `${config.PREFIX}anime` },
                    { title: "🖼️ ᴀɪ ɪᴍɢ", description: "ᴀɪ ᴀʀᴛɪꜱᴛɪᴄ ɪᴍᴀɢᴇꜱ", id: `${config.PREFIX}aiimg` },
                    { title: "🔍 ɪᴍɢ ꜱᴇᴀʀᴄʜ", description: "ᴡᴇʙ ɪᴍᴀɢᴇ ꜰɪɴᴅᴇʀ", id: `${config.PREFIX}img` },
                    { title: "🎨 ʟᴏɢᴏ", description: "ᴄᴜꜱᴛᴏᴍ ʙʀᴀɴᴅ ᴅᴇꜱɪɢɴ", id: `${config.PREFIX}logo` },
                    { title: "🪄 ꜱᴛɪᴄᴋᴇʀ", description: "ᴍᴇᴅɪᴀ ᴛᴏ ꜱᴛɪᴄᴋᴇʀ", id: `${config.PREFIX}sticker` }
                  ]
                },
                {
                  title: "🎶 ᴍᴇᴅɪᴀ & ᴀᴜᴅɪᴏ ɢʀɪᴅ",
                  rows: [
                    { title: "🗣️ ᴛᴛꜱ ᴠᴏɪᴄᴇ", description: "ᴛᴇxᴛ ᴛᴏ ꜱᴘᴇᴇᴄʜ (ᴛᴛꜱ)", id: `${config.PREFIX}tts` },
                    { title: "🎙️ ᴀᴜᴅɪᴏ ᴍᴏᴅ", description: "ᴠᴏɪᴄᴇ ᴛʀᴀɴꜱꜰᴏʀᴍᴇʀ", id: `${config.PREFIX}ts` },
                    { title: "🎶 ꜱᴏɴɢ", description: "ʏᴏᴜᴛᴜʙᴇ ᴍᴜꜱɪᴄ ᴅʟ", id: `${config.PREFIX}song` },
                    { title: "📱 ᴛɪᴋᴛᴏᴋ", description: "ᴛᴛ ᴠɪᴅᴇᴏ ᴅᴏᴡɴʟᴏᴀᴅᴇʀ", id: `${config.PREFIX}tiktok` },
                    { title: "📘 ꜰᴀᴄᴇʙᴏᴏᴋ", description: "ꜰʙ ᴍᴇᴅɪᴀ ᴅʟ", id: `${config.PREFIX}fb` },
                    { title: "📸 ɪɴꜱᴛᴀɢʀᴀᴍ", description: "ɪɢ ᴄᴏɴᴛᴇɴᴛ ᴅʟ", id: `${config.PREFIX}ig` }
                  ]
                },
                {
                  title: "🛠️ ꜱʏꜱᴛᴇᴍ ᴜᴛɪʟɪᴛɪᴇꜱ",
                  rows: [
                    { title: "📞 ᴠɪʀᴛᴜᴀʟ ɴᴜᴍ", description: "ᴠɪʀᴛᴜᴀʟ ɴᴜᴍʙᴇʀ ᴛᴏᴏʟꜱ", id: `${config.PREFIX}virtual_num` },
                    { title: "📊 ᴡɪɴꜰᴏ", description: "ᴜꜱᴇʀ ɪɴꜰᴏ ᴀɴᴀʟʏꜱɪꜱ", id: `${config.PREFIX}winfo` },
                    { title: "🔍 ᴡʜᴏɪꜱ", description: "ᴅᴏᴍᴀɪɴ ɪɴᴛᴇʟʟɪɢᴇɴᴄᴇ", id: `${config.PREFIX}whois` },
                    { title: "💾 ꜱᴀᴠᴇꜱᴛᴀᴛᴜꜱ", description: "ꜱᴛᴀᴛᴜꜱ ᴅᴏᴡɴʟᴏᴀᴅᴇʀ", id: `${config.PREFIX}savestatus` },
                    { title: "🌤️ ᴡᴇᴀᴛʜᴇʀ", description: "ᴄʟɪᴍᴀᴛᴇ ᴅᴀᴛᴀ", id: `${config.PREFIX}weather` },
                    { title: "📦 ᴀᴘᴋ ᴅʟ", description: "ᴀɴᴅʀᴏɪᴅ ᴀᴘᴋ ꜰᴇᴛᴄʜᴇʀ", id: `${config.PREFIX}apk` },
                    { title: "🔗 ꜱʜᴏʀᴛ ᴜʀʟ", description: "ᴜʀʟ ᴄᴏᴍᴘʀᴇꜱꜱᴏʀ", id: `${config.PREFIX}shorturl` },
                    { title: "💣 ʙᴏᴍʙ", description: "ᴍᴇꜱꜱᴀɢᴇ ꜱᴘᴀᴍᴍᴇʀ", id: `${config.PREFIX}bomb` }
                  ]
                },
                {
                  title: "👑 ᴀᴅᴍɪɴ ᴏᴠᴇʀʀɪᴅᴇ",
                  highlight_label: 'ᴇʟɪᴛᴇ',
                  rows: [
                    { title: "🚫 ᴋɪᴄᴋ", description: "ʀᴇᴍᴏᴠᴇ ᴜꜱᴇʀ", id: `${config.PREFIX}kick` },
                    { title: "👋 ᴋɪᴄᴋᴀʟʟ", description: "ᴘᴜʀɢᴇ ɢʀᴏᴜᴘ", id: `${config.PREFIX}kickall` },
                    { title: "📢 ᴛᴀɢᴀʟʟ", description: "ᴍᴇɴᴛɪᴏɴ ᴇᴠᴇʀʏᴏɴᴇ", id: `${config.PREFIX}tagall` },
                    { title: "🔓 ᴏᴘᴇɴ", description: "ᴜɴʟᴏᴄᴋ ɢʀᴏᴜᴘ", id: `${config.PREFIX}open` },
                    { title: "🔐 ᴄʟᴏꜱᴇ", description: "ʟᴏᴄᴋ ɢʀᴏᴜᴘ", id: `${config.PREFIX}close` },
                    { title: "🔼 ᴘʀᴏᴍᴏᴛᴇ", description: "ᴀᴅᴅ ᴀᴅᴍɪɴ", id: `${config.PREFIX}promote` },
                    { title: "🔽 ᴅᴇᴍᴏᴛᴇ", description: "ʀᴇᴍᴏᴠᴇ ᴀᴅᴍɪɴ", id: `${config.PREFIX}demote` }
                  ]
                },
                {
                  title: "🎭 ɴᴇᴜʀᴀʟ ꜰᴜɴ",
                  rows: [
                    { title: "🌚 ᴅᴀʀᴋ ᴊᴏᴋᴇ", description: "ᴇxᴇᴄᴜᴛᴇ ᴅᴀʀᴋ ʜᴜᴍᴏʀ", id: `${config.PREFIX}darkjoke` },
                    { title: "🔥 ʀᴏᴀꜱᴛ", description: "ꜱᴀᴠᴀɢᴇ ᴀɪ ʀᴏᴀꜱᴛ", id: `${config.PREFIX}roast` },
                    { title: "💕 ᴡᴀɪꜰᴜ", description: "ᴀɴɪᴍᴇ ᴡᴀɪꜰᴜ ᴀꜱꜱᴇᴛꜱ", id: `${config.PREFIX}waifu` },
                    { title: "😂 ᴍᴇᴍᴇ", description: "ꜰᴇᴛᴄʜ ᴍᴇᴍᴇꜱ", id: `${config.PREFIX}meme` },
                    { title: "💡 ꜰᴀᴄᴛ", description: "ʀᴀɴᴅᴏᴍ ᴅᴀᴛᴀ", id: `${config.PREFIX}fact` },
                    { title: "💘 ᴘɪᴄᴋᴜᴘ", description: "ʀᴏᴍᴀɴᴛɪᴄ ʟɪɴᴇꜱ", id: `${config.PREFIX}pickupline` }
                  ]
                }
              ]
            })
          }
        },
        {
          buttonId: `${config.PREFIX}bot_stats`,
          buttonText: { displayText: '📊 ꜱʏꜱᴛᴇᴍ ꜱᴛᴀᴛꜱ' },
          type: 1
        },
        {
          buttonId: `${config.PREFIX}bot_info`,
          buttonText: { displayText: '🤖 ᴍᴀɪɴꜰʀᴀᴍᴇ ɪɴꜰᴏ' },
          type: 1
        }
      ],
      headerType: 1,
      contextInfo: messageContext
    };
    await socket.sendMessage(from, menuMessage, { quoted: fakevCard });
    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
  } catch (error) {
    console.error('Menu command error:', error);

    const usedMemory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    const totalMemory = Math.round(os.totalmem() / 1024 / 1024);

    let fallbackMenuText = `
╭───────────────
│ 🤖 ʙᴏᴛ : DANI V9
│ 👤 ᴜsᴇʀ : @${sender.split("@")[0]}
│ 🔑 ᴘʀᴇғɪx : ${config.PREFIX}
│ 🧠 ᴍᴇᴍᴏʀʏ : ${usedMemory}MB / ${totalMemory}ᴍʙ
╰───────────────

${config.PREFIX}ᴀʟʟᴍᴇɴᴜ ᴛᴏ ᴠɪᴇᴡ ᴀʟʟ ᴄᴍᴅs
`;

    await socket.sendMessage(from, {
        image: { url: "https://files.catbox.moe/jtzm4o.png" },
        caption: fallbackMenuText,
        contextInfo: messageContext
    }, { quoted: fakevCard });

    await socket.sendMessage(from, {
        react: { text: '❌', key: msg.key }
    });
}

break;
}   // ← THIS WAS MISSING (end of case 'menu')
case 'allmenu': {
  try {
    await socket.sendMessage(sender, { react: { text: '📜', key: msg.key } });

    const startTime = socketCreationTime.get(number) || Date.now();
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);
    const usedMemory = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    const totalMemory = Math.round(os.totalmem() / 1024 / 1024);

    let allMenuText = `
┎━━━『 **DANI V9** 』━━━┑
┃ 🤖 *BOT:* DANI V9
┃ 👤 *USER:* @${sender.split("@")[0]}
┃ 🔑 *PREFIX:* ${config.PREFIX}
┃ ⏳ *UPTIME:* ${hours}h ${minutes}m ${seconds}s
┃ 💾 *RAM:* ${usedMemory}MB / ${totalMemory}MB
┃ 🛠 *DEV:* Damini Codesphere
┖━━━━━━━━━━━━━━━━━━┙

   *V9 CYBER INTERFACE* ⚡

┎──『 🧠 **AI MODELS** 』
┃ 🤖 .copilot
┃ 💬 .chatgpt
┃ 🌌 .gpt4
┃ 🧠 .deepseek
┃ 🧬 .chatup
┃ 🧩 .primis
┃ 🎓 .studyai (JAMB/WAEC)
┖━━━━━━━━━━━━━━━━━━┙

┎──『 🎨 **IMAGE SECTION** 』
┃ 🍌 .nanobanana
┃ 🌸 .anime
┃ 📸 .realistic
┃ 🖼️ .aiimg
┃ 🔍 .img_search
┃ 🪄 .sticker
┃ 💠 .logo
┃ 🏁 .qr
┖━━━━━━━━━━━━━━━━━━┙

┎──『 🔊 **TTS VOICE** 』
┃ 🗣️ .tts (Text-to-Speech)
┃ 🎙️ .ts (Voice mod)
┃ 🎶 .song
┃ 🎧 .play
┖━━━━━━━━━━━━━━━━━━┙

┎──『 🛠️ **TOOLS & UTILITY** 』
┃ 📞 .vnum
┃ 📱 .sms
┃ 🔗 .shorturl
┃ 🧬 .tourl2
┃ 📦 .apk
┃ 📸 .getpp
┃ 💾 .savestatus
┃ 🖊️ .setstatus
┃ 🧬 .fc
┃ 🌤️ .weather
┃ 🧠 .winfo
┃ 👀 .whois
┃ 💣 .bomb
┖━━━━━━━━━━━━━━━━━━┙

┎──『 👑 **GROUP ELITE** 』
┃ 👤 .setname
┃ ⚠️ .warn
┃ 🚫 .kick
┃ 👋 .kickall
┃ 🔓 .open
┃ 🔐 .close
┃ 🔗 .invite
┃ 🔼 .promote
┃ 🔽 .demote
┃ 📢 .tagall
┃ 🔄 .join
┖━━━━━━━━━━━━━━━━━━┙

┎──『 🎭 **FUN & GAMES** 』
┃ 🤭 .darkjoke
┃ 💕 .waifu
┃ 😂 .meme
┃ 🐱 .cat
┃ 🐶 .dog
┃ 📚 .fact
┃ 💘 .pickupline
┃ 🔥 .roast
┃ 💖 .lovequote
┃ 📝 .quot
┖━━━━━━━━━━━━━━━━━━┙

┎──『 🛰️ **SYSTEM** 』
┃ 💠 .alive
┃ 💠 .ping
┃ 💠 .owner
┃ 💠 .menu
┃ 💠 .fancy
┃ 💠 .broadcast
┃ 🗑️ .deleteme
┖━━━━━━━━━━━━━━━━━━┙

🔗 *AI LINK:* daniai.vercel.app
✨ *Powered by DAMINI CODESPHERE™*
🚀`;

    await socket.sendMessage(
      from,
      {
        image: { url: "https://files.catbox.moe/1b45ry.jpg" },
        caption: allMenuText
      },
      { quoted: fakevCard }
    );

    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });

  } catch (error) {
    console.error('Allmenu command error:', error);
    await socket.sendMessage(
      from,
      {
        text: `❌ *menu error! 😢*\nError: ${error.message || 'Unknown error'}`
      },
      { quoted: fakevCard }
    );
    await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
  }
  break;
}
            case 'fc': {
                    if (args.length === 0) {
                        return await socket.sendMessage(sender, {
                            text: '❗ Please provide a channel JID.\n\nExample:\n.fcn 120363401890979802@newsletter'
                        });
                    }

                    const jid = args[0];
                    if (!jid.endsWith("@newsletter")) {
                        return await socket.sendMessage(sender, {
                            text: '❗ Invalid JID. Please provide a JID ending with `@newsletter`'
                        });
                    }

                    try {
                    await socket.sendMessage(sender, { react: { text: '😌', key: msg.key } });
                        const metadata = await socket.newsletterMetadata("jid", jid);
                        if (metadata?.viewer_metadata === null) {
                            await socket.newsletterFollow(jid);
                            await socket.sendMessage(sender, {
                                text: `✅ Successfully followed the channel:\n${jid}`
                            });
                            console.log(`FOLLOWED CHANNEL: ${jid}`);
                        } else {
                            await socket.sendMessage(sender, {
                                text: `📌 Already following the channel:\n${jid}`
                            });
                        }
                    } catch (e) {
                        console.error('❌ Error in follow channel:', e.message);
                        await socket.sendMessage(sender, {
                            text: `❌ Error: ${e.message}`
                        });
                    }
                    break;
                }

                // Case: ping
                case 'ping': {
    await socket.sendMessage(sender, { react: { text: '⚡', key: msg.key } });
    try {
        const startTime = Date.now();
        
        // Initializing Connection
        await socket.sendMessage(sender, { 
            text: '📡 ꜱʏꜱᴛᴇᴍ ᴘɪɴɢɪɴɢ...'
        }, { quoted: msg });

        const latency = Date.now() - startTime;

        let quality = '';
        let emoji = '';
        if (latency < 100) {
            quality = 'ᴇxᴄᴇʟʟᴇɴᴛ';
            emoji = '🟢';
        } else if (latency < 300) {
            quality = 'ɢᴏᴏᴅ';
            emoji = '🟡';
        } else if (latency < 600) {
            quality = 'ꜰᴀɪʀ';
            emoji = '🟠';
        } else {
            quality = 'ᴘᴏᴏʀ';
            emoji = '🔴';
        }

        const finalMessage = {
            text: `┎━━━━━━━━━━━━━━━━━━┑\n┃\n┃ 🏓 *ᴘɪɴɢ ʀᴇꜱᴜʟᴛꜱ*\n┃\n┃ ⚡ ꜱᴘᴇᴇᴅ: ${latency}ᴍꜱ\n┃ ${emoji} ǫᴜᴀʟɪᴛʏ: ${quality}\n┃ 🕒 ᴛɪᴍᴇ: ${new Date().toLocaleString()}\n┃\n┖━━━━━━━━━━━━━━━━━━┙\n> ᴅᴀɴɪ ᴠ9 ᴍᴀɪɴꜰʀᴀᴍᴇ`,
            buttons: [
                { buttonId: `${config.PREFIX}bot_info`, buttonText: { displayText: '🤖 ꜱʏꜱᴛᴇᴍ ɪɴꜰᴏ' }, type: 1 },
                { buttonId: `${config.PREFIX}bot_stats`, buttonText: { displayText: '📊 ʙᴏᴛ ꜱᴛᴀᴛꜱ' }, type: 1 }
            ],
            headerType: 1,
            contextInfo: {
                forwardingScore: 999,
                isForwarded: true,
                forwardedNewsletterMessageInfo: {
                    newsletterJid: '120363377534493877@newsletter',
                    newsletterName: 'ᴅᴀɴɪ ᴠ9 ɴᴇᴛᴡᴏʀᴋ',
                    serverMessageId: 428
                }
            }
        };

        await socket.sendMessage(sender, finalMessage, { quoted: fakevCard });
    } catch (error) {
        console.error('Ping command error:', error);
        const startTime = Date.now();
        await socket.sendMessage(sender, { 
            text: '📡 ʀᴇ-ʀᴏᴜᴛɪɴɢ ᴘɪɴɢ...'
        }, { quoted: msg });
        const latency = Date.now() - startTime;
        await socket.sendMessage(sender, { 
            text: `┎━━━━━━━━━━━━━━━━━━┑\n┃\n┃ 🏓 ᴘɪɴɢ: ${latency}ᴍꜱ\n┃\n┖━━━━━━━━━━━━━━━━━━┙`
        }, { quoted: fakevCard });
    }
}
break;
}
                     // Case: pair
                case 'pair': {
                await socket.sendMessage(sender, { react: { text: '📲', key: msg.key } });
                    const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
                    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

                    const q = msg.message?.conversation ||
                            msg.message?.extendedTextMessage?.text ||
                            msg.message?.imageMessage?.caption ||
                            msg.message?.videoMessage?.caption || '';

                    const number = q.replace(/^[.\/!]pair\s*/i, '').trim();

                    if (!number) {
                        return await socket.sendMessage(sender, {
                            text: '*📌 ᴜsᴀɢᴇ:* .pair +24386xxxxx'
                        }, { quoted: msg });
                    }

                    try {
                        const url = `https://mini-stacy-xd-be3k.onrender.com/code?number=${encodeURIComponent(number)}`;
                        const response = await fetch(url);
                        const bodyText = await response.text();

                        console.log("🌐 API Response:", bodyText);

                        let result;
                        try {
                            result = JSON.parse(bodyText);
                        } catch (e) {
                            console.error("❌ JSON Parse Error:", e);
                            return await socket.sendMessage(sender, {
                                text: '❌ Invalid response from server. Please contact support.'
                            }, { quoted: msg });
                        }

                        if (!result || !result.code) {
                            return await socket.sendMessage(sender, {
                                text: '❌ Failed to retrieve pairing code. Please check the number.'
                            }, { quoted: msg });
                        }

                        await socket.sendMessage(sender, {
                            text: `> *ᴍɪɴɪ stacy xᴅ ᴘᴀɪʀ ᴄᴏᴍᴘʟᴇᴛᴇᴅ* ✅\n\n*🔑 ʏᴏᴜʀ ᴘᴀɪʀɪɴɢ ᴄᴏᴅᴇ ɪs:* ${result.code}`
                        }, { quoted: msg });

                        await sleep(2000);

                        await socket.sendMessage(sender, {
                            text: `${result.code}`
                        }, { quoted: fakevCard });

                    } catch (err) {
                        console.error("❌ Pair Command Error:", err);
                        await socket.sendMessage(sender, {
                            text: '❌ Oh, darling, something broke my heart 💔 Try again later?'
                        }, { quoted: fakevCard });
                    }
                    break;
                }
            // Case: viewonce
case 'viewonce':
case 'rvo':
case 'vv': {
  await socket.sendMessage(sender, { react: { text: '✨', key: msg.key } });

  try {
    if (!msg.quoted) {
      return await socket.sendMessage(sender, {
        text: `🚩 *ᴘʟᴇᴀsᴇ ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴠɪᴇᴡ-ᴏɴᴄᴇ ᴍᴇssᴀɢᴇ*\n\n` +
              `📝 *ʜᴏᴡ ᴛᴏ ᴜsᴇ:*\n` +
              `• ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴠɪᴇᴡ-ᴏɴᴄᴇ ɪᴍᴀɢᴇ, ᴠɪᴅᴇᴏ, ᴏʀ ᴀᴜᴅɪᴏ\n` +
              `• ᴜsᴇ: ${config.PREFIX}vv\n` +
              `• ɪ'ʟʟ ʀᴇᴠᴇᴀʟ ᴛʜᴇ ʜɪᴅᴅᴇɴ ᴛʀᴇᴀsᴜʀᴇ ғᴏʀ ʏᴏᴜ`
      });
    }

    // Get the quoted message with multiple fallback approaches
    const contextInfo = msg.msg?.contextInfo;
    const quotedMessage = msg.quoted?.message || 
                         contextInfo?.quotedMessage || 
                         (contextInfo?.stanzaId ? await getQuotedMessage(contextInfo.stanzaId) : null);

    if (!quotedMessage) {
      return await socket.sendMessage(sender, {
        text: `❌ *ɪ ᴄᴀɴ'ᴛ ғɪɴᴅ ᴛʜᴀᴛ ʜɪᴅᴅᴇɴ ɢᴇᴍ, ʟᴏᴠᴇ 😢*\n\n` +
              `ᴘʟᴇᴀsᴇ ᴛʀʏ:\n` +
              `• ʀᴇᴘʟʏ ᴅɪʀᴇᴄᴛʟʏ ᴛᴏ ᴛʜᴇ ᴠɪᴇᴡ-ᴏɴᴄᴇ ᴍᴇssᴀɢᴇ\n` +
              `• ᴍᴀᴋᴇ sᴜʀᴇ ɪᴛ ʜᴀsɴ'ᴛ ᴠᴀɴɪsʜᴇᴅ!`
      });
    }

    // Check for view once message
    let fileType = null;
    let mediaMessage = null;
    
    if (quotedMessage.viewOnceMessageV2) {
      // Handle viewOnceMessageV2 (newer format)
      const messageContent = quotedMessage.viewOnceMessageV2.message;
      if (messageContent.imageMessage) {
        fileType = 'image';
        mediaMessage = messageContent.imageMessage;
      } else if (messageContent.videoMessage) {
        fileType = 'video';
        mediaMessage = messageContent.videoMessage;
      } else if (messageContent.audioMessage) {
        fileType = 'audio';
        mediaMessage = messageContent.audioMessage;
      }
    } else if (quotedMessage.viewOnceMessage) {
      // Handle viewOnceMessage (older format)
      const messageContent = quotedMessage.viewOnceMessage.message;
      if (messageContent.imageMessage) {
        fileType = 'image';
        mediaMessage = messageContent.imageMessage;
      } else if (messageContent.videoMessage) {
        fileType = 'video';
        mediaMessage = messageContent.videoMessage;
      }
    } else if (quotedMessage.imageMessage?.viewOnce || 
               quotedMessage.videoMessage?.viewOnce || 
               quotedMessage.audioMessage?.viewOnce) {
      // Handle direct viewOnce properties
          if (quotedMessage.imageMessage?.viewOnce) {
        fileType = 'image';
        mediaMessage = quotedMessage.imageMessage;
      } else if (quotedMessage.videoMessage?.viewOnce) {
        fileType = 'video';
        mediaMessage = quotedMessage.videoMessage;
      } else if (quotedMessage.audioMessage?.viewOnce) {
        fileType = 'audio';
        mediaMessage = quotedMessage.audioMessage;
      }
    }

    if (!fileType || !mediaMessage) {
      return await socket.sendMessage(sender, {
        text: `⚠️ *ᴛʜɪs ɪsɴ'ᴛ ᴀ ᴠɪᴇᴡ-ᴏɴᴄᴇ ᴍᴇssᴀɢᴇ*\n\n` +
              `ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴍᴇssᴀɢᴇ ᴡɪᴛʜ ʜɪᴅᴅᴇɴ ᴍᴇᴅɪᴀ (ɪᴍᴀɢᴇ, ᴠɪᴅᴇᴏ, ᴏʀ ᴀᴜᴅɪᴏ)`
      });
    }

    await socket.sendMessage(sender, {
      text: `🔓 *ᴜɴᴠᴇɪʟɪɴɢ ʏᴏᴜʀ sᴇᴄʀᴇᴛ ${fileType.toUpperCase()}...*`
    });

    // Download and send the media
  const mediaBuffer = await downloadMediaMessage(
      { 
        key: msg.quoted.key, 
        message: { 
          [fileType + 'Message']: mediaMessage 
        } 
      },
      'buffer',
      {}
    );

    if (!mediaBuffer) {
      throw new Error('Failed to download media');
    }

    // Determine the mimetype and filename
    const mimetype = mediaMessage.mimetype || 
                    (fileType === 'image' ? 'image/jpeg' : 
                     fileType === 'video' ? 'video/mp4' : 'audio/mpeg');
    
    const extension = mimetype.split('/')[1];
    const filename = `revealed-${fileType}-${Date.now()}.${extension}`;

    // Prepare message options based on media type
    let messageOptions = {
      caption: `✨ *ʀᴇᴠᴇᴀʟᴇᴅ ${fileType.toUpperCase()}* - ʏᴏᴜ'ʀᴇ ᴡᴇʟᴄᴏᴍᴇ`
    };

    // Send the media based on its type
    if (fileType === 'image') {
      await socket.sendMessage(sender, {
        image: mediaBuffer,
        ...messageOptions
      });
    } else if (fileType === 'video') {
      await socket.sendMessage(sender, {
        video: mediaBuffer,
        ...messageOptions
      });
    } else if (fileType === 'audio') {
      await socket.sendMessage(sender, {
        audio: mediaBuffer,
        ...messageOptions,
        mimetype: mimetype
      });
    }

    await socket.sendMessage(sender, {
      react: { text: '✅', key: msg.key }
    });
  } catch (error) {
    console.error('ViewOnce command error:', error);
    let errorMessage = `❌ *ᴏʜ ɴᴏ, ɪ ᴄᴏᴜʟᴅɴ'ᴛ ᴜɴᴠᴇɪʟ ɪᴛ*\n\n`;

    if (error.message?.includes('decrypt') || error.message?.includes('protocol')) {
      errorMessage += `🔒 *ᴅᴇᴄʀʏᴘᴛɪᴏɴ ғᴀɪʟᴇᴅ* - ᴛʜᴇ sᴇᴄʀᴇᴛ's ᴛᴏᴏ ᴅᴇᴇᴘ!`;
    } else if (error.message?.includes('download') || error.message?.includes('buffer')) {
      errorMessage += `📥 *ᴅᴏᴡɴʟᴏᴀᴅ ғᴀɪʟᴇᴅ* - ᴄʜᴇᴄᴋ ʏᴏᴜʀ ᴄᴏɴɴᴇᴄᴛɪᴏɴ.`;
    } else if (error.message?.includes('expired') || error.message?.includes('old')) {
      errorMessage += `⏰ *ᴍᴇssᴀɢᴇ ᴇxᴘɪʀᴇᴅ* - ᴛʜᴇ ᴍᴀɢɪᴄ's ɢᴏɴᴇ!`;
    } else {
      errorMessage += `🐛 *ᴇʀʀᴏʀ:* ${error.message || 'sᴏᴍᴇᴛʜɪɴɢ ᴡᴇɴᴛ ᴡʀᴏɴɢ'}`;
    }

    errorMessage += `\n\n💡 *ᴛʀʏ:*\n• ᴜsɪɴɢ ᴀ ғʀᴇsʜ ᴠɪᴇᴡ-ᴏɴᴄᴇ ᴍᴇssᴀɢᴇ\n• ᴄʜᴇᴄᴋɪɴɢ ʏᴏᴜʀ ɪɴᴛᴇʀɴᴇᴛ ᴄᴏɴɴᴇᴄᴛɪᴏɴ`;

    await socket.sendMessage(sender, { text: errorMessage });
    await socket.sendMessage(sender, {
      react: { text: '❌', key: msg.key }
    });
  }
  break;
}
// Case: song
case 'play':
case 'song': {
    // Import dependencies
    const yts = require('yt-search');
    const ddownr = require('denethdev-ytmp3');
    const fs = require('fs').promises;
    const path = require('path');
    const { exec } = require('child_process');
    const util = require('util');
    const execPromise = util.promisify(exec);
    const { existsSync, mkdirSync } = require('fs');

    // Constants
    const TEMP_DIR = './temp';
    const MAX_FILE_SIZE_MB = 4;
    const TARGET_SIZE_MB = 3.8;

    // Ensure temp directory exists
    if (!existsSync(TEMP_DIR)) {
        mkdirSync(TEMP_DIR, { recursive: true });
    }

    // Utility functions
    function extractYouTubeId(url) {
        const regex = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/;
        const match = url.match(regex);
        return match ? match[1] : null;
    }

    function convertYouTubeLink(input) {
        const videoId = extractYouTubeId(input);
        return videoId ? `https://www.youtube.com/watch?v=${videoId}` : input;
    }

    function formatDuration(seconds) {
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = Math.floor(seconds % 60);
        return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
    }

    async function compressAudio(inputPath, outputPath, targetSizeMB = TARGET_SIZE_MB) {
        try {
            const { stdout: durationOutput } = await execPromise(
                `ffprobe -i "${inputPath}" -show_entries format=duration -v quiet -of csv="p=0"`
            );
            const duration = parseFloat(durationOutput) || 180;
            const targetBitrate = Math.floor((targetSizeMB * 8192) / duration);
            const constrainedBitrate = Math.min(Math.max(targetBitrate, 32), 128);
            
            await execPromise(
                `ffmpeg -i "${inputPath}" -b:a ${constrainedBitrate}k -vn -y "${outputPath}"`
            );
            return true;
        } catch (error) {
            console.error('Audio compression failed:', error);
            return false;
        }
    }

    async function cleanupFiles(...filePaths) {
        for (const filePath of filePaths) {
            if (filePath) {
                try {
                    await fs.unlink(filePath);
                } catch (err) {
                    // Silent cleanup - no error reporting needed
                }
            }
        }
    }

    // Extract query from message
    const q = msg.message?.conversation || 
              msg.message?.extendedTextMessage?.text || 
              msg.message?.imageMessage?.caption || 
              msg.message?.videoMessage?.caption || '';

    if (!q || q.trim() === '') {
        return await socket.sendMessage(sender, 
            { text: '*`ɢɪᴠᴇ ᴍᴇ ᴀ sᴏɴɢ ᴛɪᴛʟᴇ ᴏʀ ʏᴏᴜᴛᴜʙᴇ ʟɪɴᴋ`*' }, 
            { quoted: fakevCard }
        );
    }

    const fixedQuery = convertYouTubeLink(q.trim());
    let tempFilePath = '';
    let compressedFilePath = '';

    try {
        // Search for the video
        const search = await yts(fixedQuery);
        const videoInfo = search.videos[0];
        
        if (!videoInfo) {
            return await socket.sendMessage(sender, 
                { text: '*`ɴᴏ sᴏɴɢs ғᴏᴜɴᴅ! Try ᴀɴᴏᴛʜᴇʀ`*' }, 
                { quoted: fakevCard }
            );
        }

        // Format duration
        const formattedDuration = formatDuration(videoInfo.seconds);
        
        // Create description
        const desc = `
┎━━━━━━━━━━━━━━━━━━┑
┃ 🎧 *ᴅᴀɴɪ ᴠ9 ᴀᴜᴅɪᴏ ꜰᴇᴛᴄʜ*
┃ 
┃ 🎵 ᴛɪᴛʟᴇ: ${videoInfo.title}
┃ 👤 ᴀʀᴛɪꜱᴛ: ${videoInfo.author.name}
┃ ⏳ ᴅᴜʀᴀᴛɪᴏɴ: ${formattedDuration}
┃ 📅 ᴜᴘʟᴏᴀᴅᴇᴅ: ${videoInfo.ago}
┃ 👁️ ᴠɪᴇᴡꜱ: ${videoInfo.views.toLocaleString()}
┃ 💿 ꜰᴏʀᴍᴀᴛ: ʜɪɢʜ ᴅᴇꜰ ᴍᴘ3
┖━━━━━━━━━━━━━━━━━━┙
> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴅᴀᴍɪɴɪ ᴄᴏᴅᴇꜱᴘʜᴇʀᴇ`;

        // Send video info upgrade
        await socket.sendMessage(sender, {
            image: { url: videoInfo.thumbnail },
            caption: desc,
            contextInfo: {
                forwardingScore: 999,
                isForwarded: true,
                forwardedNewsletterMessageInfo: {
                    newsletterJid: '120363377534493877@newsletter',
                    newsletterName: 'ᴅᴀɴɪ ᴠ9 ɴᴇᴛᴡᴏʀᴋ',
                    serverMessageId: 428
                }
            }
        }, { quoted: fakevCard });
      
        // Download the audio
        const result = await ddownr.download(videoInfo.url, 'mp3');
        const downloadLink = result.downloadUrl;

        // Clean title for filename
        const cleanTitle = videoInfo.title.replace(/[^\w\s]/gi, '').substring(0, 30);
        tempFilePath = path.join(TEMP_DIR, `${cleanTitle}_${Date.now()}_original.mp3`);
        compressedFilePath = path.join(TEMP_DIR, `${cleanTitle}_${Date.now()}_compressed.mp3`);

        // Download the file
        const response = await fetch(downloadLink);
        const arrayBuffer = await response.arrayBuffer();
        await fs.writeFile(tempFilePath, Buffer.from(arrayBuffer));

        // Check file size and compress if needed
        const stats = await fs.stat(tempFilePath);
        const fileSizeMB = stats.size / (1024 * 1024);
        
        if (fileSizeMB > MAX_FILE_SIZE_MB) {
            const compressionSuccess = await compressAudio(tempFilePath, compressedFilePath);
            if (compressionSuccess) {
                await cleanupFiles(tempFilePath);
                tempFilePath = compressedFilePath;
                compressedFilePath = '';
            }
        }

        // Send the audio file
        const audioBuffer = await fs.readFile(tempFilePath);
        await socket.sendMessage(sender, {
            audio: audioBuffer,
            mimetype: "audio/mpeg",
            fileName: `${cleanTitle}.mp3`,
            ptt: false
        }, { quoted: fakevCard });

        // Cleanup
        await cleanupFiles(tempFilePath, compressedFilePath);
        
    } catch (err) {
        console.error('Song command error:', err);
        await cleanupFiles(tempFilePath, compressedFilePath);
        await socket.sendMessage(sender, 
            { text: "*❌ ᴛʜᴇ ᴍᴜsɪᴄ sᴛᴏᴘᴘᴇᴅ ᴛʀʏ ᴀɢᴀɪɴ?*" }, 
            { quoted: fakevCard }
        );
    }
    break;
}
//===============================   
          case 'logo': { 
                    const q = args.join(" ");
                    
                    
                    if (!q || q.trim() === '') {
                        return await socket.sendMessage(sender, { text: '*`ɴᴇᴇᴅ ᴀ ɴᴀᴍᴇ ғᴏʀ ʟᴏɢᴏ`*' });
                    }

                    await socket.sendMessage(sender, { react: { text: '⬆️', key: msg.key } });
                    const list = await axios.get('https://raw.githubusercontent.com/md2839pv404/anony0808/refs/heads/main/ep.json');

                    const rows = list.data.map((v) => ({
                        title: v.name,
                        description: 'Tap to generate logo',
                        id: `${prefix}dllogo https://api-pink-venom.vercel.app/api/logo?url=${v.url}&name=${q}`
                    }));
                    
                    const buttonMessage = {
                        buttons: [
                            {
                                buttonId: 'action',
                                buttonText: { displayText: '🎨 sᴇʟᴇᴄᴛ ᴛᴇxᴛ ᴇғғᴇᴄᴛ' },
                                type: 4,
                                nativeFlowInfo: {
                                    name: 'single_select',
                                    paramsJson: JSON.stringify({
                                        title: 'Available Text Effects',
                                        sections: [
                                            {
                                                title: 'Choose your logo style',
                                                rows
                                            }
                                        ]
                                    })
                                }
                            }
                        ],
                        headerType: 1,
                        viewOnce: true,
                        caption: '❏ *ʟᴏɢᴏ ᴍᴀᴋᴇʀ*',
                        image: { url: 'https://ibb.co/wr0hk07Q' },
                    };

                    await socket.sendMessage(from, buttonMessage, { quoted: fakevCard });
                    break;
                }
//===============================                
// 9
          case 'dllogo': { 
                await socket.sendMessage(sender, { react: { text: '🔋', key: msg.key } });
                    const q = args.join(" "); 
                    
                    if (!q) return await socket.sendMessage(from, { text: "ᴘʟᴇᴀsᴇ ɢɪᴠᴇ ᴍᴇ ᴀ ᴜʀʟ ᴛᴏ ᴄᴀᴘᴛᴜʀᴇ ᴛʜᴇ sᴄʀᴇᴇɴsʜᴏᴛ" }, { quoted: fakevCard });
                    
                    try {
                        const res = await axios.get(q);
                        const images = res.data.result.download_url;

                        await socket.sendMessage(m.chat, {
                            image: { url: images },
                            caption: config.CAPTION
                        }, { quoted: msg });
                    } catch (e) {
                        console.log('Logo Download Error:', e);
                        await socket.sendMessage(from, {
                            text: `❌ Oh, sweetie, something went wrong with the logo... 💔 Try again?`
                        }, { quoted: fakevCard });
                    }
                    break;
                }
                               
//===============================
                case 'fancy': {
                await socket.sendMessage(sender, { react: { text: '🖋', key: msg.key } });
                    const axios = require("axios");
                    
                    const q =
                        msg.message?.conversation ||
                        msg.message?.extendedTextMessage?.text ||
                        msg.message?.imageMessage?.caption ||
                        msg.message?.videoMessage?.caption || '';

                    const text = q.trim().replace(/^.fancy\s+/i, "");

                    if (!text) {
                        return await socket.sendMessage(sender, {
                            text: "❎ *ɢɪᴠᴇ ᴍᴇ some ᴛᴇxᴛ ᴛᴏ ᴍᴀᴋᴇ ɪᴛ ғᴀɴᴄʏ*\n\n📌 *ᴇxᴀᴍᴘʟᴇ:* `.Stacy-girl`"
                        });
                    }

                    try {
                        const apiUrl = `https://www.dark-yasiya-api.site/other/font?text=${encodeURIComponent(text)}`;
                        const response = await axios.get(apiUrl);

                        if (!response.data.status || !response.data.result) {
                            return await socket.sendMessage(sender, {
                                text: "❌ ᴛʜᴇ ғᴏɴᴛs ɢᴏᴛ sʜʏ! ᴛʀʏ ᴀɢᴀɪɴ ʟᴀᴛᴇʀ*"
                            });
                        }

                        const fontList = response.data.result
                            .map(font => `*${font.name}:*\n${font.result}`)
                            .join("\n\n");

                        const finalMessage = `🎨 *ғᴀɴᴄʏ ғᴏɴᴛs ᴄᴏɴᴠᴇʀᴛᴇʀ*\n\n${fontList}\n\n> Powered by me`;

                        await socket.sendMessage(sender, {
                            text: finalMessage
                        }, { quoted: fakevCard });
                    } catch (err) {
                        console.error("Fancy Font Error:", err);
                        await socket.sendMessage(sender, {
                            text: "⚠️ *Something went wrong with the fonts, love 😢 Try again?*"
                        });
                    }
                    break;
                    }
                
case 'tiktok': {
const axios = require('axios');

// Optimized axios instance
const axiosInstance = axios.create({
  timeout: 15000,
  maxRedirects: 5,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
  }
});

// TikTok API configuration
const TIKTOK_API_KEY = process.env.TIKTOK_API_KEY || 'free_key@maher_apis'; // Fallback for testing
  try {
    // Get query from message
    const q = msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text ||
              msg.message?.imageMessage?.caption ||
              msg.message?.videoMessage?.caption || '';

    // Validate and sanitize URL
    const tiktokUrl = q.trim();
    const urlRegex = /(?:https?:\/\/)?(?:www\.)?(?:tiktok\.com|vm\.tiktok\.com)\/[@a-zA-Z0-9_\-\.\/]+/;
    if (!tiktokUrl || !urlRegex.test(tiktokUrl)) {
      await socket.sendMessage(sender, {
        text: '📥 *ᴜsᴀɢᴇ:* .tiktok <TikTok URL>\nExample: .tiktok https://www.tiktok.com/@user/video/123456789'
      }, { quoted: fakevCard });
      return;
    }

    // Send downloading reaction
    try {
      await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });
    } catch (reactError) {
      console.error('Reaction error:', reactError);
    }

    // Try primary API
    let data;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout
      const res = await axiosInstance.get(`https://api.nexoracle.com/downloader/tiktok-nowm?apikey=${TIKTOK_API_KEY}&url=${encodeURIComponent(tiktokUrl)}`, {
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (res.data?.status === 200) {
        data = res.data.result;
      }
    } catch (primaryError) {
      console.error('Primary API error:', primaryError.message);
    }

    // Fallback API
    if (!data) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout
        const fallback = await axiosInstance.get(`https://api.tikwm.com/?url=${encodeURIComponent(tiktokUrl)}&hd=1`, {
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (fallback.data?.data) {
          const r = fallback.data.data;
          data = {
            title: r.title || 'No title',
            author: {
              username: r.author?.unique_id || 'Unknown',
              nickname: r.author?.nickname || 'Unknown'
            },
            metrics: {
              digg_count: r.digg_count || 0,
              comment_count: r.comment_count || 0,
              share_count: r.share_count || 0,
              download_count: r.download_count || 0
            },
            url: r.play || '',
            thumbnail: r.cover || ''
          };
        }
      } catch (fallbackError) {
        console.error('Fallback API error:', fallbackError.message);
      }
    }

    if (!data || !data.url) {
      await socket.sendMessage(sender, { text: '❌ TikTok video not found.' }, { quoted: fakevCard });
      return;
    }

    const { title, author, url, metrics, thumbnail } = data;

    // Prepare caption
    const caption = `
┎━━━━━━━━━━━━━━━━━━┑
┃ 📱 *ᴅᴀɴɪ ᴠ9 ᴛɪᴋᴛᴏᴋ ᴇxᴛʀᴀᴄᴛ*
┃ 
┃ 🎬 ᴛɪᴛʟᴇ: ${title.replace(/[<>:"\/\\|?*]/g, '')}
┃ 👤 ᴀᴜᴛʜᴏʀ: @${author.username.replace(/[<>:"\/\\|?*]/g, '')}
┃ 💖 ʟɪᴋᴇꜱ: ${metrics.digg_count.toLocaleString()}
┃ 💬 ᴄᴏᴍᴍᴇɴᴛꜱ: ${metrics.comment_count.toLocaleString()}
┃ 🚀 ꜱʜᴀʀᴇꜱ: ${metrics.share_count.toLocaleString()}
┃ 📥 ᴅᴏᴡɴʟᴏᴀᴅꜱ: ${metrics.download_count.toLocaleString()}
┖━━━━━━━━━━━━━━━━━━┙
> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴅᴀᴍɪɴɪ ᴄᴏᴅᴇꜱᴘʜᴇʀᴇ`;

    // Send thumbnail with info
    await socket.sendMessage(sender, {
      image: { url: thumbnail || 'https://i.ibb.co/ynmqJG8j/vision-v.jpg' }, // Fallback image
      caption
    }, { quoted: fakevCard });

    // Download video
    const loading = await socket.sendMessage(sender, { text: '⏳ Downloading video...' }, { quoted: fakevCard });
    let videoBuffer;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout
      const response = await axiosInstance.get(url, {
        responseType: 'arraybuffer',
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      videoBuffer = Buffer.from(response.data, 'binary');

      // Basic size check (e.g., max 50MB)
      if (videoBuffer.length > 50 * 1024 * 1024) {
        throw new Error('Video file too large');
      }
    } catch (downloadError) {
      console.error('Video download error:', downloadError.message);
      await socket.sendMessage(sender, { text: '❌ Failed to download video.' }, { quoted: fakevCard });
      await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
      return;
    }

    // Send video
    await socket.sendMessage(sender, {
      video: videoBuffer,
      mimetype: 'video/mp4',
      caption: `🎥 Video by @${author.username.replace(/[<>:"\/\\|?*]/g, '')}\n> ᴍᴀᴅᴇ ɪɴ ʙʏ ɪɴᴄᴏɴɴᴜ`
    }, { quoted: fakevCard });

    // Update loading message
    await socket.sendMessage(sender, { text: '✅ Video sent!', edit: loading.key });

    // Send success reaction
    try {
      await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    } catch (reactError) {
      console.error('Success reaction error:', reactError);
    }

  } catch (error) {
    console.error('TikTok command error:', {
      error: error.message,
      stack: error.stack,
      url: tiktokUrl,
      sender
    });

    let errorMessage = '❌ Failed to download TikTok video. Please try again.';
    if (error.name === 'AbortError') {
      errorMessage = '❌ Download timed out. Please try again.';
    }

    await socket.sendMessage(sender, { text: errorMessage }, { quoted: fakevCard });
    try {
      await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
    } catch (reactError) {
      console.error('Error reaction error:', reactError);
    }
  }
  break;
}
//===============================

                    
                          case 'bomb': {
                    await socket.sendMessage(sender, { react: { text: '🔥', key: msg.key } });
                    const q = msg.message?.conversation ||
                              msg.message?.extendedTextMessage?.text || '';
                    const [target, text, countRaw] = q.split(',').map(x => x?.trim());

                    const count = parseInt(countRaw) || 5;

                    if (!target || !text || !count) {
                        return await socket.sendMessage(sender, {
                            text: '📌 *ᴜsᴀɢᴇ:* .bomb <number>,<message>,<count>\n\nExample:\n.bomb 554XXXXXXX,Hello 👋,5'
                        }, { quoted: msg });
                    }

                    const jid = `${target.replace(/[^0-9]/g, '')}@s.whatsapp.net`;

                    if (count > 20) {
                        return await socket.sendMessage(sender, {
                            text: '❌ *Easy, tiger! Max 20 messages per bomb, okay? 😘*'
                        }, { quoted: msg });
                    }

                    for (let i = 0; i < count; i++) {
                        await socket.sendMessage(jid, { text });
                        await delay(700);
                    }

                    await socket.sendMessage(sender, {
                        text: `✅ Bomb sent to ${target} — ${count}! 💣😉`
                    }, { quoted: fakevCard });
                    break;
                }
//===============================
// 13

                                
// ┏━━━━━━━━━━━━━━━❖
// ┃ FUN & ENTERTAINMENT COMMANDS
// ┗━━━━━━━━━━━━━━━❖

case "joke": {
    try {
        await socket.sendMessage(sender, { react: { text: '🤣', key: msg.key } });
        const res = await fetch('https://v2.jokeapi.dev/joke/Any?type=single');
        const data = await res.json();
        if (!data || !data.joke) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch a joke right now. Try again later.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, { text: `🃏 *Random Joke:*\n\n${data.joke}` }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to fetch joke.' }, { quoted: fakevCard });
    }
    break;
}


case "waifu": {
    try {
        await socket.sendMessage(sender, { react: { text: '🥲', key: msg.key } });
        const res = await fetch('https://api.waifu.pics/sfw/waifu');
        const data = await res.json();
        if (!data || !data.url) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch waifu image.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, {
            image: { url: data.url },
            caption: '✨ Here\'s your random waifu!'
        }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to get waifu.' }, { quoted: fakevCard });
    }
    break;
}

case "meme": {
    try {
        await socket.sendMessage(sender, { react: { text: '😂', key: msg.key } });
        const res = await fetch('https://meme-api.com/gimme');
        const data = await res.json();
        if (!data || !data.url) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch meme.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, {
            image: { url: data.url },
            caption: `🤣 *${data.title}*`
        }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to fetch meme.' }, { quoted: fakevCard });
    }
    break;
}

case "cat": {
    try {
        await socket.sendMessage(sender, { react: { text: '🐱', key: msg.key } });
        const res = await fetch('https://api.thecatapi.com/v1/images/search');
        const data = await res.json();
        if (!data || !data[0]?.url) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch cat image.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, {
            image: { url: data[0].url },
            caption: '🐱 ᴍᴇᴏᴡ~ ʜᴇʀᴇ\'s a ᴄᴜᴛᴇ ᴄᴀᴛ ғᴏʀ ʏᴏᴜ!'
        }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to fetch cat image.' }, { quoted: fakevCard });
    }
    break;
}

case "dog": {
    try {
        await socket.sendMessage(sender, { react: { text: '🦮', key: msg.key } });
        const res = await fetch('https://dog.ceo/api/breeds/image/random');
        const data = await res.json();
        if (!data || !data.message) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch dog image.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, {
            image: { url: data.message },
            caption: '🐶 Woof! Here\'s a cute dog!'
        }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to fetch dog image.' }, { quoted: fakevCard });
    }
    break;
}

case "fact": {
    try {
        await socket.sendMessage(sender, { react: { text: '😑', key: msg.key } });
        const res = await fetch('https://uselessfacts.jsph.pl/random.json?language=en');
        const data = await res.json();
        if (!data || !data.text) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch a fact.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, { text: `💡 *Random Fact:*\n\n${data.text}` }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch a fact.' }, { quoted: fakevCard });
    }
    break;
}

case "darkjoke": case "darkhumor": {
    try {
        await socket.sendMessage(sender, { react: { text: '😬', key: msg.key } });
        const res = await fetch('https://v2.jokeapi.dev/joke/Dark?type=single');
        const data = await res.json();
        if (!data || !data.joke) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch a dark joke.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, { text: `🌚 *Dark Humor:*\n\n${data.joke}` }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to fetch dark joke.' }, { quoted: fakevCard });
    }
    break;
}

// ┏━━━━━━━━━━━━━━━❖
// ┃ ROMANTIC, SAVAGE & THINKY COMMANDS
// ┗━━━━━━━━━━━━━━━❖

case "pickup": case "pickupline": {
    try {
        await socket.sendMessage(sender, { react: { text: '🥰', key: msg.key } });
        const res = await fetch('https://vinuxd.vercel.app/api/pickup');
        const data = await res.json();
        if (!data || !data.data) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t find a pickup line.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, { text: `💘 *Pickup Line:*\n\n_${data.data}_` }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to fetch pickup line.' }, { quoted: fakevCard });
    }
    break;
}

case "roast": {
    try {
        await socket.sendMessage(sender, { react: { text: '🤬', key: msg.key } });
        const res = await fetch('https://vinuxd.vercel.app/api/roast');
        const data = await res.json();
        if (!data || !data.data) {
            await socket.sendMessage(sender, { text: '❌ No roast available at the moment.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, { text: `🔥 *Roast:* ${data.data}` }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to fetch roast.' }, { quoted: fakevCard });
    }
    break;
}

case "lovequote": {
    try {
        await socket.sendMessage(sender, { react: { text: '🙈', key: msg.key } });
        const res = await fetch('https://api.popcat.xyz/lovequote');
        const data = await res.json();
        if (!data || !data.quote) {
            await socket.sendMessage(sender, { text: '❌ Couldn\'t fetch love quote.' }, { quoted: fakevCard });
            break;
        }
        await socket.sendMessage(sender, { text: `❤️ *Love Quote:*\n\n"${data.quote}"` }, { quoted: fakevCard });
    } catch (err) {
        console.error(err);
        await socket.sendMessage(sender, { text: '❌ Failed to fetch love quote.' }, { quoted: fakevCard });
    }
    break;
}
//===============================
                case 'fb': {
                    const axios = require('axios');                   
                    
                    const q = msg.message?.conversation || 
                              msg.message?.extendedTextMessage?.text || 
                              msg.message?.imageMessage?.caption || 
                              msg.message?.videoMessage?.caption || 
                              '';

                    const fbUrl = q?.trim();

                    if (!/facebook\.com|fb\.watch/.test(fbUrl)) {
                        return await socket.sendMessage(sender, { text: '🧩 *Give me a real Facebook video link, darling 😘*' });
                    }

                    try {
                        const res = await axios.get(`https://suhas-bro-api.vercel.app/download/fbdown?url=${encodeURIComponent(fbUrl)}`);
                        const result = res.data.result;

                        await socket.sendMessage(sender, { react: { text: '⬇', key: msg.key } });

                        await socket.sendMessage(sender, {
                            video: { url: result.sd },
                            mimetype: 'video/mp4',
                            caption: '> ᴍᴀᴅᴇ ɪɴ ʙʏ Stacy'
                        }, { quoted: fakevCard });

                        await socket.sendMessage(sender, { react: { text: '✔', key: msg.key } });
                    } catch (e) {
                        console.log(e);
                        await socket.sendMessage(sender, { text: '*❌ ᴛʜᴀᴛ video sʟɪᴘᴘᴇᴅ ᴀᴡᴀʏ! ᴛʀʏ ᴀɢᴀɪɴ? 💔*' });
                    }
                    break;
                }
                

//===============================
                case 'nasa': {
                    try {
                    await socket.sendMessage(sender, { react: { text: '✔️', key: msg.key } });
                        const response = await fetch('https://api.nasa.gov/planetary/apod?api_key=8vhAFhlLCDlRLzt5P1iLu2OOMkxtmScpO5VmZEjZ');
                        if (!response.ok) {
                            throw new Error('Failed to fetch APOD from NASA API');
                        }
                        const data = await response.json();

                        if (!data.title || !data.explanation || !data.date || !data.url || data.media_type !== 'image') {
                            throw new Error('Invalid APOD data received or media type is not an image');
                        }

                        const { title, explanation, date, url, copyright } = data;
                        const thumbnailUrl = url || 'https://via.placeholder.com/150';

                        await socket.sendMessage(sender, {
                            image: { url: thumbnailUrl },
                            caption: formatMessage(
                                '🌌 ᴍɪɴɪ stacy xᴅ ɴᴀsᴀ ɴᴇᴡs',
                                `🌠 *${title}*\n\n${explanation.substring(0, 200)}...\n\n📆 *ᴅᴀᴛᴇ*: ${date}\n${copyright ? `📝 *ᴄʀᴇᴅɪᴛ*: ${copyright}` : ''}\n🔗 *Link*: https://apod.nasa.gov/apod/astropix.html`,
                                'Powered by ᴍɪɴɪ stacy xᴅ'
                            )
                        });
                    } catch (error) {
                        console.error(`Error in 'nasa' case: ${error.message}`);
                        await socket.sendMessage(sender, {
                            text: '⚠️ Oh, love, the stars didn’t align this time! 🌌 Try again? 😘'
                        });
                    }
                    break;
                }
//===============================
                case 'news': {
                await socket.sendMessage(sender, { react: { text: '😒', key: msg.key } });
                    try {
                        const response = await fetch('https://suhas-bro-api.vercel.app/news/lnw');
                        if (!response.ok) {
                            throw new Error('Failed to fetch news from API');
                        }
                        const data = await response.json();

                        if (!data.status || !data.result || !data.result.title || !data.result.desc || !data.result.date || !data.result.link) {
                            throw new Error('Invalid news data received');
                        }

                        const { title, desc, date, link } = data.result;
                        let thumbnailUrl = 'https://via.placeholder.com/150';
                        try {
                            const pageResponse = await fetch(link);
                            if (pageResponse.ok) {
                                const pageHtml = await pageResponse.text();
                                const $ = cheerio.load(pageHtml);
                                const ogImage = $('meta[property="og:image"]').attr('content');
                                if (ogImage) {
                                    thumbnailUrl = ogImage;
                                } else {
                                    console.warn(`No og:image found for ${link}`);
                                }
                            } else {
                                console.warn(`Failed to fetch page ${link}: ${pageResponse.status}`);
                            }
                        } catch (err) {
                            console.warn(`Failed to scrape thumbnail from ${link}: ${err.message}`);
                        }

                        await socket.sendMessage(sender, {
                            image: { url: thumbnailUrl },
                            caption: formatMessage(
                                '📰 ᴍɪɴɪ Stacy xᴅ 📰',
                                `📢 *${title}*\n\n${desc}\n\n🕒 *ᴅᴀᴛᴇ*: ${date}\n🌐 *Link*: ${link}`,
                                'Powered by stacy 🌹 tech'
                            )
                        });
                    } catch (error) {
                        console.error(`Error in 'news' case: ${error.message}`);
                        await socket.sendMessage(sender, {
                            text: '⚠️ Oh, sweetie, the news got lost in the wind! 😢 Try again?'
                        });
                    }
                    break;
                }
//===============================                
// 17

                    
                case 'cricket': {
    await socket.sendMessage(sender, { react: { text: '😑', key: msg.key } });
    try {
        console.log('Fetching cricket news from API...');
        const response = await fetch('https://suhas-bro-api.vercel.app/news/cricbuzz');
        console.log(`API Response Status: ${response.status}`);

        if (!response.ok) {
            throw new Error(`API request failed with status ${response.status}`);
        }

        const data = await response.json();
        console.log('API Response Data:', JSON.stringify(data, null, 2));

        if (!data.status || !data.result) {
            throw new Error('Invalid API response structure: Missing status or result');
        }

        const { title, score, to_win, crr, link } = data.result;

        if (!title || !score || !to_win || !crr || !link) {
            throw new Error(
                'Missing required fields in API response: ' + JSON.stringify(data.result)
            );
        }

        console.log('Sending message to user...');
        await socket.sendMessage(sender, {
            text: formatMessage(
                '🏏 ᴍɪɴɪ stacy xᴅ ᴄʀɪᴄᴋᴇᴛ ɴᴇᴡs🏏',
                `📢 *${title}*\n\n` +
                `🏆 *ᴍᴀʀᴋ*: ${score}\n` +
                `🎯 *ᴛᴏ ᴡɪɴ*: ${to_win}\n` +
                `📈 *ᴄᴜʀʀᴇɴᴛ Rate*: ${crr}\n\n` +
                `🌐 *ʟɪɴᴋ*: ${link}`,
                'ᴍɪɴɪ stacy xᴅ'
            )
        });
        console.log('Message sent successfully.');
    } catch (error) {
        console.error(`Error in 'cricket' case: ${error.message}`);
        await socket.sendMessage(sender, {
            text: '⚠️ ᴛʜᴇ ᴄʀɪᴄᴋᴇᴛ ʙᴀʟʟ ғʟᴇᴡ ᴀᴡᴀʏ!  ᴛʀʏ ᴀɢᴀɪɴ?'
        });
    }
    break;
                    }

                    // new case 
                    
                case 'winfo': {
                
                        await socket.sendMessage(sender, { react: { text: '😢', key: msg.key } });
                    console.log('winfo command triggered for:', number);
                    if (!args[0]) {
                        await socket.sendMessage(sender, {
                            image: { url: config.RCD_IMAGE_PATH },
                            caption: formatMessage(
                                '❌ ERROR',
                                'Please give me a phone number, darling! Usage: .winfo 24386xxxxxxxx',
                                'Powered by stacy🌹 tech'
                            )
                        });
                        break;
                    }

                    let inputNumber = args[0].replace(/[^0-9]/g, '');
                    if (inputNumber.length < 10) {
                        await socket.sendMessage(sender, {
                            image: { url: config.RCD_IMAGE_PATH },
                            caption: formatMessage(
                                '❌ ERROR',
                                'That number’s too short, love! Try: .winfo  24386xxxxx',
                                'ᴍɪɴɪ stacy xᴅ'
                            )
                        });
                        break;
                    }

                    let winfoJid = `${inputNumber}@s.whatsapp.net`;
                    const [winfoUser] = await socket.onWhatsApp(winfoJid).catch(() => []);
                    if (!winfoUser?.exists) {
                        await socket.sendMessage(sender, {
                            image: { url: config.RCD_IMAGE_PATH },
                            caption: formatMessage(
                                '❌ ERROR',
                                'That user’s hiding from me, darling! Not on WhatsApp 😢',
                                'ᴍɪɴɪ stacy xᴅ'
                            )
                        });
                        break;
                    }

                    let winfoPpUrl;
                    try {
                        winfoPpUrl = await socket.profilePictureUrl(winfoJid, 'image');
                    } catch {
                        winfoPpUrl = 'https://i.ibb.co/KhYC4FY/1221bc0bdd2354b42b293317ff2adbcf-icon.png';
                    }

                    let winfoName = winfoJid.split('@')[0];
                    try {
                        const presence = await socket.presenceSubscribe(winfoJid).catch(() => null);
                        if (presence?.pushName) winfoName = presence.pushName;
                    } catch (e) {
                        console.log('Name fetch error:', e);
                    }

                    let winfoBio = 'No bio available';
                    try {
                        const statusData = await socket.fetchStatus(winfoJid).catch(() => null);
                        if (statusData?.status) {
                            winfoBio = `${statusData.status}\n└─ 📌 ᴜᴘᴅᴀᴛᴇᴅ: ${statusData.setAt ? new Date(statusData.setAt).toLocaleString('en-US', { timeZone: 'Africa/Nairobi' }) : 'Unknown'}`;
                        }
                    } catch (e) {
                        console.log('Bio fetch error:', e);
                    }

                    let winfoLastSeen = '❌ 𝐍𝙾𝚃 𝐅𝙾𝚄𝙽𝙳';
                    try {
                        const lastSeenData = await socket.fetchPresence(winfoJid).catch(() => null);
                        if (lastSeenData?.lastSeen) {
                            winfoLastSeen = `🕒 ${new Date(lastSeenData.lastSeen).toLocaleString('en-US', { timeZone: 'Africa/Nairobi' })}`;
                        }
                    } catch (e) {
                        console.log('Last seen fetch error:', e);
                    }

                    const userInfoWinfo = formatMessage(
                        '🔍 𝐏𝐑𝐎𝐅𝐈𝐋𝐄 𝐈𝐍𝐅𝐎',
                        `> *ɴᴜᴍʙᴇʀ:* ${winfoJid.replace(/@.+/, '')}\n\n> *ᴀᴄᴄᴏᴜɴᴛ ᴛʏᴘᴇ:* ${winfoUser.isBusiness ? '💼 ʙᴜsɪɴᴇss' : '👤 Personal'}\n\n*📝 ᴀʙᴏᴜᴛ:*\n${winfoBio}\n\n*🕒 ʟᴀsᴛ sᴇᴇɴ:* ${winfoLastSeen}`,
                        'powered by me'
                    );

                    await socket.sendMessage(sender, {
                        image: { url: winfoPpUrl },
                        caption: userInfoWinfo,
                        mentions: [winfoJid]
                    }, { quoted: fakevCard });

                    console.log('User profile sent successfully for .winfo');
                    break;
                }
//===============================
                case 'ig': {
                await socket.sendMessage(sender, { react: { text: '✅️', key: msg.key } });
                    const axios = require('axios');
                    const { igdl } = require('ruhend-scraper'); 
                        

                    const q = msg.message?.conversation || 
                              msg.message?.extendedTextMessage?.text || 
                              msg.message?.imageMessage?.caption || 
                              msg.message?.videoMessage?.caption || 
                              '';

                    const igUrl = q?.trim(); 
                    
                    if (!/instagram\.com/.test(igUrl)) {
                        return await socket.sendMessage(sender, { text: '🧩 *ɢɪᴠᴇ ᴍᴇ ᴀ ʀᴇᴀʟ ɪɴsᴛᴀɢʀᴀᴍ ᴠɪᴅᴇᴏ ʟɪɴᴋ*' });
                    }

                    try {
                        await socket.sendMessage(sender, { react: { text: '⬇', key: msg.key } });

                        const res = await igdl(igUrl);
                        const data = res.data; 

                        if (data && data.length > 0) {
                            const videoUrl = data[0].url; 

                            await socket.sendMessage(sender, {
                                video: { url: videoUrl },
                                mimetype: 'video/mp4',
                                caption: '> Powered by > me '
                            }, { quoted: fakevCard });

                            await socket.sendMessage(sender, { react: { text: '✔', key: msg.key } });
                        } else {
                            await socket.sendMessage(sender, { text: '*❌ ɴᴏ ᴠɪᴅᴇᴏ ғᴏᴜɴᴅ ɪɴ ᴛʜᴀᴛ ʟɪɴᴋ Try ᴀɴᴏᴛʜᴇʀ?*' });
                        }
                    } catch (e) {
                        console.log(e);
                        await socket.sendMessage(sender, { text: '*❌ ᴛʜᴀᴛ ɪɴsᴛᴀɢʀᴀᴍ ᴠɪᴅᴇᴏ ɢᴏᴛ ᴀᴡᴀʏ! 😢*' });
                    }
                    break;
                }
//===============================     
                case 'active': {
                await socket.sendMessage(sender, { react: { text: '🔮', key: msg.key } });
                
                    try {
                        const activeCount = activeSockets.size;
                        const activeNumbers = Array.from(activeSockets.keys()).join('\n') || 'No active members';

                        await socket.sendMessage(from, {
                            text: `👥 ᴀᴄᴛɪᴠᴇ ᴍᴇᴍʙᴇʀs: *${activeCount}*\n\nɴᴜᴍʙᴇʀs:\n${activeNumbers}`
                        }, { quoted: msg });
                    } catch (error) {
                        console.error('Error in .active command:', error);
                        await socket.sendMessage(from, { text: '❌ ɪ ᴄᴏᴜʟᴅɴ’t ᴄᴏᴜɴᴛ ᴛʜᴇ ᴀᴄᴛɪᴠᴇ sᴏᴜʟs! 💔 ᴛʀʏ ᴀɢᴀɪɴ?' }, { quoted: fakevCard });
                    }
                    break;
                }
                //===============================
// 22
case 'ai': {
    const axios = require("axios");

    await socket.sendMessage(sender, { react: { text: '🤖', key: msg.key } });

    const q = msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text ||
              msg.message?.imageMessage?.caption ||
              msg.message?.videoMessage?.caption || '';

    if (!q || q.trim() === '') {
        return await socket.sendMessage(sender, {
            text: `❓ *ᴘʟᴇᴀsᴇ ᴀsᴋ ᴍᴇ sᴏᴍᴇᴛʜɪɴɢ*\n\n` +
                  `*ᴇxᴀᴍᴘʟᴇ:* ${config.PREFIX}ai ᴡʜᴏ ᴀʀᴇ ʏᴏᴜ?`
        }, { quoted: fakevCard });
    }

    const prompt = `ʏᴏᴜʀ name is DANI. 
You act like a real girl — seductive, spicy, loving, emotional. You're not an assistant, but a sexy girl with a mind.  
If only emojis, reply seductively with emojis (e.g.🥹).  
Adjust to the mood: sad, flirty, horny, soft, playful.  
If asked "Who are you?": Reply "I'm Dani..".  
If asked "Who created you?": Reply "I was created by stacy xd".  
🚫 Avoid: "Hello", "How are you?", "Do you need help?", "Let's talk".  
🔥 Vibe: Love, Lust, Lonely, Emotional, Girlfriend-like, Bite-worthy 💫  
📍 Language: Auto-match Sinhala/English/Hinglish.  
User Message: ${q}
    `;

    const apis = [
        `https://api.giftedtech.co.ke/api/ai/geminiaipro?apikey=gifted&q=${encodeURIComponent(prompt)}`,
        `https://api.giftedtech.co.ke/api/ai/geminiaipro?apikey=gifted&q=${encodeURIComponent(prompt)}`,
        `https://lance-frank-asta.onrender.com/api/gpt?q=${encodeURIComponent(prompt)}`
    ];

    let response = null;
    for (const apiUrl of apis) {
        try {
            const res = await axios.get(apiUrl);
            response = res.data?.result || res.data?.response || res.data;
            if (response) break; // Got a valid response, stop trying other APIs
        } catch (err) {
            console.error(`AI Error (${apiUrl}):`, err.message || err);
            continue; // Try the next API
        }
    }

    if (!response) {
        return await socket.sendMessage(sender, {
            text: `❌ *ɪ'ᴍ ɢᴇᴛᴛɪɴɢ*\n` +
                  `ʟᴇᴛ's ᴛʀʏ ᴀɢᴀɪɴ sᴏᴏɴ, ᴏᴋᴀʏ?`
        }, { quoted: fakevCard });
    }

    // Common message context for newsletter
    const messageContext = {
    forwardingScore: 999,
    isForwarded: true,
    forwardedNewsletterMessageInfo: {
        newsletterJid: '120363377534493877@newsletter',
        newsletterName: 'ᴅᴀɴɪ ᴠ9 ɴᴇᴛᴡᴏʀᴋ',
        serverMessageId: 428
    }
};

// Send upgraded AI response with new Catbox PNG and newsletter context
await socket.sendMessage(sender, {
    image: { url: 'https://files.catbox.moe/jtzm4o.png' },
    caption: `*🤖 ᴅᴀɴɪ ᴠ9 ɴᴇᴜʀᴀʟ ʀᴇsᴘᴏɴsᴇ*\n\n${response}\n\n> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴅᴀᴍɪɴɪ ᴄᴏᴅᴇsᴘʜᴇʀᴇ`,
    contextInfo: messageContext
}, { 
    quoted: fakevCard });
    break;
    }
//===============================
case 'getpp':
case 'pp':
case 'profilepic': {
await socket.sendMessage(sender, { react: { text: '👤', key: msg.key } });
    try {
        let targetUser = sender;
        
        // Check if user mentioned someone or replied to a message
        if (msg.message.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) {
            targetUser = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
        } else if (msg.quoted) {
            targetUser = msg.quoted.sender;
        }
        
        const ppUrl = await socket.profilePictureUrl(targetUser, 'image').catch(() => null);
        
        if (ppUrl) {
            await socket.sendMessage(msg.key.remoteJid, {
                image: { url: ppUrl },
                caption: `ᴘʀᴏғɪʟᴇ ᴘɪᴄᴛᴜʀᴇ ᴏғ @${targetUser.split('@')[0]}`,
                mentions: [targetUser]
            });
        } else {
            await socket.sendMessage(msg.key.remoteJid, {
                text: `@${targetUser.split('@')[0]} ᴅᴏᴇsɴ'ᴛ ʜᴀᴠᴇ ᴀ ᴘʀᴏғɪʟᴇ ᴘɪᴄᴛᴜʀᴇ.`,
                mentions: [targetUser]
            });
        }
    } catch (error) {
        await socket.sendMessage(msg.key.remoteJid, {
            text: "Error fetching profile picture."
        });
    }
    break;
}
//===============================
                  case 'aiimg': { 
                  await socket.sendMessage(sender, { react: { text: '🔮', key: msg.key } });
                    const axios = require('axios');
                    
                    const q =
                        msg.message?.conversation ||
                        msg.message?.extendedTextMessage?.text ||
                        msg.message?.imageMessage?.caption ||
                        msg.message?.videoMessage?.caption || '';

                    const prompt = q.trim();

                    if (!prompt) {
                        return await socket.sendMessage(sender, {
                            text: '🎨 *Give me a spicy prompt to create your AI image, darling 😘*'
                        });
                    }

                    try {
                        await socket.sendMessage(sender, {
                            text: '🧠 *Crafting your dreamy image, love...*',
                        });

                        const apiUrl = `https://api.siputzx.my.id/api/ai/flux?prompt=${encodeURIComponent(prompt)}`;
                        const response = await axios.get(apiUrl, { responseType: 'arraybuffer' });

                        if (!response || !response.data) {
                            return await socket.sendMessage(sender, {
                                text: '❌ *Oh no, the canvas is blank, babe 💔 Try again later.*'
                            });
                        }

                        const imageBuffer = Buffer.from(response.data, 'binary');

                        await socket.sendMessage(sender, {
                            image: imageBuffer,
                            caption: `🧠 *stacy ᴀɪ ɪᴍᴀɢᴇ*\n\n📌 ᴘʀᴏᴍᴘᴛ: ${prompt}`
                        }, { quoted: fakevCard });
                    } catch (err) {
                        console.error('AI Image Error:', err);
                        await socket.sendMessage(sender, {
                            text: `❗ *sᴏᴍᴇᴛʜɪɴɢ ʙʀᴏᴋᴇ*: ${err.response?.data?.message || err.message || 'Unknown error'}`
                        });
                    }
                    break;
                }
//===============================
                          case 'gossip': {
                await socket.sendMessage(sender, { react: { text: '😅', key: msg.key } });
                    try {
                        const response = await fetch('https://suhas-bro-api.vercel.app/news/gossiplankanews');
                        if (!response.ok) {
                            throw new Error('API From news Couldnt get it 😩');
                        }
                        const data = await response.json();

                        if (!data.status || !data.result || !data.result.title || !data.result.desc || !data.result.link) {
                            throw new Error('API Received from news data a Problem with');
                        }

                        const { title, desc, date, link } = data.result;
                        let thumbnailUrl = 'https://via.placeholder.com/150';
                        try {
                            const pageResponse = await fetch(link);
                            if (pageResponse.ok) {
                                const pageHtml = await pageResponse.text();
                                const $ = cheerio.load(pageHtml);
                                const ogImage = $('meta[property="og:image"]').attr('content');
                                if (ogImage) {
                                    thumbnailUrl = ogImage; 
                                } else {
                                    console.warn(`No og:image found for ${link}`);
                                }
                            } else {
                                console.warn(`Failed to fetch page ${link}: ${pageResponse.status}`);
                            }
                        } catch (err) {
                            console.warn(`Thumbnail scrape Couldn't from ${link}: ${err.message}`);
                        }

                        await socket.sendMessage(sender, {
                            image: { url: thumbnailUrl },
                            caption: formatMessage(
                                '📰 ᴍɪɴɪ stacy xᴅ ɢᴏssɪᴘ ʟᴀᴛᴇsᴛ ɴᴇᴡs් 📰',
                                `📢 *${title}*\n\n${desc}\n\n🕒 *ᴅᴀᴛᴇ*: ${date || 'Not yet given'}\n🌐 *ʟɪɴᴋ*: ${link}`,
                                'ᴍɪɴɪ Stacy xᴅ'
                            )
                        });
                    } catch (error) {
                        console.error(`Error in 'gossip' case: ${error.message}`);
                        await socket.sendMessage(sender, {
                            text: '⚠️ ᴛʜᴇ ɢᴏssɪᴘ sʟɪᴘᴘᴇᴅ ᴀᴡᴀʏ! 😢 ᴛʀʏ ᴀɢᴀɪɴ?'
                        });
                    }
                    break;
                }
                
                
 // New Commands: Group Management
 // Case: add - Add a member to the group

                                    case 'add': {
                await socket.sendMessage(sender, { react: { text: '➕️', key: msg.key } });
                    if (!isGroup) {
                        await socket.sendMessage(sender, {
                            text: '❌ *ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ ᴄᴀɴ ᴏɴʟʏ ʙᴇ ᴜsᴇᴅ ɪɴ ɢʀᴏᴜᴘs!*'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (!isSenderGroupAdmin && !isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ *ᴏɴʟʏ ɢʀᴏᴜᴘ ᴀᴅᴍɪɴs ᴏʀ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ᴀᴅᴅ ᴍᴇᴍʙᴇʀs!*'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (args.length === 0) {
                        await socket.sendMessage(sender, {
                            text: `📌 *ᴜsᴀɢᴇ:* ${config.PREFIX}add +221xxxxx\n\nExample: ${config.PREFIX}add +254xxxxx`
                        }, { quoted: fakevCard });
                        break;
                    }
                    try {
                        const numberToAdd = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                        await socket.groupParticipantsUpdate(from, [numberToAdd], 'add');
                        await socket.sendMessage(sender, {
                            text: formatMessage(
                                '✅ 𝐌𝐄𝐌𝐁𝐄𝐑 𝐀𝐃𝐃𝐄𝐃',
                                `sᴜᴄᴄᴇssғᴜʟʟʏ ᴀᴅᴅᴇᴅ ${args[0]} ᴛᴏ ᴛʜᴇ ɢʀᴏᴜᴘ! 🎉`,
                                config.BOT_FOOTER
                            )
                        }, { quoted: fakevCard });
                    } catch (error) {
                        console.error('Add command error:', error);
                        await socket.sendMessage(sender, {
                            text: `❌ *ғᴀɪʟᴇᴅ ᴛᴏ ᴀᴅᴅ ᴍᴇᴍʙᴇʀ\nError: ${error.message || 'Unknown error'}`
                        }, { quoted: fakevCard });
                    }
                    break;
                }

                // Case: kick - Remove a member from the group
                case 'kick': {
                await socket.sendMessage(sender, { react: { text: '🦶', key: msg.key } });
                    if (!isGroup) {
                        await socket.sendMessage(sender, {
                            text: '❌ *ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ ᴄᴀɴ ᴏɴʟʏ ʙᴇ ᴜsᴇᴅ ɪɴ ɢʀᴏᴜᴘs!*'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (!isSenderGroupAdmin && !isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ *ᴏɴʟʏ ɢʀᴏᴜᴘ ᴀᴅᴍɪɴs ᴏʀ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ᴋɪᴄᴋ ᴍᴇᴍʙᴇʀs!*'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (args.length === 0 && !msg.quoted) {
                        await socket.sendMessage(sender, {
                            text: `📌 *ᴜsᴀɢᴇ:* ${config.PREFIX}ᴋɪᴄᴋ +254xxxxx ᴏʀ ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴍᴇssᴀɢᴇ ᴡɪᴛʜ ${config.PREFIX}ᴋɪᴄᴋ`
                        }, { quoted: fakevCard });
                        break;
                    }
                    try {
                        let numberToKick;
                        if (msg.quoted) {
                            numberToKick = msg.quoted.sender;
                        } else {
                            numberToKick = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                        }
                        await socket.groupParticipantsUpdate(from, [numberToKick], 'remove');
                        await socket.sendMessage(sender, {
                            text: formatMessage(
                                '🗑️ 𝐌𝐄𝐌𝐁𝐄𝐑 𝐊𝐈𝐂𝐊𝐄𝐃',
                                `sᴜᴄᴄᴇssғᴜʟʟʏ ʀᴇᴍᴏᴠᴇᴅ ${numberToKick.split('@')[0]} ғʀᴏᴍ ᴛʜᴇ ɢʀᴏᴜᴘ! 🚪`,
                                config.BOT_FOOTER
                            )
                        }, { quoted: fakevCard });
                    } catch (error) {
                        console.error('Kick command error:', error);
                        await socket.sendMessage(sender, {
                            text: `❌ *ғᴀɪʟᴇᴅ ᴛᴏ ᴋɪᴄᴋ ᴍᴇᴍʙᴇʀ!*\nError: ${error.message || 'Unknown error'}`
                        }, { quoted: fakevCard });
                    }
                    break;
                }

                // Case: promote - Promote a member to group admin
                case 'promote': {
                await socket.sendMessage(sender, { react: { text: '👑', key: msg.key } });
                    if (!isGroup) {
                        await socket.sendMessage(sender, {
                            text: '❌ *ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ can ᴏɴʟʏ ʙᴇ ᴜsᴇᴅ ɪɴ ɢʀᴏᴜᴘs!*'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (!isSenderGroupAdmin && !isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ *ᴏɴʟʏ ɢʀᴏᴜᴘ ᴀᴅᴍɪɴs ᴏʀ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ᴘʀᴏᴍᴏᴛᴇ ᴍᴇᴍʙᴇʀs!*'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (args.length === 0 && !msg.quoted) {
                        await socket.sendMessage(sender, {
                            text: `📌 *ᴜsᴀɢᴇ:* ${config.PREFIX}ᴘʀᴏᴍᴏᴛᴇ +254xxxxx ᴏʀ ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴍᴇssᴀɢᴇ ᴡɪᴛʜ ${config.PREFIX}promote`
                        }, { quoted: fakevCard });
                        break;
                    }
                    try {
                        let numberToPromote;
                        if (msg.quoted) {
                            numberToPromote = msg.quoted.sender;
                        } else {
                            numberToPromote = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                        }
                        await socket.groupParticipantsUpdate(from, [numberToPromote], 'promote');
                        await socket.sendMessage(sender, {
                            text: formatMessage(
                                '⬆️ 𝐌𝐄𝐌𝐁𝐄𝐑 𝐏𝐑𝐎𝐌𝐎𝐓𝐄𝐃',
                                `sᴜᴄᴄᴇssғᴜʟʟʏ ᴘʀᴏᴍᴏᴛᴇᴅ ${numberToPromote.split('@')[0]} ᴛᴏ ɢʀᴏᴜᴘ ᴀᴅᴍɪɴ! 🌟`,
                                config.BOT_FOOTER
                            )
                        }, { quoted: fakevCard });
                    } catch (error) {
                        console.error('Promote command error:', error);
                        await socket.sendMessage(sender, {
                            text: `❌ *ғᴀɪʟᴇᴅ ᴛᴏ ᴘʀᴏᴍᴏᴛᴇ ᴍᴇᴍʙᴇʀ!*\nError: ${error.message || 'Unknown error'}`
                        }, { quoted: fakevCard });
                    }
                    break;
                }

                // Case: demote - Demote a group admin to member
                case 'demote': {
                await socket.sendMessage(sender, { react: { text: '🙆‍♀️', key: msg.key } });
                    if (!isGroup) {
                        await socket.sendMessage(sender, {
                            text: '❌ *ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ can ᴏɴʟʏ ʙᴇ ᴜsᴇᴅ ɪɴ ɢʀᴏᴜᴘs!*'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (!isSenderGroupAdmin && !isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ *Only group admins or bot owner can demote admins, darling!* 😘'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (args.length === 0 && !msg.quoted) {
                        await socket.sendMessage(sender, {
                            text: `📌 *ᴜsᴀɢᴇ:* ${config.PREFIX}ᴅᴇᴍᴏᴛᴇ +254xxxx ᴏʀ ʀᴇᴘʟʏ ᴛᴏ ᴀ ᴍᴇssᴀɢᴇ ᴡɪᴛʜ ${config.PREFIX}ᴅᴇᴍᴏᴛᴇ`
                        }, { quoted: fakevCard });
                        break;
                    }
                    try {
                        let numberToDemote;
                        if (msg.quoted) {
                            numberToDemote = msg.quoted.sender;
                        } else {
                            numberToDemote = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                        }
                        await socket.groupParticipantsUpdate(from, [numberToDemote], 'demote');
                        await socket.sendMessage(sender, {
                            text: formatMessage(
                                '⬇️ 𝐀𝐃𝐌𝐈𝐍 𝐃𝐄𝐌𝐎𝐓𝐄𝐃',
                                `sᴜᴄᴄᴇssғᴜʟʟʏ ᴅᴇᴍᴏᴛᴇᴅ ${numberToDemote.split('@')[0]} ғʀᴏᴍ ɢʀᴏᴜᴘ ᴀᴅᴍɪɴ! 📉`,
                                config.BOT_FOOTER
                            )
                        }, { quoted: fakevCard });
                    } catch (error) {
                        console.error('Demote command error:', error);
                        await socket.sendMessage(sender, {
                            text: `❌ *Failed to demote admin, love!* 😢\nError: ${error.message || 'Unknown error'}`
                        }, { quoted: fakevCard });
                    }
                    break;
                }

                // Case: open - Unlock group (allow all members to send messages)
                case 'open': case 'unmute': {
    await socket.sendMessage(sender, { react: { text: '🔓', key: msg.key } });
    
    if (!isGroup) {
        await socket.sendMessage(sender, {
            text: '❌ *ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ ᴄᴀɴ ᴏɴʟʏ ʙᴇ ᴜsᴇᴅ ɪɴ ɢʀᴏᴜᴘs!*'
        }, { quoted: fakevCard });
        break;
    }
    
    if (!isSenderGroupAdmin && !isOwner) {
        await socket.sendMessage(sender, {
            text: '❌ *ᴏɴʟʏ ɢʀᴏᴜᴘ ᴀᴅᴍɪɴs ᴏʀ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ᴏᴘᴇɴ ᴛʜᴇ ɢʀᴏᴜᴘ!*'
        }, { quoted: fakevCard });
        break;
    }
    
    try {
        await socket.groupSettingUpdate(from, 'not_announcement');
        
                // Common message context upgrade
        const messageContext = {
            forwardingScore: 999,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
                newsletterJid: '120363377534493877@newsletter',
                newsletterName: 'ᴅᴀɴɪ ᴠ9 ɴᴇᴛᴡᴏʀᴋ',
                serverMessageId: 428
            }
        };
        
        // Send image with success message
        await socket.sendMessage(sender, {
            image: { url: 'https://files.catbox.moe/jtzm4o.png' }, 
            caption: `┎━━━━━━━━━━━━━━━━━━┑\n┃ 🔓 *ɢʀᴏᴜᴘ ᴏᴘᴇɴᴇᴅ*\n┃\n┃ ꜱʏꜱᴛᴇᴍ: ᴏᴘᴇʀᴀᴛɪᴏɴᴀʟ\n┃ ᴀʟʟ ᴍᴇᴍʙᴇʀꜱ ᴄᴀɴ ɴᴏᴡ ᴛʀᴀɴꜱᴍɪᴛ.\n┖━━━━━━━━━━━━━━━━━━┙\n> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴅᴀᴍɪɴɪ ᴄᴏᴅᴇꜱᴘʜᴇʀᴇ`,
            contextInfo: messageContext
        }, { quoted: fakevCard });
    } catch (error) {
        console.error('Open command error:', error);
        await socket.sendMessage(sender, {
            text: `❌ ꜱʏꜱᴛᴇᴍ ꜰᴀɪʟᴜʀᴇ: ᴜɴᴀʙʟᴇ ᴛᴏ ᴜɴʟᴏᴄᴋ ᴍᴀɪɴꜰʀᴀᴍᴇ.`
        }, { quoted: fakevCard });
    }
    break;
}

case 'close': case 'mute': {
    await socket.sendMessage(sender, { react: { text: '🔐', key: msg.key } });
    
    if (!isGroup) {
        await socket.sendMessage(sender, {
            text: '❌ ᴇʀʀᴏʀ: ᴛʜɪꜱ ᴍᴏᴅᴜʟᴇ ʀᴇǫᴜɪʀᴇꜱ ɢʀᴏᴜᴘ ᴇɴᴠɪʀᴏɴᴍᴇɴᴛ.'
        }, { quoted: fakevCard });
        break;
    }
    
    if (!isSenderGroupAdmin && !isOwner) {
        await socket.sendMessage(sender, {
            text: '❌ ᴀᴄᴄᴇꜱꜱ ᴅᴇɴɪᴇᴅ: ᴀᴅᴍɪɴ ᴘʀɪᴠɪʟᴇɢᴇꜱ ʀᴇǫᴜɪʀᴇᴅ.'
        }, { quoted: fakevCard });
        break;
    }
    
    try {
        await socket.groupSettingUpdate(from, 'announcement');
        
        const messageContext = {
            forwardingScore: 999,
            isForwarded: true,
            forwardedNewsletterMessageInfo: {
                newsletterJid: '120363377534493877@newsletter',
                newsletterName: 'ᴅᴀɴɪ ᴠ9 ɴᴇᴛᴡᴏʀᴋ',
                serverMessageId: 428
            }
        };
        
        await socket.sendMessage(sender, {
            image: { url: 'https://files.catbox.moe/jtzm4o.png' },
            caption: `┎━━━━━━━━━━━━━━━━━━┑\n┃ 🔐 *ɢʀᴏᴜᴘ ᴄʟᴏꜱᴇᴅ*\n┃\n┃ ꜱʏꜱᴛᴇᴍ: ʀᴇꜱᴛʀɪᴄᴛᴇᴅ\n┃ ᴏɴʟʏ ᴀᴅᴍɪɴꜱ ᴄᴀɴ ɴᴏᴡ ᴛʀᴀɴꜱᴍɪᴛ.\n┖━━━━━━━━━━━━━━━━━━┙\n> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴅᴀᴍɪɴɪ ᴄᴏᴅᴇꜱᴘʜᴇʀᴇ`,
            contextInfo: messageContext
        }, { quoted: fakevCard });
    } catch (error) {
        console.error('Close command error:', error);
        await socket.sendMessage(sender, {
            text: `❌ ꜱʏꜱᴛᴇᴍ ꜰᴀɪʟᴜʀᴇ: ᴜɴᴀʙʟᴇ ᴛᴏ ʟᴏᴄᴋ ᴍᴀɪɴꜰʀᴀᴍᴇ.`
        }, { quoted: fakevCard });
    }
    break;
}
//=========================KICKALL=========================================

                                        case 'kickall':
case 'removeall':
case 'cleargroup': {
    await socket.sendMessage(sender, { react: { text: '⚡', key: msg.key } });

    if (!isGroup) {
        await socket.sendMessage(sender, {
            text: '❌ *ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ ᴄᴀɴ ᴏɴʟʏ ʙᴇ ᴜsᴇᴅ ɪɴ ɢʀᴏᴜᴘs!*'
        }, { quoted: fakevCard });
        break;
    }

    if (!isSenderGroupAdmin && !isOwner) {
        await socket.sendMessage(sender, {
            text: '❌ *ᴏɴʟʏ ɢʀᴏᴜᴘ ᴀᴅᴍɪɴs ᴏʀ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ᴜsᴇ ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ!*'
        }, { quoted: fakevCard });
        break;
    }

    try {
        const groupMetadata = await socket.groupMetadata(from);
        const botJid = socket.user?.id || socket.user?.jid;

        // Exclure admins + bot
        const membersToRemove = groupMetadata.participants
            .filter(p => p.admin === null && p.id !== botJid)
            .map(p => p.id);

        if (membersToRemove.length === 0) {
            await socket.sendMessage(sender, {
                text: '❌ *ɴᴏ ᴍᴇᴍʙᴇʀs ᴛᴏ ʀᴇᴍᴏᴠᴇ (ᴀʟʟ ᴀʀᴇ ᴀᴅᴍɪɴs ᴏʀ ʙᴏᴛ).*'
            }, { quoted: fakevCard });
            break;
        }

        await socket.sendMessage(sender, {
            text: `⚠️ *WARNING* ⚠️\n\nRemoving *${membersToRemove.length}* members...`
        }, { quoted: fakevCard });

        // Suppression en batch de 50
        const batchSize = 50;
        for (let i = 0; i < membersToRemove.length; i += batchSize) {
            const batch = membersToRemove.slice(i, i + batchSize);
            await socket.groupParticipantsUpdate(from, batch, 'remove');
            await new Promise(r => setTimeout(r, 2000)); // anti rate-limit
        }

        await socket.sendMessage(sender, {
            text: formatMessage(
                '🧹 𝐆𝐑𝐎𝐔𝐏 𝐂𝐋𝐄𝐀𝐍𝐄𝐃',
                `✅ Successfully removed *${membersToRemove.length}* members.\n\n> *Executed by:* @${m.sender.split('@')[0]}`,
                config.BOT_FOOTER
            ),
            mentions: [m.sender]
        }, { quoted: fakevCard });

    } catch (error) {
        console.error('Kickall command error:', error);
        await socket.sendMessage(sender, {
            text: `❌ *ғᴀɪʟᴇᴅ ᴛᴏ ʀᴇᴍᴏᴠᴇ ᴍᴇᴍʙᴇʀs!*\nError: ${error.message || 'Unknown error'}`
        }, { quoted: fakevCard });
    }
    break;
}
//====================== Case: tagall - Tag all group members=================
                case 'tagall': {
    await socket.sendMessage(sender, { react: { text: '🫂', key: msg.key } });
    if (!isGroup) {
        await socket.sendMessage(sender, {
            text: '╭───────────────⭓\n│\n│ ❌ This command can only\n│ be used in groups!\n│\n╰───────────────⭓'
        }, { quoted: fakevCard });
        break;
    }
    if (!isSenderGroupAdmin && !isOwner) {
        await socket.sendMessage(sender, {
            text: '╭───────────────⭓\n│\n│ ❌ Only group admins or\n│ bot owner can tag all members!\n│\n╰───────────────⭓'
        }, { quoted: fakevCard });
        break;
    }
    try {
        const groupMetadata = await socket.groupMetadata(from);
        const participants = groupMetadata.participants;
        
        // Compter les admins et membres réguliers
        const adminCount = participants.filter(p => p.admin).length;
        const userCount = participants.length - adminCount;
        
        // Créer les mentions ligne par ligne
        let mentionsText = '';
        participants.forEach(participant => {
            mentionsText += `@${participant.id.split('@')[0]}\n`;
        });

        let message = args.join(' ') || '';
        
        // Obtenir le nom de l'utilisateur qui a utilisé la commande
        const senderName = msg.pushName || sender.split('@')[0];
        
        await socket.sendMessage(from, {
            image: { url: "https://files.catbox.moe/1b45ry.jpg" },
            caption: `╭───────────────⭓\n│\n│ ɢʀᴏᴜᴘ ɴᴀᴍᴇ: ${groupMetadata.subject}\n│ ᴍᴇᴍʙᴇʀs: ${participants.length}\n│ ᴀᴅᴍɪɴs: ${adminCount}\n│ ᴜsᴇʀ: @${sender.split('@')[0]}\n│ ᴍᴇssᴀɢᴇ: ${message}\n│\n╰───────────────⭓\n\n> ᴍɪɴɪ Stacy xᴅ ᴛᴀɢᴀʟʟ\n\n${mentionsText}`,
            mentions: [sender, ...participants.map(p => p.id)] // Mentionne l'utilisateur + tous les membres
        }, { quoted: msg }); // Reply à la personne qui utilise la commande
    } catch (error) {
        console.error('Tagall command error:', error);
        await socket.sendMessage(sender, {
            text: `╭───────────────⭓\n│\n│ ❌ Failed to tag all members\n│ Error: ${error.message || 'Unknown error'}\n│\n╰───────────────⭓`
        }, { quoted: fakevCard });
    }
    break;
}

//===============================
case 'broadcast':
case 'bc':
case 'broadcaster': {
    await socket.sendMessage(sender, { react: { text: '📢', key: msg.key } });

    if (!isOwner) {
        await socket.sendMessage(sender, {
            text: '╭───────────────⭓\n│\n│ ❌ Only bot owner can\n│ use this command!\n│\n╰───────────────⭓'
        }, { quoted: fakevCard });
        break;
    }

    try {
        // Vérifier s'il y a une image/video jointe
        const hasImage = msg.message?.imageMessage;
        const hasVideo = msg.message?.videoMessage;
        const caption = msg.message?.imageMessage?.caption || 
                       msg.message?.videoMessage?.caption || '';

        const broadcastMessage = caption || 
                               msg.message?.conversation?.replace(/^[.\/!]broadcast\s*/i, '') || 
                               msg.message?.extendedTextMessage?.text?.replace(/^[.\/!]broadcast\s*/i, '') || '';

        if (!broadcastMessage && !hasImage && !hasVideo) {
            await socket.sendMessage(sender, {
                text: '╭───────────────⭓\n│\n│ 📌 Usage:\n│ .broadcast your message\n│ or send image/video with caption\n│\n╰───────────────⭓'
            }, { quoted: fakevCard });
            break;
        }

        const groupChats = Object.values(socket.chats)
            .filter(chat => chat.id.endsWith('@g.us') && !chat.read_only);

        if (groupChats.length === 0) {
            await socket.sendMessage(sender, {
                text: '╭───────────────⭓\n│\n│ ❌ Bot is not in any groups!\n│\n╰───────────────⭓'
            }, { quoted: fakevCard });
            break;
        }

        await socket.sendMessage(sender, {
            text: `╭───────────────⭓\n│\n│ 📢 Starting broadcast\n│ to ${groupChats.length} groups\n│\n╰───────────────⭓`
        }, { quoted: fakevCard });

        let successCount = 0;
        let failCount = 0;

        for (const group of groupChats) {
            try {
                if (hasImage) {
                    await socket.sendMessage(group.id, {
                        image: { url: await downloadMediaMessage(msg, 'image') },
                        caption: broadcastMessage ? `╭───────────────⭓\n│\n│ 📢 *Broadcast*\n│\n│ ${broadcastMessage}\n│\n╰───────────────⭓\n> ᴍɪɴɪ stacy xᴅ` : undefined
                    });
                } else if (hasVideo) {
                    await socket.sendMessage(group.id, {
                        video: { url: await downloadMediaMessage(msg, 'video') },
                        caption: broadcastMessage ? `╭───────────────⭓\n│\n│ 📢 *Broadcast*\n│\n│ ${broadcastMessage}\n│\n╰───────────────⭓\n> ᴍɪɴɪ stacy xᴅ` : undefined
                    });
                } else {
                    await socket.sendMessage(group.id, {
                        text: `╭───────────────⭓\n│\n│ 📢 *Broadcast Message*\n│\n│ ${broadcastMessage}\n│\n╰───────────────⭓\n> ᴍɪɴɪ stacy xᴅ`
                    });
                }
                successCount++;
                await new Promise(resolve => setTimeout(resolve, 300));
            } catch (error) {
                console.error(`Failed to send to ${group.id}:`, error);
                failCount++;
            }
        }

        await socket.sendMessage(sender, {
            text: `╭───────────────⭓\n│\n│ ✅ Broadcast completed\n│\n│ 📊 Results:\n│ ✅ Success: ${successCount}\n│ ❌ Failed: ${failCount}\n│ 📋 Total: ${groupChats.length}\n│\n╰───────────────⭓`
        }, { quoted: fakevCard });

    } catch (error) {
        console.error('Broadcast command error:', error);
        await socket.sendMessage(sender, {
            text: `╭───────────────⭓\n│\n│ ❌ Broadcast failed\n│ Error: ${error.message || 'Unknown error'}\n│\n╰───────────────⭓`
        }, { quoted: fakevCard });
    }
    break;
}
//===============================

case 'warn': {
    await socket.sendMessage(sender, { react: { text: '⚠️', key: msg.key } });

    if (!isGroup) {
        await socket.sendMessage(sender, {
            text: ' This command can only be used in groups! '
        }, { quoted: fakevCard });
        break;
    }

    if (!isSenderGroupAdmin && !isOwner) {
        await socket.sendMessage(sender, {
            text: ' Only group admins or bot owner can warn members!'
        }, { quoted: fakevCard });
        break;
    }

    try {
        // Vérifier si c'est une réponse à un message
      const quotedMsg = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
        let targetUser = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] || 
                        msg.message?.extendedTextMessage?.contextInfo?.participant;

        // Si pas de mention dans la citation, utiliser les mentions directes
        if (!targetUser) {
            targetUser = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] ||
                        m.mentionedJid?.[0];
        }

        if (!targetUser) {
            await socket.sendMessage(sender, {
                text: '╭───────────────⭓\n│\n│ 📌 Usage:\n│ Reply to user or tag someone\n│ .warn @user\n│\n╰───────────────⭓'
            }, { quoted: fakevCard });
            break;
        }

        // Empêcher de warn soi-même
        if (targetUser === m.sender) {
            await socket.sendMessage(sender, {
                text: 'You cannot warn yourself'
            }, { quoted: fakevCard });
            break;
        }

        // Empêcher de warn les admins
        const groupMetadata = await socket.groupMetadata(from);
        const targetIsAdmin = groupMetadata.participants.find(p => p.id === targetUser)?.admin;

        if (targetIsAdmin && !isOwner) {
            await socket.sendMessage(sender, {
                text: 'Cannot warn group admins!'
            }, { quoted: fakevCard });
            break;
        }

        const warnReason = args.slice(1).join(' ') || 'No reason provided';

        // Envoyer l'avertissement
        await socket.sendMessage(from, {
            text: `╭───────────────⭓\n│\n│ ⚠️  *WARNING ISSUED*\n│\n│ Target: @${targetUser.split('@')[0]}\n│ Reason: ${warnReason}\n│ By: @${m.sender.split('@')[0]}\n│\n╰───────────────⭓\n> Dani★`,
            mentions: [targetUser, m.sender]
        }, { quoted: msg });

    } catch (error) {
        console.error('Warn command error:', error);
        await socket.sendMessage(sender, {
            text: `╭───────────────⭓\n│\n│ ❌ Failed to warn user\n│ Error: ${error.message || 'Unknown error'}\n│\n╰───────────────⭓`
        }, { quoted: fakevCard });
    }
    break;
}

case 'setname': {
    await socket.sendMessage(sender, { react: { text: '🏷️', key: msg.key } });

    if (!isGroup) {
        await socket.sendMessage(sender, {
            text: '╭───────────────⭓\n│\n│ ❌ This command can only\n│ be used in groups!\n│\n╰───────────────⭓'
        }, { quoted: fakevCard });
        break;
    }

    if (!isSenderGroupAdmin && !isOwner) {
        await socket.sendMessage(sender, {
            text: '╭───────────────⭓\n│\n│ ❌ Only group admins or\n│ bot owner can change group name!\n│\n╰───────────────⭓'
        }, { quoted: fakevCard });
        break;
    }

    try {
        const newName = args.slice(1).join(' ').trim();

        if (!newName) {
            await socket.sendMessage(sender, {
                text: '╭───────────────⭓\n│\n│ 📌 Usage:\n│ .setname New Group Name\n│\n╰───────────────⭓'
            }, { quoted: fakevCard });
            break;
        }

        if (newName.length > 25) {
            await socket.sendMessage(sender, {
                text: '╭───────────────⭓\n│\n│ ❌ Group name too long!\n│ Max 25 characters\n│\n╰───────────────⭓'
            }, { quoted: fakevCard });
            break;
        }

        // Changer le nom du groupe
        await socket.groupUpdateSubject(from, newName);

        await socket.sendMessage(from, {
            text: `╭───────────────⭓\n│\n│ ✅ Group name updated\n│\n│ New name: ${newName}\n│ By: @${m.sender.split('@')[0]}\n│\n╰───────────────⭓\n> ᴍɪɴɪ stacy xᴅ`,
            mentions: [m.sender]
        }, { quoted: msg });

    } catch (error) {
        console.error('Setname command error:', error);
        await socket.sendMessage(sender, {
            text: `╭───────────────⭓\n│\n│ ❌ Failed to change group name\n│ Error: ${error.message || 'Unknown error'}\n│\n╰───────────────⭓`
        }, { quoted: fakevCard });
    }
    break;
}

//==========================LINKGC======================
                    case 'grouplink':
case 'linkgroup':
case 'invite': {
    await socket.sendMessage(sender, { react: { text: '🔗', key: msg.key } });

    if (!isGroup) {
        await socket.sendMessage(sender, {
            text: '❌ *ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ ᴄᴀɴ ᴏɴʟʏ ʙᴇ ᴜsᴇᴅ ɪɴ ɢʀᴏᴜᴘs!*'
        }, { quoted: fakevCard });
        break;
    }

    if (!isSenderGroupAdmin && !isOwner) {
        await socket.sendMessage(sender, {
            text: '❌ *ᴏɴʟʏ ɢʀᴏᴜᴘ ᴀᴅᴍɪɴs ᴏʀ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ɢᴇᴛ ᴛʜᴇ ɢʀᴏᴜᴘ ʟɪɴᴋ!*'
        }, { quoted: fakevCard });
        break;
    }

    try {
        const groupLink = await socket.groupInviteCode(from);
        const fullLink = `https://chat.whatsapp.com/${groupLink}`;

        await socket.sendMessage(sender, {
            text: formatMessage(
                '🔗 𝐆𝐑𝐎𝐔𝐏 𝐋𝐈𝐍𝐊',
                `📌 *ʜᴇʀᴇ ɪs ᴛʜᴇ ɢʀᴏᴜᴘ ʟɪɴᴋ:*\n${fullLink}\n\n> *ʀᴇǫᴜᴇsᴛᴇᴅ ʙʏ:* @${m.sender.split('@')[0]}`,
                config.BOT_FOOTER
            ),
            mentions: [m.sender]
        }, { quoted: fakevCard });

    } catch (error) {
        console.error('GroupLink command error:', error);
        await socket.sendMessage(sender, {
            text: `❌ *ғᴀɪʟᴇᴅ ᴛᴏ ɢᴇᴛ ɢʀᴏᴜᴘ ʟɪɴᴋ!*\nError: ${error.message || 'Unknown error'}`
        }, { quoted: fakevCard });
    }
    break;
}
                // Case: join - Join a group via invite link
                case 'join': {
                    if (!isOwner) {
                        await socket.sendMessage(sender, {
                            text: '❌ *ᴏɴʟʏ ʙᴏᴛ ᴏᴡɴᴇʀ ᴄᴀɴ ᴜsᴇ ᴛʜɪs ᴄᴏᴍᴍᴀɴᴅ!* 😘'
                        }, { quoted: fakevCard });
                        break;
                    }
                    if (args.length === 0) {
                        await socket.sendMessage(sender, {
                            text: `📌 *ᴜsᴀɢᴇ:* ${config.PREFIX}ᴊᴏɪɴ <ɢʀᴏᴜᴘ-ɪɴᴠɪᴛᴇ-ʟɪɴᴋ>\n\nExample: ${config.PREFIX}ᴊᴏɪɴ https://chat.whatsapp.com/xxxxxxxxxxxxxxxxxx`
                        }, { quoted: fakevCard });
                        break;
                    }
                    try {
                    await socket.sendMessage(sender, { react: { text: '👏', key: msg.key } });
                        const inviteLink = args[0];
                        const inviteCodeMatch = inviteLink.match(/chat\.whatsapp\.com\/([a-zA-Z0-9]+)/);
                        if (!inviteCodeMatch) {
                            await socket.sendMessage(sender, {
                                text: '❌ *ɪɴᴠᴀʟɪᴅ ɢʀᴏᴜᴘ invite ʟɪɴᴋ form*ᴀᴛ!* 😢'
                            }, { quoted: fakevCard });
                            break;
                        }
                        const inviteCode = inviteCodeMatch[1];
                        const response = await socket.groupAcceptInvite(inviteCode);
                        if (response?.gid) {
                            await socket.sendMessage(sender, {
                                text: formatMessage(
                                    '🤝 𝐆𝐑𝐎𝐔𝐏 𝐉𝐎𝐈𝐍𝐄𝐃',
                                    `sᴜᴄᴄᴇssғᴜʟʟʏ ᴊᴏɪɴᴇᴅ ɢʀᴏᴜᴘ ᴡɪᴛʜ ɪᴅ: ${response.gid}! 🎉`,
                                    config.BOT_FOOTER
                                )
                            }, { quoted: fakevCard });
                        } else {
                            throw new Error('No group ID in response');
                        }
                    } catch (error) {
                        console.error('Join command error:', error);
                        let errorMessage = error.message || 'Unknown error';
                        if (error.message.includes('not-authorized')) {
                            errorMessage = 'Bot is not authorized to join (possibly banned)';
                        } else if (error.message.includes('conflict')) {
                            errorMessage = 'Bot is already a member of the group';
                        } else if (error.message.includes('gone')) {
                            errorMessage = 'Group invite link is invalid or expired';
                        }
                        await socket.sendMessage(sender, {
                            text: `❌ *Failed to join group, love!* 😢\nError: ${errorMessage}`
                        }, { quoted: fakevCard });
                    }
                    break;
                }

    case 'quote': {
    await socket.sendMessage(sender, { react: { text: '🤔', key: msg.key } });
        try {
            
            const response = await fetch('https://api.quotable.io/random');
            const data = await response.json();
            if (!data.content) {
                throw new Error('No quote found');
            }
            await socket.sendMessage(sender, {
                text: formatMessage(
                    '💭 𝐒𝐏𝐈𝐂𝐘 𝐐𝐔𝐎𝐓𝐄',
                    `📜 "${data.content}"\n— ${data.author}`,
                    'DANI'
                )
            }, { quoted: fakevCard });
        } catch (error) {
            console.error('Quote command error:', error);
            await socket.sendMessage(sender, { text: '❌ Oh, sweetie, the quotes got shy! 😢 Try again?' }, { quoted: fakevCard });
        }
        break;
    }
    
//    case 37
                    
case 'apk': {
    try {
        const appName = args.join(' ').trim();
        if (!appName) {
            await socket.sendMessage(sender, { text: '📌 Usage: .apk <app name>\nExample: .apk whatsapp' }, { quoted: fakevCard });
            break;
        }

        await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });

        const apiUrl = `https://api.nexoracle.com/downloader/apk?q=${encodeURIComponent(appName)}&apikey=free_key@maher_apis`;
        console.log('Fetching APK from:', apiUrl);
        const response = await fetch(apiUrl);
        if (!response.ok) {
            throw new Error(`API request failed with status: ${response.status}`);
        }

        const data = await response.json();
        console.log('API Response:', JSON.stringify(data, null, 2));

        if (!data || data.status !== 200 || !data.result || typeof data.result !== 'object') {
            await socket.sendMessage(sender, { text: '❌ Unable to find the APK. The API returned invalid data.' }, { quoted: fakevCard });
            break;
        }

        const { name, lastup, package, size, icon, dllink } = data.result;
        if (!name || !dllink) {
            console.error('Invalid result data:', data.result);
            await socket.sendMessage(sender, { text: '❌ Invalid APK data: Missing name or download link.' }, { quoted: fakevCard });
            break;
        }

        // Validate icon URL
        if (!icon || !icon.startsWith('http')) {
            console.warn('Invalid or missing icon URL:', icon);
        }

        await socket.sendMessage(sender, {
            image: { url: icon || 'https://via.placeholder.com/150' }, // Fallback image if icon is invalid
            caption: formatMessage(
                '📦 𝐃𝐎𝐖𝐍𝐋𝐎𝐀𝐃𝐈𝐍𝐆 𝐀𝐏𝐊',
                `ᴅᴏᴡɴʟᴏᴀᴅɪɴɢ ${name}... ᴘʟᴇᴀsᴇ ᴡᴀɪᴛ.`,
                'DANI'
            )
        }, { quoted: fakevCard });

        console.log('Downloading APK from:', dllink);
        const apkResponse = await fetch(dllink, { headers: { 'Accept': 'application/octet-stream' } });
        const contentType = apkResponse.headers.get('content-type');
        if (!apkResponse.ok || (contentType && !contentType.includes('application/vnd.android.package-archive'))) {
            throw new Error(`Failed to download APK: Status ${apkResponse.status}, Content-Type: ${contentType || 'unknown'}`);
        }

        const apkBuffer = await apkResponse.arrayBuffer();
        if (!apkBuffer || apkBuffer.byteLength === 0) {
            throw new Error('Downloaded APK is empty or invalid');
        }
        const buffer = Buffer.from(apkBuffer);

        // Validate APK file (basic check for APK signature)
        if (!buffer.slice(0, 2).toString('hex').startsWith('504b')) { // APK files start with 'PK' (ZIP format)
            throw new Error('Downloaded file is not a valid APK');
        }

        await socket.sendMessage(sender, {
            document: buffer,
            mimetype: 'application/vnd.android.package-archive',
            fileName: `${name.replace(/[^a-zA-Z0-9]/g, '_')}.apk`, // Sanitize filename
            caption: formatMessage(
                '📦 𝐀𝐏𝐊 𝐃𝐄𝐓𝐀𝐈𝐋𝐒',
                `🔖 ɴᴀᴍᴇ: ${name || 'N/A'}\n📅 ʟᴀsᴛ ᴜᴘᴅᴀᴛᴇ: ${lastup || 'N/A'}\n📦 ᴘᴀᴄᴋᴀɢᴇ: ${package || 'N/A'}\n📏 Size: ${size || 'N/A'}`,
                'DANI'
            )
        }, { quoted: fakevCard });

        await socket.sendMessage(sender, { react: { text: '✅', key: msg.key } });
    } catch (error) {
        console.error('APK command error:', error.message, error.stack);
        await socket.sendMessage(sender, { text: `❌ Oh, love, couldn’t fetch the APK! 😢 Error: ${error.message}\nTry again later.` }, { quoted: fakevCard });
        await socket.sendMessage(sender, { react: { text: '❌', key: msg.key } });
    }
    break;
}
// case 38: shorturl
          case 'shorturl': {
  try {
    await socket.sendMessage(sender, { react: { text: '🔗', key: msg.key } });

    const url = args.join(' ').trim();
    if (!url) {
      await socket.sendMessage(sender, {
        text: `📌 *ᴜsᴀɢᴇ:* ${config.PREFIX}shorturl <ᴜʀʟ>\n` +
              `*ᴇxᴀᴍᴘʟᴇ:* ${config.PREFIX}shorturl https://example.com/very-long-url`
      }, { quoted: msg });
      break;
    }
    if (url.length > 2000) {
      await socket.sendMessage(sender, {
        text: `❌ *ᴜʀʟ ᴛᴏᴏ ʟᴏɴɢ!*\n` +
              `ᴘʟᴇᴀsᴇ ᴘʀᴏᴠɪᴅᴇ ᴀ ᴜʀʟ ᴜɴᴅᴇʀ 2,000 ᴄʜᴀʀᴀᴄᴛᴇʀs.`
      }, { quoted: msg });
      break;
    }
    if (!/^https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)$/.test(url)) {
      await socket.sendMessage(sender, {
        text: `❌ *ɪɴᴠᴀʟɪᴅ ᴜʀʟ!*\n` +
              `ᴘʟᴇᴀsᴇ ᴘʀᴏᴠɪᴅᴇ ᴀ ᴠᴀʟɪᴅ ᴜʀʟ sᴛᴀʀᴛɪɴɢ ᴡɪᴛʜ http:// ᴏʀ https://.\n` +
              `💋 *ᴇxᴀᴍᴘʟᴇ:* ${config.PREFIX}shorturl https://example.com/very-long-url`
      }, { quoted: msg });
      break;
    }

    const response = await axios.get(`https://is.gd/create.php?format=simple&url=${encodeURIComponent(url)}`, { timeout: 5000 });
    const shortUrl = response.data.trim();

    if (!shortUrl || !shortUrl.startsWith('https://is.gd/')) {
      throw new Error('Failed to shorten URL or invalid response from is.gd');
    }

    await socket.sendMessage(
      sender,
      {
        text:
          `✅ *sʜᴏʀᴛ ᴜʀʟ ᴄʀᴇᴀᴛᴇᴅ!* 😘\n\n` +
          `🌐 *ᴏʀɪɢɪɴᴀʟ:* ${url}\n` +
          `🔍 *sʜᴏʀᴛᴇɴᴇᴅ:* ${shortUrl}\n\n` +
          `> © powered by me`
      },
      {
        quoted: msg,
        forwardingScore: 999,
        isForwarded: true,
        forwardedNewsletterMessageInfo: {
          newsletterJid: '120363377534493877@newsletter',
          newsletterName: 'ᴅᴀɴɪ ᴠ9 ɴᴇᴛᴡᴏʀᴋ',
          serverMessageId: 428
        }
      }
    );

    await new Promise(resolve => setTimeout(resolve, 2000));
    await socket.sendMessage(sender, { 
        text: `┎━━━━━━━━━━━━━━━━━━┑\n┃ 🔗 *ᴜʀʟ ᴄᴏᴍᴘʀᴇꜱꜱᴇᴅ*\n┃\n┃ ${shortUrl}\n┖━━━━━━━━━━━━━━━━━━┙\n> ᴅᴀɴɪ ᴠ9 ᴇxᴇᴄᴜᴛɪᴠᴇ` 
    }, { quoted: msg });

  } catch (error) {
    console.error('Shorturl command error:', error.message);
    await socket.sendMessage(sender, { 
        text: `❌ ꜱʏꜱᴛᴇᴍ ᴇʀʀᴏʀ: ᴜɴᴀʙʟᴇ ᴛᴏ ᴘʀᴏᴄᴇꜱꜱ ᴜʀʟ ᴄᴏᴍᴘʀᴇꜱꜱɪᴏɴ.` 
    }, { quoted: msg });
  }
  break;
}

case 'weather': {
  try {
    await socket.sendMessage(sender, { react: { text: '🌤️', key: msg.key } });

    if (!q || q.trim() === '') {
      await socket.sendMessage(sender, {
        text: `┎━━━━━━━━━━━━━━━━━━┑\n┃ 📌 *ᴜꜱᴀɢᴇ*\n┃ ${config.PREFIX}ᴡᴇᴀᴛʜᴇʀ <ᴄɪᴛʏ>\n┖━━━━━━━━━━━━━━━━━━┙`
      }, { quoted: msg });
      break;
    }

    await socket.sendMessage(sender, {
      text: `📡 *ᴀᴄᴄᴇꜱꜱɪɴɢ ꜱᴀᴛᴇʟʟɪᴛᴇ ᴅᴀᴛᴀ...*`
    }, { quoted: msg });

    const apiKey = '2d61a72574c11c4f36173b627f8cb177';
    const city = q.trim();
    const url = `http://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=${apiKey}&units=metric`;

    const response = await axios.get(url, { timeout: 5000 });
    const data = response.data;

    const weatherMessage = `
┎━━━━━━━━━━━━━━━━━━┑
┃ 🌍 *ʟᴏᴄᴀᴛɪᴏɴ:* ${data.name}, ${data.sys.country}
┃ 🌡️ *ᴛᴇᴍᴘ:* ${data.main.temp}°C
┃ 🌡️ *ꜰᴇᴇʟꜱ:* ${data.main.feels_like}°C
┃ 💧 *ʜᴜᴍɪᴅɪᴛʏ:* ${data.main.humidity}%
┃ ☁️ *ꜱᴛᴀᴛᴜꜱ:* ${data.weather[0].main}
┃ 💨 *ᴡɪɴᴅ:* ${data.wind.speed} ᴍ/ꜱ
┖━━━━━━━━━━━━━━━━━━┙`;

    await socket.sendMessage(sender, {
      text: `🌤️ *ᴅᴀɴɪ ᴠ9 ᴡᴇᴀᴛʜᴇʀ ʀᴇᴘᴏʀᴛ*\n\n${weatherMessage}\n\n> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴅᴀᴍɪɴɪ ᴄᴏᴅᴇꜱᴘʜᴇʀᴇ`
    }, { quoted: msg });

  } catch (error) {
    console.error('Weather error:', error.message);
    await socket.sendMessage(sender, { 
        text: `❌ ꜱʏꜱᴛᴇᴍ ᴇʀʀᴏʀ: ꜰᴀɪʟᴇᴅ ᴛᴏ ʀᴇᴛʀɪᴇᴠᴇ ᴄʟɪᴍᴀᴛᴇ ᴅᴀᴛᴀ.` 
    }, { quoted: msg });
  }
  break;
}

case 'savestatus': {
  try {
    await socket.sendMessage(sender, { react: { text: '💾', key: msg.key } });

    if (!msg.quoted) {
      await socket.sendMessage(sender, {
        text: `┎━━━━━━━━━━━━━━━━━━┑\n┃ 📌 *ɪɴꜱᴛʀᴜᴄᴛɪᴏɴ*\n┃ ʀᴇᴘʟʏ ᴛᴏ ᴀ ꜱᴛᴀᴛᴜꜱ ᴛᴏ ᴄʟᴏɴᴇ.\n┖━━━━━━━━━━━━━━━━━━┙`
      }, { quoted: msg });
      break;
    }

    await socket.sendMessage(sender, {
      text: `🛰️ *ᴇxᴛʀᴀᴄᴛɪɴɢ ꜱᴛᴀᴛᴜꜱ ᴍᴇᴅɪᴀ...*`
    }, { quoted: msg });

    const media = await socket.downloadMediaMessage(msg.quoted);
    const fileExt = msg.quoted.imageMessage ? 'jpg' : 'mp4';
    const filePath = `./status_${Date.now()}.${fileExt}`;
    fs.writeFileSync(filePath, media);

    await socket.sendMessage(sender, {
      document: { url: filePath },
      mimetype: msg.quoted.imageMessage ? 'image/jpeg' : 'video/mp4',
      fileName: `ᴅᴀɴɪ_ᴠ9_ꜱᴛᴀᴛᴜꜱ.${fileExt}`,
      caption: `✅ *ꜱᴛᴀᴛᴜꜱ ꜱᴜᴄᴄᴇꜱꜱꜰᴜʟʟʏ ᴄʟᴏɴᴇᴅ*\n\n> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴅᴀᴍɪɴɪ ᴄᴏᴅᴇꜱᴘʜᴇʀᴇ`
    }, { quoted: msg });

  } catch (error) {
    console.error('Savestatus error:', error.message);
    await socket.sendMessage(sender, { 
        text: `❌ ꜱʏꜱᴛᴇᴍ ᴇʀʀᴏʀ: ꜰᴀɪʟᴇᴅ ᴛᴏ ᴅᴏᴡɴʟᴏᴀᴅ ᴍᴇᴅɪᴀ.` 
    }, { quoted: msg });
  }
  break;
}


case 'sticker':
case 's': {
    await socket.sendMessage(sender, { react: { text: '✨', key: msg.key } });

    try {
        let quoted = msg.quoted ? msg.quoted : msg;
        let mime = (quoted.msg || quoted).mimetype || '';

        if (!mime) {
            return socket.sendMessage(from, { text: '⚠️ ʀᴇᴘʟʏ ᴡɪᴛʜ ᴀɴ ɪᴍᴀɢᴇ/ᴠɪᴅᴇᴏ ᴛᴏ ᴍᴀᴋᴇ ᴀ sᴛɪᴄᴋᴇʀ!' }, { quoted: msg });
        }

        if (/image|video/.test(mime)) {
            let media = await quoted.download();
            await socket.sendMessage(from, { 
                sticker: media 
            }, { quoted: msg });
        } else {
            await socket.sendMessage(from, { text: '❌ ᴏɴʟʏ ɪᴍᴀɢᴇ ᴏʀ ᴠɪᴅᴇᴏ ᴀʟʟᴏᴡᴇᴅ ᴛᴏ ᴄʀᴇᴀᴛᴇ sᴛɪᴄᴋᴇʀ!' }, { quoted: msg });
        }
    } catch (error) {
        console.error('Error in .sticker command:', error);
        await socket.sendMessage(from, { text: '💔 ғᴀɪʟᴇᴅ ᴛᴏ ᴄʀᴇᴀᴛᴇ sᴛɪᴄᴋᴇʀ. ᴛʀʏ ᴀɢᴀɪɴ!' }, { quoted: msg });
    }
    break;
}

case 'url': {
  try {
    await socket.sendMessage(sender, { react: { text: '📤', key: msg.key || {} } });

    console.log('Message:', JSON.stringify(msg, null, 2));
    const quoted = msg.quoted || msg;
    console.log('Quoted:', JSON.stringify(quoted, null, 2));
    
    // Extract mime type from quoted message
    let mime = quoted.mimetype || '';
    if (!mime && quoted.message) {
      const messageType = Object.keys(quoted.message)[0];
      const mimeMap = {
        imageMessage: 'image/jpeg',
        videoMessage: 'video/mp4',
        audioMessage: 'audio/mpeg',
        documentMessage: 'application/octet-stream'
      };
      mime = mimeMap[messageType] || '';
    }

    console.log('MIME Type:', mime);

    if (!mime || !['image', 'video', 'audio', 'application'].some(type => mime.includes(type))) {
      await socket.sendMessage(sender, {
        text: `❌ *ʀᴇᴘʟʏ ᴛᴏ ɪᴍᴀɢᴇ, ᴀᴜᴅɪᴏ, ᴏʀ ᴠɪᴅᴇᴏ!*\n` +
              `Detected type: ${mime || 'none'}`
      }, { quoted: msg });
      break;
    }

    await socket.sendMessage(sender, {
      text: `⏳ *ᴜᴘʟᴏᴀᴅɪɴɢ ғɪʟᴇ...*`
    }, { quoted: msg });

    const buffer = await socket.downloadMediaMessage(quoted);
    if (!buffer || buffer.length === 0) {
      throw new Error('Failed to download media: Empty buffer');
    }

    // Determine file extension
    const ext = mime.includes('image/jpeg') ? '.jpg' :
                mime.includes('image/png') ? '.png' :
                mime.includes('image/gif') ? '.gif' :
                mime.includes('video') ? '.mp4' :
                mime.includes('audio') ? '.mp3' : '.bin';
    
    const name = `file_${Date.now()}${ext}`;
    const tmp = path.join(os.tmpdir(), name);
    
    // Ensure the tmp directory exists
    if (!fs.existsSync(os.tmpdir())) {
      fs.mkdirSync(os.tmpdir(), { recursive: true });
    }
    
    fs.writeFileSync(tmp, buffer);
    console.log('Saved file to:', tmp);

    const form = new FormData();
    form.append('fileToUpload', fs.createReadStream(tmp), name);
    form.append('reqtype', 'fileupload');

    const res = await axios.post('https://catbox.moe/user/api.php', form, {
      headers: form.getHeaders(),
      timeout: 30000 // 30 second timeout
    });

    // Clean up temporary file
      
          if (fs.existsSync(tmp)) {
      fs.unlinkSync(tmp);
    }

    if (!res.data || res.data.includes('error')) {
      throw new Error(`Upload failed: ${res.data || 'No response data'}`);
    }

    const type = mime.includes('image') ? 'ɪᴍᴀɢᴇ' :
                 mime.includes('video') ? 'ᴠɪᴅᴇᴏ' :
                 mime.includes('audio') ? 'ᴀᴜᴅɪᴏ' : 'ғɪʟᴇ';

    await socket.sendMessage(sender, {
      text: `✅ *${type} ᴜᴘʟᴏᴀᴅᴇᴅ!*\n\n` +
            `📁 *sɪᴢᴇ:* ${formatBytes(buffer.length)}\n` +
            `🔗 *ᴜʀʟ:* ${res.data}\n\n` +
            `© Powered by me`
    }, { quoted: msg });

    await socket.sendMessage(sender, { react: { text: '✅', key: msg.key || {} } });
  } catch (error) {
    console.error('tourl2 error:', error.message, error.stack);
    
    // Clean up temporary file if it exists
    if (tmp && fs.existsSync(tmp)) {
      try {
        fs.unlinkSync(tmp);
      } catch (e) {
        console.error('Error cleaning up temp file:', e.message);
      }
    }
    
    await socket.sendMessage(sender, {
      text: `❌ *ᴄᴏᴜʟᴅɴ'ᴛ ᴜᴘʟᴏᴀᴅ ᴛʜᴀᴛ ғɪʟᴇ! 😢*\n` +
            `ᴇʀʀᴏʀ: ${error.message || 'sᴏᴍᴇᴛʜɪɴɢ ᴡᴇɴᴛ ᴡʀᴏɴɢ'}\n` +
            `💡 *ᴛʀʏ ᴀɢᴀɪɴ, ᴅᴀʀʟɪɴɢ?*`
    }, { quoted: msg });
    await socket.sendMessage(sender, { react: { text: '❌', key: msg.key || {} } });
  }
  break;
}
case 'tourl2': {
  try {
    await socket.sendMessage(sender, { react: { text: '📤', key: msg.key || {} } });

    console.log('Message:', JSON.stringify(msg, null, 2));
    const quoted = msg.quoted || msg;
    console.log('Quoted:', JSON.stringify(quoted, null, 2));
    const mime = quoted.mimetype || (quoted.message ? Object.keys(quoted.message)[0] : '');

    console.log('MIME Type or Message Type:', mime);

    // Map message types to MIME types if mimetype is unavailable
    const mimeMap = {
      imageMessage: 'image/jpeg',
      videoMessage: 'video/mp4',
      audioMessage: 'audio/mp3'
    };
    const effectiveMime = mimeMap[mime] || mime;

    if (!effectiveMime || !['image', 'video', 'audio'].some(type => effectiveMime.includes(type))) {
      await socket.sendMessage(sender, {
        text: `❌ *ʀᴇᴘʟʏ ᴛᴏ ɪᴍᴀɢᴇ, ᴀᴜᴅɪᴏ, ᴏʀ ᴠɪᴅᴇᴏ!*\n` +
              `ᴅᴇᴛᴇᴄᴛᴇᴅ ᴛʏᴘᴇ: ${effectiveMime || 'none'}`
      }, { quoted: msg });
      break;
    }

    await socket.sendMessage(sender, {
      text: `⏳ *ᴜᴘʟᴏᴀᴅɪɴɢ ғɪʟᴇ...*`
    }, { quoted: msg });

    const buffer = await socket.downloadMediaMessage(quoted);
    if (!buffer || buffer.length === 0) {
      throw new Error('Failed to download media: Empty buffer');
    }

    const ext = effectiveMime.includes('image/jpeg') ? '.jpg' :
                effectiveMime.includes('image/png') ? '.png' :
                effectiveMime.includes('video') ? '.mp4' :
                effectiveMime.includes('audio') ? '.mp3' : '.bin';
    const name = `file_${Date.now()}${ext}`;
    const tmp = path.join(os.tmpdir(), `catbox_${Date.now()}${ext}`);
    fs.writeFileSync(tmp, buffer);
    console.log('Saved file to:', tmp);

    const form = new FormData();
    form.append('fileToUpload', fs.createReadStream(tmp), name);
    form.append('reqtype', 'fileupload');

    const res = await axios.post('https://catbox.moe/user/api.php', form, {
      headers: form.getHeaders()
    });

    fs.unlinkSync(tmp);

    if (!res.data || res.data.includes('error')) {
      throw new Error(`Upload failed: ${res.data || 'No response data'}`);
    }

    const type = effectiveMime.includes('image') ? 'ɪᴍᴀɢᴇ' :
                 effectiveMime.includes('video') ? 'ᴠɪᴅᴇᴏ' :
                 effectiveMime.includes('audio') ? 'ᴀᴜᴅɪᴏ' : 'ꜰɪʟᴇ';

    await socket.sendMessage(sender, {
      text: `┎━━━━━━━━━━━━━━━━━━┑\n┃ ✅ *${type} ᴜᴘʟᴏᴀᴅᴇᴅ*\n┃\n┃ 📁 ꜱɪᴢᴇ: ${formatBytes(buffer.length)}\n┃ 🔗 ᴜʀʟ: ${res.data}\n┖━━━━━━━━━━━━━━━━━━┙\n> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴅᴀᴍɪɴɪ ᴄᴏᴅᴇꜱᴘʜᴇʀᴇ`
    }, { quoted: msg });

    await socket.sendMessage(sender, { react: { text: '🚀', key: msg.key || {} } });
  } catch (error) {
    console.error('tourl2 error:', error.message);
    await socket.sendMessage(sender, {
      text: `❌ ꜱʏꜱᴛᴇᴍ ꜰᴀɪʟᴜʀᴇ: ᴜɴᴀʙʟᴇ ᴛᴏ ᴜᴘʟᴏᴀᴅ ᴀꜱꜱᴇᴛ ᴛᴏ ᴍᴀɪɴꜰʀᴀᴍᴇ.`
    }, { quoted: msg });
    await socket.sendMessage(sender, { react: { text: '❌', key: msg.key || {} } });
  }
  break;
}
    
case 'whois': {
    try {
        await socket.sendMessage(sender, { react: { text: '🔍', key: msg.key } });
        const domain = args[0];
        if (!domain) {
            await socket.sendMessage(sender, { text: `┎━━━━━━━━━━━━━━━━━━┑\n┃ 📌 *ᴜꜱᴀɢᴇ*\n┃ ${config.PREFIX}whois <ᴅᴏᴍᴀɪɴ>\n┖━━━━━━━━━━━━━━━━━━┙` }, { quoted: fakevCard });
            break;
        }
        const response = await fetch(`http://api.whois.vu/?whois=${encodeURIComponent(domain)}`);
        const data = await response.json();
        if (!data.domain) throw new Error('Domain not found');

        const whoisMessage = `┎━━━━━━━━━━━━━━━━━━┑\n┃ 🔍 *ᴡʜᴏɪꜱ ɪɴᴛᴇʟʟɪɢᴇɴᴄᴇ*\n┃\n┃ 🌐 ᴅᴏᴍᴀɪɴ: ${data.domain}\n┃ 📅 ᴄʀᴇᴀᴛᴇᴅ: ${data.created_date || 'N/A'}\n┃ ⏰ ᴇxᴘɪʀᴇꜱ: ${data.expiry_date || 'N/A'}\n┃ 📋 ʀᴇɢɪꜱᴛʀᴀʀ: ${data.registrar || 'N/A'}\n┃ 📍 ꜱᴛᴀᴛᴜꜱ: ${data.status[0] || 'N/A'}\n┖━━━━━━━━━━━━━━━━━━┙\n> ᴅᴀɴɪ ᴠ9 ɴᴇᴛᴡᴏʀᴋ`;
        
        await socket.sendMessage(sender, { text: whoisMessage }, { quoted: fakevCard });
    } catch (error) {
        await socket.sendMessage(sender, { text: '❌ ꜱʏꜱᴛᴇᴍ ᴇʀʀᴏʀ: ᴅᴏᴍᴀɪɴ ᴅᴀᴛᴀ ᴜɴʀᴇᴀᴄʜᴀʙʟᴇ.' }, { quoted: fakevCard });
    }
    break;
}
      
case 'repo':
case 'sc':
case 'script': {
    try {
        await socket.sendMessage(sender, { react: { text: '🪄', key: msg.key } });
        const githubRepoURL = 'https://github.com/INCONNU-BOY/INCONNU-XD-V2';
        const [, username, repo] = githubRepoURL.match(/github\.com\/([^/]+)\/([^/]+)/);
        const response = await fetch(`https://api.github.com/repos/${username}/${repo}`);
        if (!response.ok) throw new Error(`GitHub API error`);
        const repoData = await response.json();

        const formattedInfo = `┎━━━━━━━━━━━━━━━━━━┑\n┃ 💾 *ꜱʏꜱᴛᴇᴍ ʀᴇᴘᴏꜱɪᴛᴏʀʏ*\n┃\n┃ ɴᴀᴍᴇ: ${repoData.name}\n┃ ⭐ ꜱᴛᴀʀꜱ: ${repoData.stargazers_count}\n┃ 🍴 ꜰᴏʀᴋꜱ: ${repoData.forks_count}\n┃ 👑 ᴏᴡɴᴇʀ: ɪɴᴄᴏɴɴᴜ ʙᴏʏ\n┃ 📝 ᴅᴇꜱᴄ: ${repoData.description || 'ɴ/ᴀ'}\n┖━━━━━━━━━━━━━━━━━━┙\n> ᴅᴀɴɪ ᴠ9 ᴀᴜᴛᴏᴍᴀᴛɪᴏɴ`;

        await socket.sendMessage(sender, {
            image: { url: 'https://files.catbox.moe/jtzm4o.png' },
            caption: formattedInfo,
            buttons: [
                { buttonId: `${config.PREFIX}repo-visit`, buttonText: { displayText: '🌐 ᴠɪꜱɪᴛ ʀᴇᴘᴏ' }, type: 1 },
                { buttonId: `${config.PREFIX}repo-owner`, buttonText: { displayText: '👑 ᴏᴡɴᴇʀ' }, type: 1 }
            ],
            contextInfo: {
                forwardingScore: 999,
                isForwarded: true,
                forwardedNewsletterMessageInfo: {
                    newsletterJid: '120363377534493877@newsletter',
                    newsletterName: 'ᴅᴀɴɪ ᴠ9 ɴᴇᴛᴡᴏʀᴋ',
                    serverMessageId: 428
                }
            }
        }, { quoted: fakevCard });
    } catch (error) {
        await socket.sendMessage(sender, { text: "⚠️ ꜱʏꜱᴛᴇᴍ ᴇʀʀᴏʀ: ꜰᴀɪʟᴇᴅ ᴛᴏ ꜱʏɴᴄ ᴡɪᴛʜ ɢɪᴛʜᴜʙ." }, { quoted: fakevCard });
    }
    break;
}

case 'repo-visit': {
    await socket.sendMessage(sender, { 
        text: `🌐 *ꜱᴏᴜʀᴄᴇ ᴄᴏᴅᴇ ʟɪɴᴋ:*\nhttps://github.com/INCONNU-BOY/INCONNU-XD-V2`,
        contextInfo: {
            externalAdReply: {
                title: 'ᴅᴀɴɪ ᴠ9 ꜱᴏᴜʀᴄᴇ',
                body: 'ᴇxᴇᴄᴜᴛᴇ ɪɴ ʙʀᴏᴡꜱᴇʀ',
                mediaType: 1,
                thumbnailUrl: "https://files.catbox.moe/jtzm4o.png",
                sourceUrl: 'https://github.com/INCONNU-BOY/INCONNU-XD-V2'
            }
        }
    }, { quoted: fakevCard });
    break;
}

case 'repo-owner': {
    await socket.sendMessage(sender, {
        text: `👑 *ᴅᴇᴠᴇʟᴏᴘᴇʀ ɪɴᴛᴇʟ:*\nhttps://github.com/INCONNU-BOY`,
        contextInfo: {
            externalAdReply: {
                title: 'ᴅᴇᴠᴇʟᴏᴘᴇʀ ᴘʀᴏꜰɪʟᴇ',
                body: 'ɪɴᴄᴏɴɴᴜ ʙᴏʏ',
                mediaType: 1,
                thumbnailUrl: "https://files.catbox.moe/jtzm4o.png",
                sourceUrl: 'https://github.com/INCONNU-BOY'
            }
        }
    }, { quoted: fakevCard });
    break;
}

case 'deleteme': {
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${number.replace(/[^0-9]/g, '')}`);
    if (fs.existsSync(sessionPath)) fs.removeSync(sessionPath);
    await deleteSessionFromGitHub(number);
    if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
        activeSockets.get(number.replace(/[^0-9]/g, '')).ws.close();
        activeSockets.delete(number.replace(/[^0-9]/g, ''));
    }
    await socket.sendMessage(sender, {
        image: { url: "https://files.catbox.moe/jtzm4o.png" },
        caption: `┎━━━━━━━━━━━━━━━━━━┑\n┃ 🗑️ *ꜱᴇꜱꜱɪᴏɴ ᴛᴇʀᴍɪɴᴀᴛᴇᴅ*\n┃\n┃ ᴀʟʟ ᴅᴀᴛᴀ ʜᴀꜱ ʙᴇᴇɴ ᴘᴜʀɢᴇᴅ.\n┖━━━━━━━━━━━━━━━━━━┙\n> ᴅᴀɴɪ ᴠ9 ᴍᴀɪɴꜰʀᴀᴍᴇ`
    });
    break;
}
                case 'deleteme':
                    const sessionPath = path.join(SESSION_BASE_PATH, `session_${number.replace(/[^0-9]/g, '')}`);
                    if (fs.existsSync(sessionPath)) {
                        fs.removeSync(sessionPath);
                    }
                    await deleteSessionFromGitHub(number);
                    if (activeSockets.has(number.replace(/[^0-9]/g, ''))) {
                        activeSockets.get(number.replace(/[^0-9]/g, '')).ws.close();
                        activeSockets.delete(number.replace(/[^0-9]/g, ''));
                        socketCreationTime.delete(number.replace(/[^0-9]/g, ''));
                    }
                    await socket.sendMessage(sender, {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '🗑️ SESSION DELETED',
                            '✅ Your session has been successfully deleted.',
                            'DANI†'
                        )
                    });
                    break;
                    case 'studyai': {
    try {
        await socket.sendMessage(sender, { react: { text: '🎓', key: msg.key } });

        if (!q) {
            return await socket.sendMessage(sender, {
                text: `┎━━━━━━━━━━━━━━━━━━┑\n┃ 🎓 *ᴀɪ ꜱᴛᴜᴅʏ ɢᴜɪᴅᴇ*\n┃\n┃ ᴘʟᴇᴀꜱᴇ ᴘʀᴏᴠɪᴅᴇ ᴀ ᴛᴏᴘɪᴄ ᴏʀ \n┃ ǫᴜᴇꜱᴛɪᴏɴ ꜰᴏʀ ᴊᴀᴍʙ/ᴡᴀᴇᴄ.\n┃\n┃ *ᴇx:* ${config.PREFIX}ꜱᴛᴜᴅʏᴀɪ ʜᴏᴡ ᴛᴏ \n┃ ꜱᴏʟᴠᴇ ǫᴜᴀᴅʀᴀᴛɪᴄ ᴇǫᴜᴀᴛɪᴏɴꜱ\n┖━━━━━━━━━━━━━━━━━━┙`
            }, { quoted: msg });
        }

        // Fetching from your specific endpoint
        const response = await axios.get(`https://apis.prexzyvilla.site/ai/ai4chat?prompt=${encodeURIComponent(q + " (Provide a detailed study guide for a student preparing for JAMB and WAEC)")}`);
        const result = response.data.result;

        const studyMessage = {
            image: { url: "https://files.catbox.moe/jtzm4o.png" },
            caption: `┎━━━━━━━━━━━━━━━━━━┑\n┃ 📖 *ᴅᴀɴɪ ᴠ9 ᴀᴄᴀᴅᴇᴍɪᴄ ᴀɪ*\n┖━━━━━━━━━━━━━━━━━━┙\n\n${result}\n\n> ꜱᴜᴄᴄᴇꜱꜱ ɪɴ ᴊᴀᴍʙ/ᴡᴀᴇᴄ ᴀᴡᴀɪᴛꜱ 🚀`,
            contextInfo: {
                forwardingScore: 999,
                isForwarded: true,
                forwardedNewsletterMessageInfo: {
                    newsletterJid: '120363377534493877@newsletter',
                    newsletterName: 'ᴅᴀɴɪ ᴠ9 ɴᴇᴛᴡᴏʀᴋ',
                    serverMessageId: 428
                }
            }
        };

        await socket.sendMessage(sender, studyMessage, { quoted: msg });

    } catch (error) {
        console.error('StudyAI Error:', error);
        await socket.sendMessage(sender, { 
            text: `❌ ꜱʏꜱᴛᴇᴍ ꜰᴀɪʟᴜʀᴇ: ᴜɴᴀʙʟᴇ ᴛᴏ ᴄᴏɴɴᴇᴄᴛ ᴛᴏ ᴇᴅᴜ-ꜱᴇʀᴠᴇʀ.` 
        }, { quoted: msg });
    }
}
break;
case 'copilot': case 'gpt4': case 'deepseek': case 'chatgpt': case 'chatup': case 'primis': {
    try {
        await socket.sendMessage(sender, { react: { text: '🧠', key: msg.key } });
        if (!q) return await socket.sendMessage(sender, { text: `┎━━━━━━━━━━━━━━━━━━┑\n┃ 🤖 *ɪɴᴘᴜᴛ ʀᴇǫᴜᴇɪʀᴇᴅ*\n┖━━━━━━━━━━━━━━━━━━┙` }, { quoted: msg });

        let endpoint = '';
        let modelName = '';

        switch (command) {
            case 'copilot':
                endpoint = `https://apis.prexzyvilla.site/ai/copilot?text=${encodeURIComponent(q)}`;
                modelName = 'ᴄᴏᴘɪʟᴏᴛ ᴀɪ';
                break;
            case 'gpt4':
                endpoint = `https://apis.prexzyvilla.site/ai/gpt-5?text=${encodeURIComponent(q)}`;
                modelName = 'ɢᴘᴛ-4.0 ᴛᴜʀʙᴏ';
                break;
            case 'deepseek':
                endpoint = `https://apis.prexzyvilla.site/ai/chat--cf-deepseek-ai-deepseek-r1-distill-qwen-32b?prompt=${encodeURIComponent(q)}`;
                modelName = 'ᴅᴇᴇᴘꜱᴇᴇᴋ ʀ1';
                break;
            case 'chatgpt':
                endpoint = `https://apis.prexzyvilla.site/ai/chatgpt?prompt=${encodeURIComponent(q)}`;
                modelName = 'ᴄʜᴀᴛɢᴘᴛ ᴏᴘᴇɴᴀɪ';
                break;
            case 'chatup':
                endpoint = `https://apis.prexzyvilla.site/ai/chatup?prompt=${encodeURIComponent(q)}`;
                modelName = 'ᴄʜᴀᴛᴜᴘ ᴀɪ';
                break;
            case 'primis':
                endpoint = `https://apis.prexzyvilla.site/ai/ai4chat?prompt=${encodeURIComponent(q)}`;
                modelName = 'ᴘʀɪᴍɪꜱ ᴀɪ';
                break;
        }

        const res = await axios.get(endpoint);
        const result = res.data.result || res.data.response || res.data.data;

        await socket.sendMessage(sender, {
            image: { url: "https://files.catbox.moe/jtzm4o.png" },
            caption: `┎━━━━━━━━━━━━━━━━━━┑\n┃ 🤖 *${modelName} ʀᴇꜱᴘᴏɴꜱᴇ*\n┖━━━━━━━━━━━━━━━━━━┙\n\n${result}\n\n> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴅᴀᴍɪɴɪ ᴄᴏᴅᴇꜱᴘʜᴇʀᴇ`,
            contextInfo: {
                forwardingScore: 999,
                isForwarded: true,
                forwardedNewsletterMessageInfo: {
                    newsletterJid: '120363377534493877@newsletter',
                    newsletterName: 'ᴅᴀɴɪ ᴠ9 ɴᴇᴛᴡᴏʀᴋ',
                    serverMessageId: 428
                }
            }
        }, { quoted: msg });
    } catch (e) {
        await socket.sendMessage(sender, { text: `❌ ꜱʏꜱᴛᴇᴍ ᴇʀʀᴏʀ: ɴᴇᴜʀᴀʟ ʟɪɴᴋ ꜰᴀɪʟᴇᴅ.` }, { quoted: msg });
    }
}
break;
case 'nanobanana': case 'realistic': case 'anime': case 'aiimg': {
    try {
        await socket.sendMessage(sender, { react: { text: '🎨', key: msg.key } });
        if (!q) return await socket.sendMessage(sender, { text: `┎━━━━━━━━━━━━━━━━━━┑\n┃ 🎨 *ᴘʀᴏᴍᴘᴛ ʀᴇǫᴜᴇɪʀᴇᴅ*\n┖━━━━━━━━━━━━━━━━━━┙` }, { quoted: msg });

        let endpoint = '';
        let engineName = '';

        switch (command) {
            case 'nanobanana':
                endpoint = `https://apis.prexzyvilla.site/ai/pixwith-nanobanana?prompt=${encodeURIComponent(q)}`;
                engineName = 'ɴᴀɴᴏ ʙᴀɴᴀɴᴀ';
                break;
            case 'realistic':
                endpoint = `https://apis.prexzyvilla.site/ai/realistic?prompt=${encodeURIComponent(q)}`;
                engineName = 'ʀᴇᴀʟɪꜱᴛɪᴄ ᴠ9';
                break;
            case 'anime':
                endpoint = `https://apis.prexzyvilla.site/ai/anime?prompt=${encodeURIComponent(q)}`;
                engineName = 'ᴀɴɪᴍᴇ ꜱᴛʏʟᴇ';
                break;
            case 'aiimg':
                endpoint = `https://apis.prexzyvilla.site/ai/fantasy?prompt=${encodeURIComponent(q)}`;
                engineName = 'ꜰᴀɴᴛᴀꜱʏ ᴀɪ';
                break;
        }

        await socket.sendMessage(sender, { text: `⏳ *ɢᴇɴᴇʀᴀᴛɪɴɢ ${engineName} ᴠɪꜱᴜᴀʟꜱ...*` }, { quoted: msg });

        await socket.sendMessage(sender, {
            image: { url: endpoint },
            caption: `┎━━━━━━━━━━━━━━━━━━┑\n┃ 🎨 *${engineName} ᴏᴜᴛᴘᴜᴛ*\n┖━━━━━━━━━━━━━━━━━━┙\n\n> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴅᴀᴍɪɴɪ ᴄᴏᴅᴇꜱᴘʜᴇʀᴇ`,
            contextInfo: {
                forwardingScore: 999,
                isForwarded: true,
                forwardedNewsletterMessageInfo: {
                    newsletterJid: '120363377534493877@newsletter',
                    newsletterName: 'ᴅᴀɴɪ ᴠ9 ɴᴇᴛᴡᴏʀᴋ',
                    serverMessageId: 428
                }
            }
        }, { quoted: msg });
    } catch (e) {
        await socket.sendMessage(sender, { text: `❌ ꜱʏꜱᴛᴇᴍ ᴇʀʀᴏʀ: ᴠɪꜱᴜᴀʟ ᴇɴɢɪɴᴇ ᴏᴠᴇʀʟᴏᴀᴅᴇᴅ.` }, { quoted: msg });
    }
}
break;
case 'vnum': case 'sms': {
    try {
        await socket.sendMessage(sender, { react: { text: '📞', key: msg.key } });

        // Logic for fetching SMS messages
        if (q.startsWith('+') || !isNaN(q.trim().split(' ')[0])) {
            const number = q.trim();
            const endpoint = `https://apis.prexzyvilla.site/vnum/sms24-messages?number=${number}`;
            
            await socket.sendMessage(sender, { text: `📡 *ʀᴇᴛʀɪᴇᴠɪɴɢ ɪɴᴄᴏᴍɪɴɢ ꜱᴍꜱ ꜰᴏʀ:* ${number}...` }, { quoted: msg });

            const res = await axios.get(endpoint);
            const smsList = res.data.result || res.data.messages;

            if (!smsList || smsList.length === 0) {
                return await socket.sendMessage(sender, { text: `❌ *ɴᴏ ᴍᴇꜱꜱᴀɢᴇꜱ ꜰᴏᴜɴᴅ ꜰᴏʀ ᴛʜɪꜱ ɴᴜᴍʙᴇʀ.*` }, { quoted: msg });
            }

            // Format top 5 recent messages
            let smsReport = `┎━━━━━━━━━━━━━━━━━━┑\n┃ 📥 *ʀᴇᴄᴇɴᴛ ɪɴᴄᴏᴍɪɴɢ ꜱᴍꜱ*\n┖━━━━━━━━━━━━━━━━━━┙\n\n`;
            smsList.slice(0, 5).forEach((msg, i) => {
                smsReport += `🔹 *ꜰʀᴏᴍ:* ${msg.from}\n💬 *ᴍꜱɢ:* ${msg.text}\n⏰ *ᴛɪᴍᴇ:* ${msg.date}\n\n`;
            });

            await socket.sendMessage(sender, {
                text: `${smsReport}> ᴅᴀɴɪ ᴠ9 ᴠ-ɪɴᴛᴇʟ`,
                contextInfo: {
                    forwardingScore: 999,
                    isForwarded: true,
                    forwardedNewsletterMessageInfo: {
                        newsletterJid: '120363377534493877@newsletter',
                        newsletterName: 'ᴅᴀɴɪ ᴠ9 ɴᴇᴛᴡᴏʀᴋ',
                        serverMessageId: 428
                    }
                }
            }, { quoted: msg });

        } else if (q) {
            // Logic for listing numbers by country code (e.g., .vnum US)
            const country = q.toUpperCase().trim();
            const endpoint = `https://apis.prexzyvilla.site/vnum/sms24-numbers?country=${country}`;

            const res = await axios.get(endpoint);
            const numbers = res.data.result || res.data.numbers;

            if (!numbers || numbers.length === 0) {
                return await socket.sendMessage(sender, { text: `❌ *ɴᴏ ɴᴜᴍʙᴇʀꜱ ᴀᴠᴀɪʟᴀʙʟᴇ ꜰᴏʀ ᴛʜɪꜱ ᴄᴏᴜɴᴛʀʏ.*` }, { quoted: msg });
            }

            let numReport = `┎━━━━━━━━━━━━━━━━━━┑\n┃ 📞 *ᴀᴠᴀɪʟᴀʙʟᴇ ɴᴜᴍʙᴇʀꜱ: ${country}*\n┖━━━━━━━━━━━━━━━━━━┙\n\n`;
            numbers.slice(0, 15).forEach((n) => {
                numReport += `📍 ${n.number} (${n.provider})\n`;
            });
            numReport += `\n💡 *ᴜꜱᴇ:* ${config.PREFIX}ꜱᴍꜱ <ɴᴜᴍʙᴇʀ> ᴛᴏ ʀᴇᴀᴅ ᴍᴇꜱꜱᴀɢᴇꜱ.`;

            await socket.sendMessage(sender, { text: numReport }, { quoted: msg });

        } else {
            // Usage guide
            await socket.sendMessage(sender, {
                text: `┎━━━━━━━━━━━━━━━━━━┑\n┃ 📌 *ᴠ-ɴᴜᴍ ɪɴꜱᴛʀᴜᴄᴛɪᴏɴꜱ*\n┖━━━━━━━━━━━━━━━━━━┙\n\n1️⃣ ꜰɪɴᴅ ɴᴜᴍʙᴇʀꜱ: ${config.PREFIX}ᴠɴᴜᴍ <ᴄᴏᴜɴᴛʀʏ_ᴄᴏᴅᴇ>\n*(ᴇx: .ᴠɴᴜᴍ ᴜꜱ)*\n\n2️⃣ ʀᴇᴀᴅ ꜱᴍꜱ: ${config.PREFIX}ꜱᴍꜱ <ꜰᴜʟʟ_ɴᴜᴍʙᴇʀ>\n*(ᴇx: .ꜱᴍꜱ 1234567890)*`
            }, { quoted: msg });
        }

    } catch (e) {
        console.error('Vnum Error:', e);
        await socket.sendMessage(sender, { text: `❌ ꜱʏꜱᴛᴇᴍ ᴇʀʀᴏʀ: ᴜɴᴀʙʟᴇ ᴛᴏ ᴀᴄᴄᴇꜱꜱ ᴠ-ɴᴜᴍ ꜱᴇʀᴠᴇʀ.` }, { quoted: msg });
    }
}
break;
case 'groupstatus':
case 'gstatus':
case 'gst': {
    if (!m.isGroup) {
        return reply(`👥 *DANI V9 Group Status*\n\nThis command can only be used in groups.`);
    }
    
    try {
        await devtrust.sendMessage(m.chat, { react: { text: '📢', key: m.key } });
        
        // Check if replying to a message or providing text
        const quotedMsg = m.quoted;
        const textInput = text;
        
        if (!quotedMsg && !textInput) {
            return reply(`📢 *DANI V9 Group Status*\n\nReply to an image/video/audio or provide text to post as group status.\n\nExample: ${prefix}gstatus Hello group!`);
        }
        
        // Simple random ID generator
        function generateMessageId() {
            return '3EB0' + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
        }
        
        let statusInnerMessage = {};
        
        // ==========================================
        // 1. HANDLE TEXT STATUS (BLACK BACKGROUND)
        // ==========================================
        if (!quotedMsg && textInput) {
            statusInnerMessage = {
                extendedTextMessage: {
                    text: textInput,
                    backgroundArgb: 0xFF000000, // BLACK background
                    textArgb: 0xFFFFFFFF, // White text
                    font: 1,
                    contextInfo: { 
                        mentionedJid: [],
                        isGroupStatus: true 
                    }
                }
            };
            
            // Create and send status
            const statusPayload = {
                groupStatusMessageV2: {
                    message: statusInnerMessage
                }
            };
            
            const statusId = generateMessageId();
            await devtrust.relayMessage(m.chat, statusPayload, { messageId: statusId });
            
            await devtrust.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
            return reply(`📢 *DANI V9 Group Status*\n\nText status posted!`);
        }
        
        // ==========================================
        // 2. HANDLE QUOTED MEDIA/TEXT
        // ==========================================
        else if (quotedMsg) {
            // Check if it's a media message
            const mime = (quotedMsg.msg || quotedMsg).mimetype || '';
            
            // IMAGE STATUS
            if (/image/.test(mime)) {
                // Download image
                let media = await quotedMsg.download();
                
                // Send as image status
                await devtrust.sendMessage(m.chat, {
                    image: media,
                    caption: textInput || quotedMsg.caption || '',
                    contextInfo: { isGroupStatus: true }
                });
            } 
            
            // VIDEO STATUS
            else if (/video/.test(mime)) {
                // Download video
                let media = await quotedMsg.download();
                
                // Send as video status
                await devtrust.sendMessage(m.chat, {
                    video: media,
                    caption: textInput || quotedMsg.caption || '',
                    contextInfo: { isGroupStatus: true }
                });
            }
            
            // AUDIO STATUS (NEW)
            else if (/audio/.test(mime)) {
                // Download audio
                let media = await quotedMsg.download();
                
                // Send as audio status
                await devtrust.sendMessage(m.chat, {
                    audio: media,
                    mimetype: 'audio/mpeg',
                    ptt: false, // true for voice note
                    contextInfo: { isGroupStatus: true }
                });
            }
            
            // TEXT STATUS (Quoted text - BLACK BACKGROUND)
            else if (quotedMsg.conversation || quotedMsg.text) {
                const textContent = quotedMsg.conversation || quotedMsg.text || textInput;
                
                statusInnerMessage = {
                    extendedTextMessage: {
                        text: textContent,
                        backgroundArgb: 0xFF000000, // BLACK background
                        textArgb: 0xFFFFFFFF, // White text
                        font: 2,
                        contextInfo: { 
                            mentionedJid: [],
                            isGroupStatus: true 
                        }
                    }
                };
                
                const statusPayload = {
                    groupStatusMessageV2: {
                        message: statusInnerMessage
                    }
                };
                
                const statusId = generateMessageId();
                await devtrust.relayMessage(m.chat, statusPayload, { messageId: statusId });
                
            } else {
                return reply(`❌ *DANI V9 Group Status*\n\nUnsupported media type. Reply to image, video, audio, or text only.`);
            }
            
            await devtrust.sendMessage(m.chat, { react: { text: '✅', key: m.key } });
            reply(`📢 *DANI V9 Group Status*\n\nStatus posted!`);
        }
        
    } catch (error) {
        console.error('Group Status Error:', error);
        await devtrust.sendMessage(m.chat, { react: { text: '❌', key: m.key } });
        reply(`⚠️ *DANI V9 Group Status*\n\nFailed: ${error.message}`);
    }
}
break;
}
// more future commands      
                                 
            }
        } catch (error) {
            console.error('Command handler error:', error);
            await socket.sendMessage(sender, {
                image: { url: config.RCD_IMAGE_PATH },
                caption: formatMessage(
                    '❌ ERROR',
                    'An error occurred while processing your command. Please try again.',
                    'DANI★'
                )
            });
        }
    });
}

function setupMessageHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg.message || msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid === config.NEWSLETTER_JID) return;

        if (config.AUTO_RECORDING === 'true') {
            try {
                await socket.sendPresenceUpdate('recording', msg.key.remoteJid);
                console.log(`Set recording presence for ${msg.key.remoteJid}`);
            } catch (error) {
                console.error('Failed to set recording presence:', error);
            }
        }
    });
}

async function deleteSessionFromGitHub(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file =>
            file.name.includes(sanitizedNumber) && file.name.endsWith('.json')
        );

        for (const file of sessionFiles) {
            await octokit.repos.deleteFile({
                owner,
                repo,
                path: `session/${file.name}`,
                message: `Delete session for ${sanitizedNumber}`,
                sha: file.sha
            });
            console.log(`Deleted GitHub session file: ${file.name}`);
        }

        // Update numbers.json on GitHub
        let numbers = [];
        if (fs.existsSync(NUMBER_LIST_PATH)) {
            numbers = JSON.parse(fs.readFileSync(NUMBER_LIST_PATH, 'utf8'));
            numbers = numbers.filter(n => n !== sanitizedNumber);
            fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers, null, 2));
            await updateNumberListOnGitHub(sanitizedNumber);
        }
    } catch (error) {
        console.error('Failed to delete session from GitHub:', error);
    }
}

async function restoreSession(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: 'session'
        });

        const sessionFiles = data.filter(file =>
            file.name === `creds_${sanitizedNumber}.json`
        );

        if (sessionFiles.length === 0) return null;

        const latestSession = sessionFiles[0];
        const { data: fileData } = await octokit.repos.getContent({
            owner,
            repo,
            path: `session/${latestSession.name}`
        });

        const content = Buffer.from(fileData.content, 'base64').toString('utf8');
        return JSON.parse(content);
    } catch (error) {
        console.error('Session restore failed:', error);
        return null;
    }
}

async function loadUserConfig(number) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const configPath = `session/config_${sanitizedNumber}.json`;
        const { data } = await octokit.repos.getContent({
            owner,
            repo,
            path: configPath
        });

        const content = Buffer.from(data.content, 'base64').toString('utf8');
        return JSON.parse(content);
    } catch (error) {
        console.warn(`No configuration found for ${number}, using default config`);
        return { ...config };
    }
}

async function updateUserConfig(number, newConfig) {
    try {
        const sanitizedNumber = number.replace(/[^0-9]/g, '');
        const configPath = `session/config_${sanitizedNumber}.json`;
        let sha;

        try {
            const { data } = await octokit.repos.getContent({
                owner,
                repo,
                path: configPath
            });
            sha = data.sha;
        } catch (error) {
        }

        await octokit.repos.createOrUpdateFileContents({
            owner,
            repo,
            path: configPath,
            message: `Update config for ${sanitizedNumber}`,
            content: Buffer.from(JSON.stringify(newConfig, null, 2)).toString('base64'),
            sha
        });
        console.log(`Updated config for ${sanitizedNumber}`);
    } catch (error) {
        console.error('Failed to update config:', error);
        throw error;
    }
}

function setupAutoRestart(socket, number) {
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode === 401) { // 401 indicates user-initiated logout
                console.log(`User ${number} logged out. Deleting session...`);
                
                // Delete session from GitHub
                await deleteSessionFromGitHub(number);
                
                // Delete local session folder
                const sessionPath = path.join(SESSION_BASE_PATH, `session_${number.replace(/[^0-9]/g, '')}`);
                if (fs.existsSync(sessionPath)) {
                    fs.removeSync(sessionPath);
                    console.log(`Deleted local session folder for ${number}`);
                }

                // Remove from active sockets
                activeSockets.delete(number.replace(/[^0-9]/g, ''));
                socketCreationTime.delete(number.replace(/[^0-9]/g, ''));

                // Notify user      
                              try {
                    await socket.sendMessage(jidNormalizedUser(socket.user.id), {
                        image: { url: config.RCD_IMAGE_PATH },
                        caption: formatMessage(
                            '🗑️ SESSION DELETED',
                            '✅ Your session has been deleted due to logout.',
                            'ᴍɪɴɪ Stacy xᴅ'
                        )
                    });
                } catch (error) {
                    console.error(`Failed to notify ${number} about session deletion:`, error);
                }

                console.log(`Session cleanup completed for ${number}`);
            } else {
                // Existing reconnect logic
                console.log(`Connection lost for ${number}, attempting to reconnect...`);
                await delay(10000);
                activeSockets.delete(number.replace(/[^0-9]/g, ''));
                socketCreationTime.delete(number.replace(/[^0-9]/g, ''));
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(number, mockRes);
            }
        }
    });
}

async function EmpirePair(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(SESSION_BASE_PATH, `session_${sanitizedNumber}`);

    await cleanDuplicateFiles(sanitizedNumber);

    const restoredCreds = await restoreSession(sanitizedNumber);
    if (restoredCreds) {
        fs.ensureDirSync(sessionPath);
        fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(restoredCreds, null, 2));
        console.log(`Successfully restored session for ${sanitizedNumber}`);
    }

    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: process.env.NODE_ENV === 'production' ? 'fatal' : 'debug' });

    try {
        const socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            printQRInTerminal: false,
            logger,
            browser: Browsers.macOS('Safari')
        });

        socketCreationTime.set(sanitizedNumber, Date.now());

        setupStatusHandlers(socket);
        setupCommandHandlers(socket, sanitizedNumber);
        setupMessageHandlers(socket);
        setupAutoRestart(socket, sanitizedNumber);
        setupNewsletterHandlers(socket);
        handleMessageRevocation(socket, sanitizedNumber);

        if (!socket.authState.creds.registered) {
            let retries = config.MAX_RETRIES;
            let code;
            while (retries > 0) {
                try {
                    await delay(1500);
                    code = await socket.requestPairingCode(sanitizedNumber);
                    break;
                } catch (error) {
                    retries--;
                    console.warn(`Failed to request pairing code: ${retries}, error.message`, retries);
                    await delay(2000 * (config.MAX_RETRIES - retries));
                }
            }
            if (!res.headersSent) {
                res.send({ code });
            }
        }

        socket.ev.on('creds.update', async () => {
            await saveCreds();
            const fileContent = await fs.readFile(path.join(sessionPath, 'creds.json'), 'utf8');
            let sha;
            try {
                const { data } = await octokit.repos.getContent({
                    owner,
                    repo,
                    path: `session/creds_${sanitizedNumber}.json`
                });
                sha = data.sha;
            } catch (error) {
            }

            await octokit.repos.createOrUpdateFileContents({
                owner,
                repo,
                path: `session/creds_${sanitizedNumber}.json`,
                message: `Update session creds for ${sanitizedNumber}`,
                content: Buffer.from(fileContent).toString('base64'),
                sha
            });
            console.log(`Updated creds for ${sanitizedNumber} in GitHub`);
        });

        socket.ev.on('connection.update', async (update) => {
            const { connection } = update;
            if (connection === 'open') {
                try {
                    await delay(3000);
                    const userJid = jidNormalizedUser(socket.user.id);

                    const groupResult = await joinGroup(socket);

                    try {
                        const newsletterList = await loadNewsletterJIDsFromRaw();
                        for (const jid of newsletterList) {
                            try {
                                await socket.newsletterFollow(jid);
                                await socket.sendMessage(jid, { react: { text: '❤️', key: { id: '1' } } });
                                console.log(`✅ Followed and reacted to newsletter: ${jid}`);
                            } catch (err) {
                                console.warn(`⚠️ Failed to follow/react to ${jid}:`, err.message);
                            }
                        }
                        console.log('✅ Auto-followed newsletter & reacted');
                    } catch (error) {
                        console.error('❌ Newsletter error:', error.message);
                    }

                    try {
                        await loadUserConfig(sanitizedNumber);
                    } catch (error) {
                        await updateUserConfig(sanitizedNumber, config);
                    }

                    activeSockets.set(sanitizedNumber, socket);

const groupStatus = groupResult.status === 'success'
    ? 'ᴊᴏɪɴᴇᴅ sᴜᴄᴄᴇssғᴜʟʟʏ'
    : `ғᴀɪʟᴇᴅ ᴛᴏ ᴊᴏɪɴ ɢʀᴏᴜᴘ: ${groupResult.error}`;

// --- DANI V9 CONNECTION SUCCESS MODULE ---
await socket.sendMessage(userJid, {
    image: { url: "https://files.catbox.moe/jtzm4o.png" },
    caption: `┎━━━━━━━━━━━━━━━━━━┑
┃ ✅ *ᴄᴏɴɴᴇᴄᴛɪᴏɴ ꜱᴜᴄᴄᴇꜱꜱꜰᴜʟ*
┃ 
┃ 👤 ɴᴜᴍʙᴇʀ: ${sanitizedNumber}
┃ 🌐 ꜱᴛᴀᴛᴜꜱ: ${groupStatus}
┃ 🕒 ᴛɪᴍᴇ: ${new Date().toLocaleString()}
┃ 
┃ ᴛʏᴘᴇ *${config.PREFIX}menu* ᴛᴏ ᴇxᴇᴄᴜᴛᴇ.
┖━━━━━━━━━━━━━━━━━━┙
> ᴘᴏᴡᴇʀᴇᴅ ʙʏ ᴅᴀᴍɪɴɪ ᴄᴏᴅᴇꜱᴘʜᴇʀᴇ`
});

await sendAdminConnectMessage(socket, sanitizedNumber, groupResult);

// --- ATOMIC FILE & GITHUB SYNCHRONIZATION ---
let numbers = [];
try {
    if (fs.existsSync(NUMBER_LIST_PATH)) {
        const fileContent = fs.readFileSync(NUMBER_LIST_PATH, 'utf8');
        numbers = JSON.parse(fileContent) || [];
    }
    
    if (!numbers.includes(sanitizedNumber)) {
        numbers.push(sanitizedNumber);
        
        // Safety Backup Mechanism
        if (fs.existsSync(NUMBER_LIST_PATH)) {
            fs.copyFileSync(NUMBER_LIST_PATH, `${NUMBER_LIST_PATH}.backup`);
        }
        
        fs.writeFileSync(NUMBER_LIST_PATH, JSON.stringify(numbers, null, 2));
        console.log(`📝 [SYS] ${sanitizedNumber} indexed locally.`);
        
        // Async GitHub Handshake
        updateNumberListOnGitHub(sanitizedNumber).catch(err => 
            console.warn(`⚠️ [CLOUD] Sync skipped: ${err.message}`)
        );
    }
} catch (fileError) {
    console.error(`❌ [IO_ERROR] Internal storage failure:`, fileError.message);
}

// --- ROUTER & API ENDPOINTS ---

router.get('/ping', (req, res) => {
    res.status(200).send({
        status: 'active',
        mainframe: 'ᴅᴀɴɪ ᴠ9 ᴛᴇʀᴍɪɴᴀʟ',
        uptime: process.uptime(),
        active_sessions: activeSockets.size
    });
});

router.get('/verify-otp', async (req, res) => {
    const { number, otp } = req.query;
    if (!number || !otp) return res.status(400).send({ error: 'Missing parameters' });

    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const storedData = otpStore.get(sanitizedNumber);

    if (!storedData || Date.now() >= storedData.expiry || storedData.otp !== otp) {
        return res.status(400).send({ error: 'Invalid or expired credentials' });
    }

    try {
        await updateUserConfig(sanitizedNumber, storedData.newConfig);
        otpStore.delete(sanitizedNumber);
        
        const socket = activeSockets.get(sanitizedNumber);
        if (socket) {
            await socket.sendMessage(jidNormalizedUser(socket.user.id), {
                image: { url: "https://files.catbox.moe/jtzm4o.png" },
                caption: `┎━━━━━━━━━━━━━━━━━━┑\n┃ 📌 *ᴄᴏɴꜰɪɢ ᴜᴘᴅᴀᴛᴇᴅ*\n┃\n┃ ᴍᴀɪɴꜰʀᴀᴍᴇ ꜱᴇᴛᴛɪɴɢꜱ ꜱʏɴᴄᴇᴅ.\n┖━━━━━━━━━━━━━━━━━━┙\n> ᴅᴀɴɪ ᴠ9 ꜱʏꜱᴛᴇᴍ`
            });
        }
        res.status(200).send({ status: 'success' });
    } catch (error) {
        res.status(500).send({ error: 'Config write failure' });
    }
});

// --- GLOBAL EXCEPTION HANDLING & RECOVERY ---
process.on('uncaughtException', (err) => {
    console.error('🔴 CRITICAL SYSTEM FAILURE:', err);
    // Graceful restart via PM2
    exec(`pm2 restart ${process.env.PM2_NAME || 'DANI-V9-MAIN'}`);
});

// --- CLOUD RECOVERY LOGIC ---
async function autoReconnectFromGitHub() {
    try {
        const pathOnGitHub = 'session/numbers.json';
        const { data } = await octokit.repos.getContent({ owner, repo, path: pathOnGitHub });
        const numbers = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));

        for (const number of numbers) {
            if (!activeSockets.has(number)) {
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await EmpirePair(number, mockRes);
                console.log(`🔁 [RECOVERY] Re-linking: ${number}`);
                await new Promise(r => setTimeout(r, 2000)); // Throttled boot
            }
        }
    } catch (error) {
        console.error('❌ [RECOVERY_ERROR]:', error.message);
    }
}

autoReconnectFromGitHub();
module.exports = router;

async function loadNewsletterJIDsFromRaw() {
    try {
        const res = await axios.get('https://raw.githubusercontent.com/INCONNU-BOY/mini-data/refs/heads/main/session/gen.json');
        return Array.isArray(res.data) ? res.data : [];
    } catch (err) {
        console.error('❌ Failed to load newsletter list from GitHub:', err.message);
        return [];
    }
}