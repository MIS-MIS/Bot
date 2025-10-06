// app.js
require('dotenv').config();
const express = require('express');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const csv = require('csv-parser');
const app = express();
const port = process.env.PORT || 3000;

// Load business configuration
let config;
try {
  config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
} catch (error) {
  console.error('Error loading config.json. Please create it from config-template.json');
  process.exit(1);
}

// ---------------------- CONFIG ----------------------
const API_KEY = process.env.GOOGLE_API_KEY;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const RANGE = process.env.RANGE || "'Sales FMS'!C8:Z1000";
const LOG_FILE = process.env.LOG_FILE || path.join(__dirname, 'whatsapp_log.csv');
const CATALOG_LOG_FILE = process.env.CATALOG_LOG_FILE || path.join(__dirname, 'catalog_log.csv');
const PDF_PATH = process.env.PDF_PATH || path.join(__dirname, config.business.catalogName);
const SESSION_PATH = process.env.SESSION_PATH || path.join(__dirname, 'session');
const SEND_DELAY = parseInt(process.env.SEND_DELAY) || 5000;
const COOLDOWN = parseInt(process.env.COOLDOWN) || 10000;
const NOTIFICATION_NUMBER = config.notifications.phoneNumber + '@c.us';
const ADMIN_NOTIFICATION_NUMBER = '8851165191@c.us'; // Admin alert number

// System health tracking
let systemHealth = {
  lastSuccessfulGoogleSheetsCall: null,
  lastSuccessfulWhatsAppSend: null,
  consecutiveFailures: 0,
  isOnline: false,
  lastOnlineTime: null,
  bootTime: new Date(),
  errors: []
};

// Create directories if they don't exist
if (!fs.existsSync(path.dirname(PDF_PATH))) fs.mkdirSync(path.dirname(PDF_PATH), { recursive: true });
if (!fs.existsSync(SESSION_PATH)) fs.mkdirSync(SESSION_PATH, { recursive: true });
if (!fs.existsSync(path.dirname(LOG_FILE))) fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

// Lock mechanism to prevent duplicate processing
const processingLocks = new Set();

// Message sending locks to prevent clashing
const messageSendingLocks = new Set();

// Track seen notifications to prevent duplicates
const seenNotifications = new Set();

// File operation locks to prevent conflicts
const fileLocks = {
  mainLog: false,
  catalogLog: false
};

// Memory cache for faster lookups
const memoryCache = {
  whatsappLogPhones: new Set(),
  catalogLogPhones: new Set(),
  lastWhatsappLogUpdate: 0,
  lastCatalogLogUpdate: 0,
  pdfBuffer: null,
  isInitialized: false
};

// Logging queue system
const logQueue = {
  main: [],
  catalog: [],
  isProcessing: false,
  isCatalogProcessing: false
};

// ---------------------- UTILITY FUNCTIONS ----------------------
function logWithTimestamp(message) {
  const now = new Date();
  const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  console.log(`[${timestamp}] ${message}`);
}

// ---------------------- MEMORY CACHE FUNCTIONS ----------------------
async function initializeMemoryCache() {
  try {
    console.log('[CACHE] Initializing memory cache...');
    
    // Pre-load PDF into memory
    if (fs.existsSync(PDF_PATH)) {
      memoryCache.pdfBuffer = await fs.promises.readFile(PDF_PATH);
      console.log('[CACHE] PDF loaded into memory');
    } else {
      console.log('[CACHE] PDF file not found, will load when available');
    }
    
    // Load WhatsApp log phones
    await updateWhatsAppLogCache();
    
    // Load catalog log phones  
    await updateCatalogLogCache();
    
    memoryCache.isInitialized = true;
    console.log('[CACHE] Memory cache initialized successfully');
  } catch (error) {
    console.error('[CACHE] Failed to initialize memory cache:', error);
    memoryCache.isInitialized = false;
  }
}

async function updateWhatsAppLogCache() {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    
    const stats = await fs.promises.stat(LOG_FILE);
    if (stats.mtime.getTime() <= memoryCache.lastWhatsappLogUpdate) return;
    
    memoryCache.whatsappLogPhones.clear();
    const logData = await fs.promises.readFile(LOG_FILE, 'utf8');
    const rows = logData.split('\n').slice(1); // Skip header
    
    for (const row of rows) {
      if (!row || row.trim() === '') continue;
      const columns = row.split(',');
      if (columns.length >= 4 && columns[0]) {
        memoryCache.whatsappLogPhones.add(normalizePhone(columns[0]));
      }
    }
    
    memoryCache.lastWhatsappLogUpdate = stats.mtime.getTime();
    console.log(`[CACHE] WhatsApp log cache updated: ${memoryCache.whatsappLogPhones.size} phones`);
  } catch (error) {
    console.error('[CACHE] Failed to update WhatsApp log cache:', error);
  }
}

async function updateCatalogLogCache() {
  try {
    if (!fs.existsSync(CATALOG_LOG_FILE)) return;
    
    const stats = await fs.promises.stat(CATALOG_LOG_FILE);
    if (stats.mtime.getTime() <= memoryCache.lastCatalogLogUpdate) return;
    
    memoryCache.catalogLogPhones.clear();
    const logData = await fs.promises.readFile(CATALOG_LOG_FILE, 'utf8');
    const rows = logData.split('\n').slice(1); // Skip header
    
    for (const row of rows) {
      if (!row || row.trim() === '') continue;
      const columns = row.split(',');
      if (columns.length >= 4 && columns[0] && columns[3] === 'Sent') {
        memoryCache.catalogLogPhones.add(normalizePhone(columns[0]));
      }
    }
    
    memoryCache.lastCatalogLogUpdate = stats.mtime.getTime();
    console.log(`[CACHE] Catalog log cache updated: ${memoryCache.catalogLogPhones.size} phones`);
  } catch (error) {
    console.error('[CACHE] Failed to update catalog log cache:', error);
  }
}

