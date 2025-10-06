# System Monitoring & Recovery Guide

## 🚨 Failure Scenarios & Bot Behavior

### **1. No Internet Connection**
**What happens:**
- Google Sheets API calls fail
- WhatsApp messages cannot be sent
- Bot continues running but logs errors

**Bot behavior:**
- Continues trying every 10 seconds (COOLDOWN)
- Tracks consecutive failures
- After 3 consecutive Google Sheets failures → Sends alert to admin (8851165191)
- Logs all errors with timestamps

**Recovery:**
- When internet returns → Automatically resumes
- Sends recovery notification to admin
- Processes any missed leads

### **2. Google Sheets API Issues**
**What happens:**
- API quota exceeded
- Invalid credentials
- Spreadsheet permissions changed
- Spreadsheet deleted/moved

**Bot behavior:**
- Logs specific error (quota, auth, not found, etc.)
- Continues retrying every 10 seconds
- After 30 minutes without successful call → Sends alert
- Tracks last successful call timestamp

**Recovery:**
- When API access restored → Resumes automatically
- Sends recovery notification with downtime duration
- Catches up on any new leads

### **3. WhatsApp Web Disconnection**
**What happens:**
- Phone disconnected from internet
- WhatsApp Web session expired
- Phone battery died
- QR code needs re-scanning

**Bot behavior:**
- Immediately detects disconnection
- Sends alert to admin (if possible before full disconnect)
- Status changes to "disconnected"
- Stops processing leads
- Shows QR code on dashboard for re-connection

**Recovery:**
- When WhatsApp reconnects → Sends recovery notification
- Resumes processing from where it left off
- No duplicate messages sent

### **4. System Crash/Server Restart**
**What happens:**
- Server crashes
- Power outage
- Manual restart
- System update

**Bot behavior:**
- On restart: Checks what was sent before crash
- Compares with current Google Sheets data
- Only sends to leads that weren't processed
- Sends startup notification to admin

**Recovery:**
- Automatic duplicate prevention
- Resumes from last successful state
- No messages lost or duplicated

### **5. PDF File Missing/Corrupted**
**What happens:**
- PDF file deleted
- File permissions changed
- File corrupted

**Bot behavior:**
- Sends welcome message normally
- Attempts to send PDF → Fails
- Sends text-only catalog caption instead
- Logs error for admin review

**Recovery:**
- When PDF restored → Continues normally
- Can manually resend PDFs to affected customers

## 📱 Admin Notifications (8851165191)

### **Alert Types:**

#### **🚨 System Alerts:**
```
🚨 SYSTEM ALERT - [Business Name] Bot

Alert: Google Sheets connection failed multiple times
Time: 2025-01-15 14:30:25
Details: Request failed with status code 403

Bot Status: ready
Consecutive Failures: 3
Last Successful Google Sheets: 2025-01-15 14:25:10
Last Successful WhatsApp Send: 2025-01-15 14:29:45
```

#### **✅ Recovery Notifications:**
```
✅ SYSTEM RECOVERY - [Business Name] Bot

Bot is back online and operational!
Recovery Time: 2025-01-15 14:35:20
Downtime: 5 minutes

System Status:
✅ WhatsApp: Connected
✅ Google Sheets: Working
✅ Processing: Ready

Bot will resume normal operations.
```

#### **⚠️ Startup Notifications:**
```
🔄 SYSTEM STARTUP - [Business Name] Bot

Bot has restarted and is initializing...
Startup Time: 2025-01-15 14:40:15
Last Shutdown: 2025-01-15 14:35:00

Checking for missed leads...
Ready to resume operations.
```

## 🔧 Manual Recovery Steps

### **If Bot Stops Responding:**
1. Check dashboard at http://localhost:3000
2. Look for error messages in console
3. Restart bot: `npm start`
4. Re-scan QR code if needed

### **If Google Sheets Not Working:**
1. Check API key validity
2. Verify spreadsheet permissions
3. Check quota limits in Google Console
4. Test spreadsheet access manually

### **If WhatsApp Disconnected:**
1. Check phone internet connection
2. Open WhatsApp on phone
3. Scan QR code on dashboard
4. Wait for "ready" status

### **If PDF Not Sending:**
1. Check if PDF file exists in Bot folder
2. Verify filename matches config.json
3. Check file permissions
4. Test with smaller PDF if needed

## 📊 Health Monitoring

The bot continuously monitors:
- ✅ WhatsApp connection status
- ✅ Google Sheets API response times
- ✅ Message delivery success rates
- ✅ System uptime and crashes
- ✅ Error patterns and frequencies

All health data is tracked and reported to admin when issues occur.

## 🛡️ Duplicate Prevention

Even after crashes/failures, the bot ensures:
- ❌ No duplicate welcome messages
- ❌ No duplicate PDF catalogs
- ❌ No spam to customers
- ✅ Only missing messages are sent
- ✅ Complete recovery without issues

The system is designed to be bulletproof and customer-friendly!