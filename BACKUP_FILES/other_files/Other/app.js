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

// ---------------------- CONFIG ----------------------
const API_KEY = process.env.GOOGLE_API_KEY;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const RANGE = process.env.RANGE || "'Sales FMS'!C8:Z1000";
const LOG_FILE = process.env.LOG_FILE || path.join(__dirname, 'whatsapp_log.csv');
const CATALOG_LOG_FILE = process.env.CATALOG_LOG_FILE || path.join(__dirname, 'catalog_log.csv');
const PDF_PATH = process.env.PDF_PATH || path.join(__dirname, 'Basins by Carolieto.pdf');
const SESSION_PATH = process.env.SESSION_PATH || path.join(__dirname, 'session');
const SEND_DELAY = parseInt(process.env.SEND_DELAY) || 5000;
const COOLDOWN = parseInt(process.env.COOLDOWN) || 10000;
const NOTIFICATION_NUMBER = '919718889070@c.us';

// Create directories if they don't exist
if (!fs.existsSync(path.dirname(PDF_PATH))) fs.mkdirSync(path.dirname(PDF_PATH), { recursive: true });
if (!fs.existsSync(SESSION_PATH)) fs.mkdirSync(SESSION_PATH, { recursive: true });
if (!fs.existsSync(path.dirname(LOG_FILE))) fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

// Lock mechanism to prevent duplicate processing
const processingLocks = new Set();

// Track seen notifications to prevent duplicates
const seenNotifications = new Set();

// File operation locks to prevent conflicts
const fileLocks = {
  mainLog: false,
  catalogLog: false
};

// Logging queue system
const logQueue = {
  main: [],
  catalog: [],
  isProcessing: false,
  isCatalogProcessing: false
};

// ---------------------- UTILITY FUNCTIONS ----------------------
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
  
  // Remove all non-digit characters
  let digits = phoneStr.replace(/\D/g, '');
  
  // Handle Indian numbers without country code
  if (digits.length === 10) return "91" + digits;
  
  // Handle numbers with leading zero
  if (digits.startsWith("0")) {
    digits = digits.substring(1);
    if (digits.length === 10) return "91" + digits;
  }
  
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