function normalizePhone(phone) {
  let phoneStr = String(phone).trim();

  // Handle scientific notation
  if (phoneStr.includes('E+') || phoneStr.includes('e+')) {
    try {
      phoneStr = parseFloat(phoneStr).toFixed(0);
    } catch (e) {
      console.error('Error converting scientific notation:', e);
    }
  }

  // Remove all non-digit characters except '+' at the beginning
  let digits = phoneStr.replace(/[^\d+]/g, '');

  // If the number starts with a '+', remove it for further processing
  if (digits.startsWith('+')) {
    digits = digits.substring(1);
  }

  // Handle Indian numbers: if it's 10 digits, prepend 91. If it's 12 digits and starts with 91, it's already correct.
  if (digits.length === 10) {
    return "91" + digits;
  } else if (digits.length === 12 && digits.startsWith('91')) {
    return digits;
  } else if (digits.length === 11 && digits.startsWith('0')) {
    return '91' + digits.substring(1);
  }

  // For other cases, return the cleaned number
  return digits;
}

async function isPhoneInLeads(phone) {
  try {
    const leads = await fetchLeads();
    const normalized = normalizePhone(phone);
    return leads.some(lead => normalizePhone(lead.phone) === normalized);
  } catch (error) {
    console.error('Error checking phone in leads:', error);
    return false;
  }
}

async function isPhoneInWhatsAppLog(phone) {
  try {
    const normalized = normalizePhone(phone);
    
    // Use memory cache if available and initialized
    if (memoryCache.isInitialized) {
      // Update cache if file changed
      await updateWhatsAppLogCache();
      return memoryCache.whatsappLogPhones.has(normalized);
    }
    
    // Fallback to file reading if cache not available
    if (!fs.existsSync(LOG_FILE)) return false;
    const sentPhones = await getSentPhones();
    return sentPhones.has(normalized);
  } catch (error) {
    console.error('Error checking phone in WhatsApp log:', error);
    return false;
  }
}

// ---------------------- LOGGING SYSTEM ----------------------
async function safeLogMessage(type, phone, name, status) {
  const now = new Date();
  const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  
  const entry = {
    type,
    data: {
      phone: normalizePhone(phone),
      name: String(name || '').replace(/,/g, ' ').replace(/\r?\n/g, ' ').trim(),
      timestamp,
      status
    }
  };

  if (type === 'main') {
    logQueue.main.push(entry);
  } else {
    logQueue.catalog.push(entry);
  }
  processLogQueue();
}

async function processLogQueue() {
  // Process main log
  if (!logQueue.isProcessing && logQueue.main.length > 0) {
    logQueue.isProcessing = true;
    
    // Wait for file lock to be available
    while (fileLocks.mainLog) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    fileLocks.mainLog = true;
    
    const entry = logQueue.main.shift();
    
    try {
      const { phone, name, timestamp, status } = entry.data;
      
      // Ensure proper newline handling
      let fileContent = '';
      const writeHeader = !fs.existsSync(LOG_FILE);
      
      if (writeHeader) {
        // Create new file with header
        fileContent = 'Phone,Name,Timestamp,Status\n';
        await fs.promises.writeFile(LOG_FILE, fileContent);
      } else {
        // Check if file ends with newline, if not add one
        try {
          const existingContent = await fs.promises.readFile(LOG_FILE, 'utf8');
          if (existingContent.length > 0 && !existingContent.endsWith('\n')) {
            await fs.promises.appendFile(LOG_FILE, '\n');
          }
        } catch (readError) {
          console.error('Error reading log file for newline check:', readError);
        }
      }
      
      // Create the new line entry (simple approach)
      const line = `${phone},${name},${timestamp},${status}\n`;
      await fs.promises.appendFile(LOG_FILE, line);
      
      // Log to terminal with timestamp
      logWithTimestamp(`📝 NEW RECORD ADDED to whatsapp_log.csv: ${name} (${phone}) - Status: ${status}`);
      
      // Update memory cache
      if (memoryCache.isInitialized) {
        memoryCache.whatsappLogPhones.add(normalizePhone(phone));
      }
      
    } catch (error) {
      console.error('Failed to write to log file:', error);
      logQueue.main.unshift(entry);
    } finally {
      fileLocks.mainLog = false;
      logQueue.isProcessing = false;
      processLogQueue();
    }
  }

  // Process catalog log
  if (!logQueue.isCatalogProcessing && logQueue.catalog.length > 0) {
    logQueue.isCatalogProcessing = true;
    
    // Wait for catalog file lock to be available
    while (fileLocks.catalogLog) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    fileLocks.catalogLog = true;
    
    const entry = logQueue.catalog.shift();
    
    try {
      const { phone, name, timestamp, status } = entry.data;
      
      // Ensure proper newline handling for catalog log
      const writeHeader = !fs.existsSync(CATALOG_LOG_FILE);
      if (writeHeader) {
        await fs.promises.writeFile(CATALOG_LOG_FILE, 'Phone,Name,Timestamp,Status\n');
      } else {
        // Check if file ends with newline, if not add one
        try {
          const existingContent = await fs.promises.readFile(CATALOG_LOG_FILE, 'utf8');
          if (existingContent.length > 0 && !existingContent.endsWith('\n')) {
            await fs.promises.appendFile(CATALOG_LOG_FILE, '\n');
          }
        } catch (readError) {
          console.error('Error reading catalog log file for newline check:', readError);
        }
      }
      
      // Create the new line entry (simple approach)
      const line = `${phone},${name},${timestamp},${status}\n`;
      await fs.promises.appendFile(CATALOG_LOG_FILE, line);
      
      // Log to terminal with timestamp
      logWithTimestamp(`📝 NEW RECORD ADDED to catalog_log.csv: ${name} (${phone}) - Status: ${status}`);
      
      // Update memory cache
      if (memoryCache.isInitialized && status === 'Sent') {
        memoryCache.catalogLogPhones.add(normalizePhone(phone));
      }
      
    } catch (error) {
      console.error('Failed to write to catalog log:', error);
      logQueue.catalog.unshift(entry);
    } finally {
      fileLocks.catalogLog = false;
      logQueue.isCatalogProcessing = false;
      processLogQueue();
    }
  }
}

