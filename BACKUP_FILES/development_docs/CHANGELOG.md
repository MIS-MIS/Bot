# WhatsApp Bot Changelog

## Version 2.0 - Combined Welcome + Catalog System

### 🎉 Major Changes

#### **New Behavior:**
- **Catalog with Welcome Message**: When a lead is marked "Yes" in Google Sheets (column S), the bot now sends:
  1. Welcome message
  2. Catalog PDF (2 seconds later)
  3. Location message
  - All sent together automatically, no separate processing needed

#### **Previous Behavior:**
- Welcome message sent first
- Catalog sent separately only when customer typed keywords like "pdf"
- Required two-pass processing system

### ✨ New Features

1. **Combined Message Function**
   - `sendWelcomeWithCatalog()` - Sends welcome + catalog + location in sequence
   - Automatic 2-second delay between welcome and catalog for better delivery

2. **Simplified Processing**
   - Single-pass lead processing
   - No more separate catalog processing loop
   - Faster and more efficient

3. **Smart Customer Requests**
   - Customers can still request catalogs manually by typing keywords
   - Bot allows re-sending if customer requests again
   - No duplicate prevention for manual requests

### 🔧 Configuration Updates

1. **Updated Welcome Message Template**
   - Changed from "Type 'Pdf' to receive catalog" 
   - To "Your catalog will be sent automatically if requested"

2. **Maintained Keyword System**
   - Customers can still type: pdf, catalog, brochure, etc.
   - Bot responds immediately with catalog

### 📊 Logging Improvements

- Both welcome and catalog messages logged when sent together
- Separate tracking for automatic vs manual catalog sends
- Enhanced notifications for PDF requests

### 🚀 Business Benefits

1. **Immediate Engagement**: Customers get catalog right away when marked "Yes"
2. **Reduced Friction**: No need for customers to know special keywords
3. **Better Conversion**: Instant catalog delivery improves response rates
4. **Flexibility**: Still allows manual catalog requests

### 📋 Google Sheets Integration

**Column S (Index 18) - Send Catalog:**
- `Yes` = Sends welcome message + catalog + location automatically
- `No` or empty = Sends only welcome message
- Customer can still request catalog manually later

### 🔄 Migration Notes

**For Existing Setups:**
1. Update `config.json` with new welcome message template
2. Existing leads with "Yes" will get catalog on next processing
3. No database migration needed - uses same log files

**For New Businesses:**
1. Run `node setup-business.js` for automatic configuration
2. Default welcome message updated to reflect new behavior
3. All catalog keywords still work for manual requests

### 🐛 Bug Fixes

- Removed duplicate catalog sending logic
- Improved error handling for PDF file loading
- Better processing lock management
- Enhanced notification system for manual requests

### 📈 Performance Improvements

- Single-pass processing reduces server load
- Eliminated second processing loop
- Faster lead processing cycles
- Better memory management

---

## How to Update Existing Bot

1. **Update Code**: Replace app.js with new version
2. **Update Config**: Run setup script or manually update welcome message
3. **Test**: Verify catalog sending with test lead marked "Yes"
4. **Deploy**: Restart bot to apply changes

## Support

For questions about the new system, check the updated README.md or review the configuration examples.