// ---------------------- LOGGING SYSTEM ----------------------
async function safeLogMessage(type, phone, name, status, seenTimestamp = '', timeToSee = '') {
  const now = new Date();
  const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
  const lastUpdated = timestamp; // Record when this entry was created/updated
  
  const entry = {
    type,
    data: {
      phone: normalizePhone(phone),
      name: String(name || '').replace(/,/g, ' ').replace(/\r?\n/g, ' ').trim(),
      timestamp,
      status,
      seenTimestamp,
      timeToSee,
      lastUpdated
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
      const { phone, name, timestamp, status, seenTimestamp, timeToSee, lastUpdated } = entry.data;
      
      // Ensure proper newline handling
      let fileContent = '';
      const writeHeader = !fs.existsSync(LOG_FILE);
      
      if (writeHeader) {
        // Create new file with header
        fileContent = 'Phone,Name,Timestamp,Status,SeenTimestamp,TimeToSee,LastUpdated\n';
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
      
      // Create the new line entry
      const line = `${phone},${name},${timestamp},${status},${seenTimestamp},${timeToSee},${lastUpdated}\n`;
      await fs.promises.appendFile(LOG_FILE, line);
      
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
      
      // Create the new line entry
      const line = `${phone},${name},${timestamp},${status}\n`;
      await fs.promises.appendFile(CATALOG_LOG_FILE, line);
      
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

async function updateLogWithSeenStatus(phone) {
  const normalizedPhone = normalizePhone(phone);

  if (processingSeenStatus.has(normalizedPhone)) {
    console.log(`[DEBUG] Already processing seen status for ${normalizedPhone}. Skipping.`);
    return;
  }

  // Wait for file lock to be available
  while (fileLocks.mainLog) {
    console.log(`[DEBUG] Waiting for file lock for ${normalizedPhone}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  fileLocks.mainLog = true;
  processingSeenStatus.add(normalizedPhone);
  console.log(`[DEBUG] updateLogWithSeenStatus called for: ${normalizedPhone}`);

  try {
    if (!fs.existsSync(LOG_FILE)) {
      console.log('[DEBUG] Log file not found. Skipping seen update.');
      return;
    }

    const logData = await fs.promises.readFile(LOG_FILE, 'utf8');
    const rows = logData.split('\n');
    const header = rows[0];
    let newRows = [header];
    let customerName = null;
    let updated = false;
    let alreadySeen = false;

    // First pass: Check if we've already notified for this phone
    if (seenNotifications.has(normalizedPhone)) {
      console.log(`[INFO] Already sent seen notification for ${normalizedPhone}. Skipping.`);
      alreadySeen = true;
    }

    for (let i = 1; i < rows.length; i++) {
      if (!rows[i] || rows[i].trim() === '') continue;
      
      const columns = rows[i].split(',');
      while (columns.length < 6) columns.push('');
      
      const [logPhone, name, timestamp, status] = columns;
      const rowPhone = normalizePhone(logPhone);
      
      if (rowPhone === normalizedPhone) {
        // Check if we've already processed a seen notification
        if (status === 'Seen') {
          alreadySeen = true;
        }
        
        if (status === 'Sent' && !updated && !alreadySeen) {
          // Update the most recent "Sent" entry to "Seen"
          const now = new Date();
          const seenTimestampValue = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
          const timeToSeeValue = Math.round((now - new Date(timestamp)) / 1000);
          const lastUpdatedValue = seenTimestampValue; // Record when this update happened
          
          // Check if row has LastUpdated column (for backward compatibility)
          const columns = rows[i].split(',');
          const hasLastUpdatedColumn = columns.length >= 7;
          
          // Update the row directly instead of queuing new entry
          const updatedRow = hasLastUpdatedColumn ? 
            `${logPhone},${name},${timestamp},Seen,${seenTimestampValue},${timeToSeeValue},${lastUpdatedValue}` :
            `${logPhone},${name},${timestamp},Seen,${seenTimestampValue},${timeToSeeValue}`;
          newRows.push(updatedRow);
          
          customerName = name;
          updated = true;
          seenNotifications.add(normalizedPhone); // Mark as notified
          console.log(`[DEBUG] Updated row for ${normalizedPhone} from Sent to Seen at ${lastUpdatedValue}`);
        } else {
          newRows.push(rows[i]);
        }
      } else {
        newRows.push(rows[i]);
      }
    }

    if (updated) {
      // Write the updated content back to the file
      const updatedContent = newRows.join('\n') + '\n';
      await fs.promises.writeFile(LOG_FILE, updatedContent);
      console.log(`[SUCCESS] Updated log file for ${normalizedPhone} to Seen`);
      
      // Only send notification if phone is in leads and not already notified
      if (customerName && !alreadySeen && await isPhoneInLeads(phone)) {
        await sendNotification(customerName, phone);
      } else {
        console.log(`[INFO] Skipping notification for ${normalizedPhone} - ${alreadySeen ? 'already notified' : 'not in leads'}`);
      }
    } else {
      console.log(`[DEBUG] No update needed for ${normalizedPhone}`);
    }
  } catch (error) {
    console.error(`[ERROR] Failed to update log for ${normalizedPhone}:`, error);
  } finally {
    fileLocks.mainLog = false;
    processingSeenStatus.delete(normalizedPhone);
    console.log(`[DEBUG] Released file and processing locks for ${normalizedPhone}`);
  }
}

async function fetchLeads() {
  try {
    const sheets = google.sheets({ version: 'v4', auth: API_KEY });
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: RANGE
    });
    const data = response.data.values || [];
    if (data.length < 2) return [];
    const nameIndex = 4;
    const phoneIndex = 5;
    const sendCatalogIndex = 17;
    return data.slice(1).map(row => ({
      name: row[nameIndex]?.toString().trim() || '',
      phone: row[phoneIndex]?.toString().trim() || '',
      sendCatalog: row[sendCatalogIndex]?.toString().trim().toLowerCase() === 'yes'
    })).filter(lead => lead.name && lead.phone);
  } catch (error) {
    console.error('Google Sheets error:', error.message);
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

async function sendNotification(customerName, customerPhone) {
  const message = `📲 Customer Viewed Message!\n\nName: ${customerName}\nPhone: ${customerPhone}\n\nTime: ${new Date().toLocaleString()}`;
  try {
    await client.sendMessage(NOTIFICATION_NUMBER, message);
    console.log(`[NOTIFICATION] Sent seen alert for ${customerName}`);
  } catch (error) {
    console.error(`[ERROR] Failed to send notification: ${error.message}`);
    
    // Retry once after 5 seconds
    setTimeout(async () => {
      try {
        await client.sendMessage(NOTIFICATION_NUMBER, message);
        console.log(`[NOTIFICATION] Retry succeeded for ${customerName}`);
      } catch (retryError) {
        console.error(`[ERROR] Retry failed for ${customerName}:`, retryError.message);
      }
    }, 5000);
  }
}

function initializeWhatsApp() {
  initializeCatalogLog();
  
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
  client.on('message_ack', async (msg, ack) => {
    if (ack === 3 && msg.fromMe) {
      // Skip notifications and group messages
      if (msg.body && msg.body.startsWith('Customer Seen Message:')) {
        console.log('[DEBUG] Ignoring notification message ack');
        return;
      }
      
      let chat;
      try {
        chat = await msg.getChat();
        if (chat.isGroup) {
          console.log('[DEBUG] Ignoring group message ack');
          return;
        }
      } catch (error) {
        console.error('[ERROR] Failed to get chat:', error);
        return;
      }
      
      // Get recipient ID and extract phone number
      const recipientId = msg.to;
      if (!recipientId) return;
      
      // Skip notification number
      if (recipientId === NOTIFICATION_NUMBER) {
        console.log('[DEBUG] Skipping notification number');
        return;
      }
      
      // Extract phone from recipient ID
      const phone = recipientId.split('@')[0];
      console.log(`[ACK] Message seen by ${phone}`);
      await updateLogWithSeenStatus(phone);
    }
  });

  client.initialize();
}

// ---------------------- MESSAGE SENDING ----------------------
function composeMessage(name) {
  return `Dear ${name},

Thank you for reaching us through Meta Ads.

Welcome to Carolieto Intelligent Bathroom.`;
}

async function sendCatalogAndLocation(phone) {
  if (!client || status !== "ready") {
    throw new Error("WhatsApp client not ready");
  }

  const catalogCaption = "Thank you for reaching out to us at Carolieto Intelligent Bathrooms. Please have a look at our basin collections.";
  const locationMessage = "Please our Experience Center at Mansarovar Garden. We would be happy to have your presence.\n\nhttps://maps.app.goo.gl/4ayXrtSZKcxQxBXG7";

  // Send PDF with caption
  if (fs.existsSync(PDF_PATH)) {
    const media = MessageMedia.fromFilePath(PDF_PATH);
    await client.sendMessage(`${phone}@c.us`, media, { 
      caption: catalogCaption
    });
  } else {
    await client.sendMessage(`${phone}@c.us`, catalogCaption);
    console.error('PDF file not found, sent text only.');
  }
  
  await new Promise(resolve => setTimeout(resolve, 1000));
  await client.sendMessage(`${phone}@c.us`, locationMessage);
}

async function sendWelcomeMessage(phone, name) {
  if (!client || status !== "ready") {
    throw new Error("WhatsApp client not ready");
  }
  await client.sendMessage(`${phone}@c.us`, composeMessage(name));
}

async function processLeads() {
  console.log('Starting lead processing cycle...');
  let isCurrentlyRunning = true;

  try {
    const leads = await fetchLeads();
    const sentPhones = await getSentPhones();
    const catalogSentPhones = await getCatalogSentPhones();

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
        // Send welcome message
        console.log(`Processing new lead: ${lead.name} (${lead.phone})`);
        await sendWelcomeMessage(lead.phone, lead.name);
        await logSentMessage(lead.phone, lead.name, "Sent");
        sentPhones.add(normalizedPhone);
        console.log(`✅ Welcome message sent to ${lead.phone}`);
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
      }
      
      // Remove processing lock
      processingLocks.delete(normalizedPhone);
      
      // Add delay between messages
      await new Promise(resolve => setTimeout(resolve, SEND_DELAY));
      if (!processing) break;
    }

    // Second pass: Process existing leads that need catalogs
    for (const lead of leads) {
      if (!processing) {
        console.log('Processing stopped by user.');
        isCurrentlyRunning = false;
        break;
      }
      
      const normalizedPhone = normalizePhone(lead.phone);
      
      // Skip if currently being processed
      if (processingLocks.has(normalizedPhone)) {
        console.log(`⏭️ Skipping catalog for ${lead.name} (${lead.phone}) - already being processed`);
        continue;
      }
      
      // Only process if:
      // 1. Welcome message was already sent
      // 2. Catalog is requested
      // 3. Catalog hasn't been sent yet
      if (!sentPhones.has(normalizedPhone)) {
        console.log(`⏭️ Skipping catalog for ${lead.name} (${lead.phone}) - welcome not sent`);
        continue;
      }
      
      if (!lead.sendCatalog) {
        console.log(`⏭️ Skipping catalog for ${lead.name} (${lead.phone}) - not requested`);
        continue;
      }
      
      if (catalogSentPhones.has(normalizedPhone)) {
        console.log(`⏭️ Skipping catalog for ${lead.name} (${lead.phone}) - already sent`);
        continue;
      }
      
      // Add processing lock
      processingLocks.add(normalizedPhone);
      
      try {
        console.log(`Sending catalog to existing lead: ${lead.name} (${lead.phone})`);
        await sendCatalogAndLocation(lead.phone);
        await logCatalogSent(lead.phone, lead.name);
        catalogSentPhones.add(normalizedPhone);
        console.log(`✅ Catalog sent to ${lead.phone}`);
      } catch (error) {
        console.error(`❌ Failed to send catalog to ${lead.phone}: ${error.message}`);
      }
      
      // Remove processing lock
      processingLocks.delete(normalizedPhone);
      
      // Add delay between messages
      await new Promise(resolve => setTimeout(resolve, SEND_DELAY));
      if (!processing) break;
    }
  } catch (error) {
    console.error('Processing error:', error);
  } finally {
    if (isCurrentlyRunning) {
      console.log('Finished lead processing cycle.');
    }
  }
}

function startProcessingLoop() {
  if (processInterval) clearInterval(processInterval);
  
  processInterval = setInterval(async () => {
    if (processing && status === "ready") {
      console.log("\n🔍 Checking leads (periodic)...");
      await processLeads();
    }
  }, 300000); // 5 minutes
}

// ---------------------- EXPRESS SERVER ----------------------
app.use(express.json());
app.use(express.static('public'));

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

app.post('/start', (req, res) => {
  if (processing) {
    return res.status(400).json({ error: "Processing is already in progress" });
  }
  
  if (status !== "ready") {
    return res.status(400).json({ error: "WhatsApp client not ready" });
  }
  
  console.log('--- START REQUEST RECEIVED ---');
  processing = true;
  // processLeads(); // Commented out to prevent double messages - interval will handle it
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

app.post('/reset', (req, res) => {
  if (client) {
    client.destroy();
    client = null;
  }
  
  try {
    fs.rmSync(SESSION_PATH, { recursive: true, force: true });
    fs.mkdirSync(SESSION_PATH, { recursive: true });
  } catch (error) {
    console.error('Error resetting session:', error);
  }
  
  // Clear notification tracking
  seenNotifications.clear();
  
  initializeWhatsApp();
  res.json({ success: true, message: "Session reset" });
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
  startProcessingLoop();
});