// Initialize catalog log file if it doesn't exist
function initializeCatalogLog() {
  if (!fs.existsSync(CATALOG_LOG_FILE)) {
    fs.writeFileSync(CATALOG_LOG_FILE, 'Phone,Name,Timestamp,Status\n');
  } else {
    // Ensure existing file ends with newline
    try {
      const content = fs.readFileSync(CATALOG_LOG_FILE, 'utf8');
      if (content.length > 0 && !content.endsWith('\n')) {
        fs.appendFileSync(CATALOG_LOG_FILE, '\n');
      }
    } catch (error) {
      console.error('Error checking catalog log file newline:', error);
    }
  }
}

// Get phones that have received catalogs
async function getCatalogSentPhones() {
  if (!fs.existsSync(CATALOG_LOG_FILE)) return new Set();
  const catalogPhones = new Set();
  return new Promise((resolve, reject) => {
    fs.createReadStream(CATALOG_LOG_FILE)
      .pipe(csv())
      .on('data', (row) => {
        if (row.Phone && row.Status === 'Sent') {
          catalogPhones.add(normalizePhone(row.Phone));
        }
      })
      .on('end', () => resolve(catalogPhones))
      .on('error', (error) => reject(error));
  });
}

// Log catalog sent
async function logCatalogSent(phone, name) {
  await safeLogMessage('catalog', phone, name, "Sent");
}

async function getSentPhones(statusFilter = null) {
  if (!fs.existsSync(LOG_FILE)) return new Set();
  const sentPhones = new Set();
  return new Promise((resolve, reject) => {
    fs.createReadStream(LOG_FILE)
      .pipe(csv())
      .on('data', (row) => {
        if (row.Phone && (!statusFilter || row.Status === statusFilter)) {
          sentPhones.add(normalizePhone(row.Phone));
        }
      })
      .on('end', () => resolve(sentPhones))
      .on('error', (error) => reject(error));
  });
}

async function logSentMessage(phone, name, status = "Sent") {
  await safeLogMessage('main', phone, name, status);
}

async function fetchLeads() {
  try {
    const sheets = google.sheets({ version: 'v4', auth: API_KEY });
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: RANGE
    });
    
    // Mark successful Google Sheets call
    systemHealth.lastSuccessfulGoogleSheetsCall = new Date();
    systemHealth.consecutiveFailures = 0;
    
    const data = response.data.values || [];
    if (data.length < 2) return [];
    
    const captureDateIndex = 2; // Column D (0-based index)
    const nameIndex = 3;         // Column E
    const phoneIndex = 4;        // Column F
    
    // Filter date from configuration
    const filterDate = new Date(config.filtering.startDate);
    
    return data.slice(1).map(row => {
      const captureDate = row[captureDateIndex]?.toString().trim() || '';
      const name = row[nameIndex]?.toString().trim() || '';
      const phone = row[phoneIndex]?.toString().trim() || '';
      
      return {
        captureDate,
        name,
        phone
      };
    }).filter(lead => {
      // Basic validation
      if (!lead.name || !lead.phone) return false;
      
      // Date filtering
      if (!lead.captureDate) {
        console.log(`[FILTER] Skipping lead ${lead.name} - no capture date`);
        return false;
      }
      
      try {
        // Parse date format: "85/07/2025 00:39:00" 
        // Assuming first part might be day, let's try different parsing
        let leadDate;
        
        if (lead.captureDate.includes('/')) {
          // Try to parse the date - handle the "85" which might be a typo for day
          const parts = lead.captureDate.split(' ')[0]; // Get date part only
          const dateParts = parts.split('/');
          
          if (dateParts.length === 3) {
            // Assume format is DD/MM/YYYY or MM/DD/YYYY
            const day = parseInt(dateParts[0]);
            const month = parseInt(dateParts[1]);
            const year = parseInt(dateParts[2]);
            
            // Handle case where day might be > 31 (like 85), treat as invalid
            if (day > 31) {
              console.log(`[FILTER] Skipping lead ${lead.name} - invalid date format: ${lead.captureDate}`);
              return false;
            }
            
            // Create date object (month is 0-based in JS)
            leadDate = new Date(year, month - 1, day);
          } else {
            console.log(`[FILTER] Skipping lead ${lead.name} - unparseable date: ${lead.captureDate}`);
            return false;
          }
        } else {
          // Try direct parsing
          leadDate = new Date(lead.captureDate);
        }
        
        // Check if date is valid
        if (isNaN(leadDate.getTime())) {
          console.log(`[FILTER] Skipping lead ${lead.name} - invalid date: ${lead.captureDate}`);
          return false;
        }
        
        // Check if lead date is >= July 15, 2025
        if (leadDate >= filterDate) {
          console.log(`[FILTER] ✅ Including lead ${lead.name} - date: ${lead.captureDate} (${leadDate.toDateString()})`);
          return true;
        } else {
          console.log(`[FILTER] ❌ Excluding lead ${lead.name} - date: ${lead.captureDate} (${leadDate.toDateString()}) is before July 15, 2025`);
          return false;
        }
        
      } catch (error) {
        console.log(`[FILTER] Skipping lead ${lead.name} - date parsing error: ${lead.captureDate}`);
        return false;
      }
    });
  } catch (error) {
    console.error('Google Sheets error:', error.message);
    
    // Track Google Sheets failure
    systemHealth.consecutiveFailures++;
    systemHealth.errors.push({
      type: 'Google Sheets',
      message: error.message,
      timestamp: new Date()
    });
    
    // Send alert if multiple consecutive failures
    if (systemHealth.consecutiveFailures >= 3) {
      await sendSystemAlert('Google Sheets connection failed multiple times', error.message);
    }
    
    return [];
  }
}

// ---------------------- WHATSAPP CLIENT ----------------------
let client = null;
let qrCode = null;
let status = "disconnected";
let processing = false;
let processInterval = null;
const processingSeenStatus = new Set();

// System alert and recovery notification functions
async function sendSystemAlert(alertType, details) {
  try {
    if (!client || status !== "ready") {
      console.log(`[SYSTEM ALERT] Cannot send alert - WhatsApp not ready: ${alertType}`);
      return;
    }

    const alertMessage = `🚨 SYSTEM ALERT - ${config.business.name} Bot\n\n` +
      `Alert: ${alertType}\n` +
      `Time: ${new Date().toLocaleString()}\n` +
      `Details: ${details}\n\n` +
      `Bot Status: ${status}\n` +
      `Consecutive Failures: ${systemHealth.consecutiveFailures}\n` +
      `Last Successful Google Sheets: ${systemHealth.lastSuccessfulGoogleSheetsCall ? systemHealth.lastSuccessfulGoogleSheetsCall.toLocaleString() : 'Never'}\n` +
      `Last Successful WhatsApp Send: ${systemHealth.lastSuccessfulWhatsAppSend ? systemHealth.lastSuccessfulWhatsAppSend.toLocaleString() : 'Never'}`;

    await client.sendMessage(ADMIN_NOTIFICATION_NUMBER, alertMessage);
    console.log(`[SYSTEM ALERT] Sent alert to admin: ${alertType}`);
  } catch (error) {
    console.error(`[SYSTEM ALERT ERROR] Failed to send alert: ${error.message}`);
  }
}

async function sendRecoveryNotification() {
  try {
    if (!client || status !== "ready") return;

    const recoveryMessage = `✅ SYSTEM RECOVERY - ${config.business.name} Bot\n\n` +
      `Bot is back online and operational!\n` +
      `Recovery Time: ${new Date().toLocaleString()}\n` +
      `Downtime: ${systemHealth.lastOnlineTime ? Math.round((new Date() - systemHealth.lastOnlineTime) / 1000 / 60) : 'Unknown'} minutes\n\n` +
      `System Status:\n` +
      `✅ WhatsApp: Connected\n` +
      `✅ Google Sheets: ${systemHealth.lastSuccessfulGoogleSheetsCall ? 'Working' : 'Testing...'}\n` +
      `✅ Processing: Ready\n\n` +
      `Bot will resume normal operations.`;

    await client.sendMessage(ADMIN_NOTIFICATION_NUMBER, recoveryMessage);
    console.log(`[RECOVERY] Sent recovery notification to admin`);
  } catch (error) {
    console.error(`[RECOVERY ERROR] Failed to send recovery notification: ${error.message}`);
  }
}

async function checkSystemHealth() {
  const now = new Date();
  
  // Check if system was offline and is now online
  if (!systemHealth.isOnline && status === "ready") {
    systemHealth.isOnline = true;
    if (systemHealth.lastOnlineTime) {
      await sendRecoveryNotification();
    }
    systemHealth.lastOnlineTime = now;
  }
  
  // Check if system went offline
  if (systemHealth.isOnline && status !== "ready") {
    systemHealth.isOnline = false;
    systemHealth.lastOnlineTime = now;
    await sendSystemAlert('WhatsApp Connection Lost', `Bot status changed to: ${status}`);
  }
  
  // Check for prolonged Google Sheets failures
  if (systemHealth.lastSuccessfulGoogleSheetsCall) {
    const timeSinceLastSuccess = now - systemHealth.lastSuccessfulGoogleSheetsCall;
    const minutesSinceSuccess = timeSinceLastSuccess / 1000 / 60;
    
    if (minutesSinceSuccess > 30) { // 30 minutes without successful call
      await sendSystemAlert('Google Sheets Connection Issue', `No successful calls for ${Math.round(minutesSinceSuccess)} minutes`);
    }
  }
}

function initializeWhatsApp() {
  initializeCatalogLog();
  
  // Initialize memory cache for faster performance
  initializeMemoryCache();
  
  client = new Client({
    authStrategy: new LocalAuth({ clientId: 'whatsapp-client', dataPath: SESSION_PATH }),
    puppeteer: { 
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
  });

  client.on('qr', (qr) => {
    qrCode = qr;
    status = "qr_pending";
    console.log('QR RECEIVED');
  });

  client.on('authenticated', () => {
    qrCode = null;
    status = "authenticated";
  });

  client.on('ready', () => {
    status = "ready";
    console.log('Client is ready!');
    // processLeads(); // Commented out to prevent double messages - only start manually
  });

  client.on('disconnected', () => {
    status = "disconnected";
    console.log('Client disconnected');
  });
  // Handle incoming messages from customers
  client.on('message', async (msg) => {
    // Skip messages from self and groups
    if (msg.fromMe) return;
    
    try {
      const chat = await msg.getChat();
      if (chat.isGroup) return;
    } catch (error) {
      console.error('[ERROR] Failed to get chat for incoming message:', error);
      return;
    }
    
    // Extract phone number for logging
    const phone = msg.from.split('@')[0];
    
    // Note: Manual PDF requests removed - catalogs are sent automatically with welcome messages
    console.log(`[MESSAGE] Received message from ${phone}: "${msg.body}"`);
  });

  // Note: Message read receipt tracking removed - no longer tracking who seen messages

  client.initialize();
}

// ---------------------- MESSAGE SENDING ----------------------
function composeMessage(name) {
  return config.messages.welcomeTemplate
    .replace('{name}', name)
    .replace('{businessName}', config.business.name);
}

async function sendCatalog(phone) {
  if (!client || status !== "ready") {
    throw new Error("WhatsApp client not ready");
  }

  const catalogCaption = config.messages.catalogCaption
    .replace('{businessName}', config.business.name)
    .replace('{productType}', config.business.productType);

  // Send PDF with caption using memory buffer for speed
  if (memoryCache.pdfBuffer) {
    const media = new MessageMedia('application/pdf', memoryCache.pdfBuffer.toString('base64'), config.business.catalogName);
    await client.sendMessage(`${phone}@c.us`, media, { 
      caption: catalogCaption
    });
  } else if (fs.existsSync(PDF_PATH)) {
    // Fallback to file reading if buffer not available
    const media = MessageMedia.fromFilePath(PDF_PATH);
    await client.sendMessage(`${phone}@c.us`, media, { 
      caption: catalogCaption
    });
  } else {
    await client.sendMessage(`${phone}@c.us`, catalogCaption);
    console.error('PDF file not found, sent text only.');
  }
}

async function sendWelcomeMessage(phone, name) {
  if (!client || status !== "ready") {
    throw new Error("WhatsApp client not ready");
  }
  await client.sendMessage(`${phone}@c.us`, composeMessage(name));
}

async function sendWelcomeWithCatalog(phone, name) {
  if (!client || status !== "ready") {
    throw new Error("WhatsApp client not ready");
  }

  const normalizedPhone = normalizePhone(phone);
  
  // Prevent multiple simultaneous sends to same number
  if (messageSendingLocks.has(normalizedPhone)) {
    console.log(`[CLASH PREVENTION] Already sending messages to ${normalizedPhone}, skipping to prevent clash`);
    return;
  }
  
  messageSendingLocks.add(normalizedPhone);
  
  try {
    // Check what has already been sent to avoid duplicates
    const sentPhones = await getSentPhones();
    const catalogSentPhones = await getCatalogSentPhones();
    
    const welcomeAlreadySent = sentPhones.has(normalizedPhone);
    const catalogAlreadySent = catalogSentPhones.has(normalizedPhone);
    
    console.log(`[SMART SEND] ${name} (${normalizedPhone}) - Welcome: ${welcomeAlreadySent ? 'SENT' : 'PENDING'}, Catalog: ${catalogAlreadySent ? 'SENT' : 'PENDING'}`);
    
    let welcomeSent = false;
    let catalogSent = false;
    
    // Send welcome message only if not already sent
    if (!welcomeAlreadySent) {
      try {
        console.log(`[WELCOME] Sending welcome message to ${name} (${normalizedPhone})`);
        await client.sendMessage(`${normalizedPhone}@c.us`, composeMessage(name));
        await logSentMessage(normalizedPhone, name, "Sent");
        systemHealth.lastSuccessfulWhatsAppSend = new Date();
        welcomeSent = true;
        
        // Wait before sending catalog to avoid message clash
        await new Promise(resolve => setTimeout(resolve, 3000));
      } catch (welcomeError) {
        console.error(`[WELCOME ERROR] Failed to send welcome to ${normalizedPhone}: ${welcomeError.message}`);
        // Continue to try catalog even if welcome fails
      }
    } else {
      console.log(`[WELCOME] Skipping welcome message for ${name} (${normalizedPhone}) - already sent`);
      // Shorter wait if welcome already sent
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Send catalog only if not already sent
    if (!catalogAlreadySent) {
      try {
        console.log(`[CATALOG] Sending catalog to ${name} (${normalizedPhone})`);
        
        const catalogCaption = config.messages.catalogCaption
          .replace('{businessName}', config.business.name)
          .replace('{productType}', config.business.productType);

        // Send PDF with caption using memory buffer for speed
        if (memoryCache.pdfBuffer) {
          const media = new MessageMedia('application/pdf', memoryCache.pdfBuffer.toString('base64'), config.business.catalogName);
          await client.sendMessage(`${normalizedPhone}@c.us`, media, { 
            caption: catalogCaption
          });
        } else if (fs.existsSync(PDF_PATH)) {
          // Fallback to file reading if buffer not available
          const media = MessageMedia.fromFilePath(PDF_PATH);
          await client.sendMessage(`${normalizedPhone}@c.us`, media, { 
            caption: catalogCaption
          });
        } else {
          await client.sendMessage(`${normalizedPhone}@c.us`, catalogCaption);
          console.error('PDF file not found, sent text only.');
        }
        
        await logCatalogSent(normalizedPhone, name);
        catalogSent = true;
      } catch (catalogError) {
        console.error(`[CATALOG ERROR] Failed to send catalog to ${normalizedPhone}: ${catalogError.message}`);
        // If catalog fails but welcome succeeded, we'll retry catalog next time
        if (welcomeSent) {
          console.log(`[RECOVERY] Welcome sent but catalog failed for ${normalizedPhone} - will retry catalog only next time`);
        }
        throw catalogError; // Re-throw to trigger retry logic
      }
    } else {
      console.log(`[CATALOG] Skipping catalog for ${name} (${normalizedPhone}) - already sent`);
    }
    
    // Success summary
    if (welcomeSent || catalogSent) {
      const actions = [];
      if (welcomeSent) actions.push('welcome');
      if (catalogSent) actions.push('catalog');
      console.log(`[SUCCESS] Sent ${actions.join(' + ')} to ${name} (${normalizedPhone})`);
    }
    
  } finally {
    // Always release the lock
    messageSendingLocks.delete(normalizedPhone);
  }
}

async function processLeads() {
  // Prevent multiple simultaneous processing
  if (processLeads.isRunning) {
    console.log('⚠️ Lead processing already running. Skipping this cycle.');
    return;
  }
  
  processLeads.isRunning = true;
  console.log('Starting lead processing cycle...');
  
  // Safety check - don't process if client is not ready
  if (!client || status !== "ready") {
    console.log('⚠️ WhatsApp client not ready. Skipping processing cycle.');
    processLeads.isRunning = false;
    return;
  }
  
  let isCurrentlyRunning = true;

  try {
    const leads = await fetchLeads();
    
    // Always get fresh data to prevent duplicates
    const sentPhones = await getSentPhones();
    const catalogSentPhones = await getCatalogSentPhones();
    
    console.log(`📊 Found ${leads.length} leads, ${sentPhones.size} already sent, ${catalogSentPhones.size} catalogs sent`);

    // First pass: Process new leads (send welcome message if not sent)
    for (const lead of leads) {
      if (!processing) {
        console.log('Processing stopped by user.');
        isCurrentlyRunning = false;
        break;
      }
      
      const normalizedPhone = normalizePhone(lead.phone);
      
      // Skip if currently being processed
      if (processingLocks.has(normalizedPhone)) {
        console.log(`⏭️ Skipping ${lead.name} (${lead.phone}) - already being processed`);
        continue;
      }
      
      // Skip if already sent welcome message
      if (sentPhones.has(normalizedPhone)) {
        console.log(`⏭️ Skipping ${lead.name} (${lead.phone}) - welcome already sent`);
        continue;
      }
      
      // Add processing lock
      processingLocks.add(normalizedPhone);
      
      try {
        // Smart sending with duplicate prevention
        console.log(`Processing lead: ${lead.name} (${lead.phone})`);
        await sendWelcomeWithCatalog(lead.phone, lead.name);
        
        // Update local cache to prevent immediate re-processing
        sentPhones.add(normalizedPhone);
        console.log(`✅ Processing completed for ${lead.phone}`);
      } catch (error) {
        let status = "Failed";
        const errorMsg = error.message.toLowerCase();
        if (errorMsg.includes('not registered') || 
            errorMsg.includes('invalid number') ||
            errorMsg.includes('incorrect number')) {
          status = "Invalid";
        }
        await logSentMessage(lead.phone, lead.name, status);
        sentPhones.add(normalizedPhone);
        console.error(`❌ Failed to send welcome message to ${lead.phone}: ${error.message}`);
      } finally {
        // Always remove processing lock
        processingLocks.delete(normalizedPhone);
      }
      
      // Add delay between messages
      await new Promise(resolve => setTimeout(resolve, SEND_DELAY));
      if (!processing) break;
    }

    // Note: Catalogs are now sent with welcome messages when sendCatalog = Yes
    // No separate second pass needed
  } catch (error) {
    console.error('Processing error:', error);
  } finally {
    if (isCurrentlyRunning) {
      console.log('Finished lead processing cycle.');
    }
    // Always clear the running flag
    processLeads.isRunning = false;
  }
}

function startProcessingLoop() {
  // Clear any existing interval first
  if (processInterval) {
    clearInterval(processInterval);
    processInterval = null;
    console.log('Cleared existing processing interval');
  }
  
  // Only start new interval if processing is active
  if (processing) {
    processInterval = setInterval(async () => {
      if (processing && status === "ready") {
        console.log("\n🔍 Checking leads (periodic)...");
        await processLeads();
      }
    }, 300000); // 5 minutes
    console.log('Started new processing interval');
  }
}

// ---------------------- EXPRESS SERVER ----------------------
app.use(express.json());
app.use(express.static('public', {
  maxAge: '1d', // Cache static files for 1 day
  etag: true
}));

// File upload for PDF
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, path.dirname(PDF_PATH));
  },
  filename: (req, file, cb) => {
    cb(null, path.basename(PDF_PATH));
  }
});

const upload = multer({ storage });

app.post('/upload-pdf', upload.single('pdf'), (req, res) => {
  res.json({ success: true, message: 'PDF uploaded successfully' });
});

app.get('/status', (req, res) => {
  res.json({ status, qrCode, processing });
});

app.get('/config', (req, res) => {
  res.json(config);
});

app.post('/start', (req, res) => {
  if (processing) {
    return res.status(400).json({ error: "Processing is already in progress" });
  }
  
  if (status !== "ready") {
    return res.status(400).json({ error: "WhatsApp client not ready" });
  }
  
  console.log('--- START REQUEST RECEIVED ---');
  processing = true;
  
  // Clear any existing interval to prevent duplicates
  if (processInterval) {
    clearInterval(processInterval);
    processInterval = null;
  }
  
  // Start immediate processing and then set up interval
  processLeads();
  startProcessingLoop();
  
  res.json({ success: true, message: "Processing started" });
});

app.post('/stop', (req, res) => {
  if (!processing) {
    return res.status(400).json({ error: "Processing is not currently in progress" });
  }

  console.log('--- STOP REQUEST RECEIVED ---');
  processing = false;
  if (processInterval) {
    clearInterval(processInterval);
    console.log('Processing interval cleared.');
  }
  res.json({ success: true, message: "Processing stopped" });
});

app.post('/reset', async (req, res) => {
  console.log('--- RESET REQUEST RECEIVED ---');

  // Stop any ongoing processing
  processing = false;
  if (processInterval) {
    clearInterval(processInterval);
    processInterval = null;
    console.log('Processing interval cleared for reset.');
  }

  if (client) {
    console.log('Destroying WhatsApp client...');
    try {
      await client.destroy();
      client = null;
      console.log('WhatsApp client destroyed.');
    } catch (destroyError) {
      console.error('Error during client destruction:', destroyError);
      // Still attempt to continue with the reset
    }
  }

  // Wait for a moment to allow file locks to be released
  console.log('Waiting for 2 seconds to release file locks...');
  await new Promise(resolve => setTimeout(resolve, 2000));

  try {
    console.log(`Attempting to delete session folder: ${SESSION_PATH}`);
    if (fs.existsSync(SESSION_PATH)) {
      await fs.promises.rm(SESSION_PATH, { recursive: true, force: true });
      console.log('Session folder deleted successfully.');
    }
    await fs.promises.mkdir(SESSION_PATH, { recursive: true });
    console.log('Session folder recreated successfully.');

    // Clear notification tracking
    seenNotifications.clear();

    console.log('Re-initializing WhatsApp client...');
    initializeWhatsApp();
    res.json({ success: true, message: "Session reset successfully and client is re-initializing." });

  } catch (error) {
    console.error(`FATAL: Failed to reset session directory at ${SESSION_PATH}.`, error);
    res.status(500).json({ 
      success: false, 
      message: `Failed to delete session folder. Please check terminal logs. You may need to stop the bot and manually delete the folder: ${SESSION_PATH}` 
    });
  }
});

app.get('/api/analytics', async (req, res) => {
  const { startDate, endDate } = req.query;
  if (!fs.existsSync(LOG_FILE)) {
    return res.json({ 
      totalSent: 0, 
      totalSeen: 0, 
      viewRate: 0, 
      averageTimeToSee: 0, 
      totalCatalogs: 0,
      totalFailed: 0,
      uniqueRecipients: 0,
      mostActiveHour: '-',
      timeline: [],
      logs: [],
      hourlyTrend: [],
      statusBreakdown: {},
      topRecipients: [],
      topEngagedRecipients: [],
      inactiveRecipients: [],
      catalogStats: {}
    });
  }

  try {
    // Read main log data
    const logData = await fs.promises.readFile(LOG_FILE, 'utf8');
    const rows = logData.split('\n').slice(1); // Skip header
    let logs = [];
    let hourCount = {};
    let uniquePhones = new Set();
    let totalFailed = 0;
    let statusBreakdown = { Sent: 0, Seen: 0, Failed: 0, Invalid: 0 };
    let recipientCount = {};
    let engagedCount = {};
    let allPhones = new Set();
    
    for (const row of rows) {
      if (!row || row.trim() === '') continue;
      const columns = row.split(',');
      while (columns.length < 6) columns.push('');
      const [phone, name, timestamp, status, seenTimestamp, timeToSee] = columns;
      logs.push({
        phone,
        name,
        timestamp,
        status,
        seenTimestamp,
        timeToSee: parseInt(timeToSee) || null
      });
      uniquePhones.add(phone);
      allPhones.add(phone);
      // Status breakdown
      if (statusBreakdown[status] !== undefined) statusBreakdown[status]++;
      // Top recipients (count all messages sent to phone)
      if (!recipientCount[phone]) recipientCount[phone] = 0;
      if (status === 'Sent' || status === 'Seen') recipientCount[phone]++;
      // Top engaged recipients (count only Seen)
      if (!engagedCount[phone]) engagedCount[phone] = 0;
      if (status === 'Seen') engagedCount[phone]++;
      // Inactive recipients (never seen)
      // Count hour for hourly trend
      if (timestamp) {
        const hour = new Date(timestamp).getHours();
        hourCount[hour] = (hourCount[hour] || 0) + 1;
      }
      if (status === 'Failed' || status === 'Invalid') totalFailed++;
    }

    // Read catalog log data
    let catalogLogs = [];
    if (fs.existsSync(CATALOG_LOG_FILE)) {
      const catalogData = await fs.promises.readFile(CATALOG_LOG_FILE, 'utf8');
      const catalogRows = catalogData.split('\n').slice(1); // Skip header
      for (const row of catalogRows) {
        if (!row || row.trim() === '') continue;
        const columns = row.split(',');
        if (columns.length < 4) continue;
        const [phone, name, timestamp, status] = columns;
        catalogLogs.push({ phone, name, timestamp, status });
      }
    }

    if (startDate && endDate) {
      // Parse dates in local timezone (IST) to avoid timezone shift
      const start = new Date(startDate + 'T00:00:00');
      const end = new Date(endDate + 'T23:59:59');
      
      logs = logs.filter(log => {
        const logDate = new Date(log.timestamp);
        return logDate >= start && logDate <= end;
      });
      catalogLogs = catalogLogs.filter(log => {
        const logDate = new Date(log.timestamp);
        return logDate >= start && logDate <= end;
      });
    }

    const catalogPhones = new Set(catalogLogs.map(log => log.phone));

    const totalSent = logs.filter(log => log.status === 'Sent' || log.status === 'Seen').length;
    const totalSeen = logs.filter(log => log.status === 'Seen').length;
    const viewRate = totalSent > 0 ? (totalSeen / totalSent) * 100 : 0;
    const totalTimeToSee = logs.filter(log => log.status === 'Seen' && log.timeToSee !== null)
      .reduce((acc, log) => acc + log.timeToSee, 0);
    const averageTimeToSee = totalSeen > 0 ? totalTimeToSee / totalSeen : 0;

    // Generate timeline data for charts (array of {date, sent, seen})
    const dailyData = {};
    logs.forEach(log => {
      const date = new Date(log.timestamp).toLocaleDateString();
      if (!dailyData[date]) {
        dailyData[date] = { sent: 0, seen: 0 };
      }
      if (log.status === 'Sent' || log.status === 'Seen') {
        dailyData[date].sent++;
      }
      if (log.status === 'Seen') {
        dailyData[date].seen++;
      }
    });
    const sortedDates = Object.keys(dailyData).sort((a, b) => new Date(a) - new Date(b));
    const timeline = sortedDates.map(date => ({ date, sent: dailyData[date].sent, seen: dailyData[date].seen }));

    // Most active hour
    let mostActiveHour = '-';
    if (Object.keys(hourCount).length > 0) {
      const maxHour = Object.keys(hourCount).reduce((a, b) => hourCount[a] > hourCount[b] ? a : b);
      mostActiveHour = `${maxHour}:00 - ${parseInt(maxHour) + 1}:00`;
    }

    // Hourly trend (array of {hour, count})
    const hourlyTrend = Array.from({length: 24}, (_, h) => ({ hour: `${h}:00`, count: hourCount[h] || 0 }));

    // Top recipients (sorted by messages received)
    const topRecipients = Object.entries(recipientCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([phone, count]) => ({ phone, count }));
    // Top engaged recipients (sorted by seen count)
    const topEngagedRecipients = Object.entries(engagedCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([phone, count]) => ({ phone, count }));
    // Inactive recipients (received but never seen)
    const inactiveRecipients = Object.keys(recipientCount)
      .filter(phone => !engagedCount[phone])
      .map(phone => ({ phone, count: recipientCount[phone] }));

    // Catalog stats
    const catalogStats = {
      sent: catalogPhones.size,
      notSent: uniquePhones.size - catalogPhones.size,
      viewed: 0, // Placeholder for future implementation
      conversionRate: 0, // Placeholder for future implementation
      avgViewTime: 0 // Placeholder for future implementation
    };

    res.json({ 
      totalSent, 
      totalSeen, 
      viewRate: viewRate.toFixed(2), 
      averageTimeToSee: averageTimeToSee.toFixed(2),
      totalCatalogs: catalogLogs.length,
      totalFailed,
      uniqueRecipients: uniquePhones.size,
      mostActiveHour,
      logs,
      timeline,
      hourlyTrend,
      statusBreakdown,
      topRecipients,
      topEngagedRecipients,
      inactiveRecipients,
      catalogStats
    });
  } catch (error) {
    res.status(500).json({ error: "Failed to read or process logs" });
  }
});

app.get('/logs', (req, res) => {
  const { startDate, endDate } = req.query;
  if (!fs.existsSync(LOG_FILE)) {
    return res.json([]);
  }
  
  try {
    const logData = fs.readFileSync(LOG_FILE, 'utf8');
    let logs = [];
    const rows = logData.split('\n').slice(1); // Skip header
    
    for (const row of rows) {
      if (!row || row.trim() === '') continue;
      
      const columns = row.split(',');
      if (columns.length < 4) {
        console.log(`[WARN] Skipping malformed row in logs: ${row}`);
        continue;
      }
      
      const [phone, name, timestamp, status] = columns;
      logs.push({ phone, name, timestamp, status });
    }

    if (startDate && endDate) {
      // Parse dates in local timezone (IST) to avoid timezone shift
      const start = new Date(startDate + 'T00:00:00');
      const end = new Date(endDate + 'T23:59:59');
      
      logs = logs.filter(log => {
        if (!log.timestamp) return false;
        const logDate = new Date(log.timestamp);
        return logDate >= start && logDate <= end;
      });
    }
    
    res.json(logs);

  } catch (error) {
    res.status(500).json({ error: "Failed to read logs" });
  }
});

app.get('/catalog-logs', async (req, res) => {
  if (!fs.existsSync(CATALOG_LOG_FILE)) {
    return res.json([]);
  }
  
  try {
    const catalogData = await fs.promises.readFile(CATALOG_LOG_FILE, 'utf8');
    const logs = [];
    const rows = catalogData.split('\n').slice(1); // Skip header
    
    for (const row of rows) {
      if (!row || row.trim() === '') continue;
      
      const columns = row.split(',');
      if (columns.length < 4) continue;
      
      const [phone, name, timestamp, status] = columns;
      logs.push({ phone, name, timestamp, status });
    }
    
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: "Failed to read catalog logs" });
  }
});

// Start server and WhatsApp client
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  initializeWhatsApp();
  // Don't auto-start processing loop - only start when user clicks "Start"
});