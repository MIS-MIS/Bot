#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function setupBusiness() {
  console.log('\n🚀 WhatsApp Bot Business Setup');
  console.log('=====================================\n');
  
  console.log('This script will help you configure the bot for your business.\n');
  
  // Business Information
  const businessName = await question('Enter your business name: ');
  const shortName = await question('Enter short name/brand (for branding): ');
  const industry = await question('Enter your industry (e.g., "Bathroom Solutions", "Real Estate"): ');
  const productType = await question('Enter your product/service type (e.g., "basin collections", "property listings"): ');
  const catalogName = await question('Enter your catalog PDF filename (e.g., "My-Catalog.pdf"): ');
  
  // Location Information
  const address = await question('Enter your business address: ');
  const locationUrl = await question('Enter your Google Maps URL: ');
  
  // Contact Information
  const notificationPhone = await question('Enter notification phone number (without country code): ');
  
  // Message Templates
  console.log('\n📝 Message Templates');
  console.log('You can customize these later in config.json\n');
  
  const useDefaultMessages = await question('Use default message templates? (y/n): ');
  
  let welcomeTemplate, catalogCaption, locationMessage;
  
  if (useDefaultMessages.toLowerCase() === 'y') {
    welcomeTemplate = `Dear {name},\n\nThank you for reaching us through Meta Ads.\n\nWelcome to {businessName}.\n\nType *'Pdf'* to receive our catalog.`;
    catalogCaption = `Thank you for reaching out to us at {businessName}. Please have a look at our {productType}.`;
    locationMessage = `Please visit our office at {location}. We would be happy to have your presence.\n\n{locationUrl}`;
  } else {
    welcomeTemplate = await question('Enter welcome message template (use {name} and {businessName} as placeholders): ');
    catalogCaption = await question('Enter catalog caption (use {businessName} and {productType} as placeholders): ');
    locationMessage = await question('Enter location message (use {location} and {locationUrl} as placeholders): ');
  }
  
  // Keywords
  console.log('\n🔍 Catalog Request Keywords');
  const useDefaultKeywords = await question('Use default keywords for catalog requests? (y/n): ');
  
  let catalogKeywords;
  if (useDefaultKeywords.toLowerCase() === 'y') {
    catalogKeywords = ["pdf", "catalog", "catalogue", "brochure", "product", "products", "price", "pricing", "cost"];
  } else {
    const keywordsInput = await question('Enter keywords separated by commas (e.g., pdf,catalog,price): ');
    catalogKeywords = keywordsInput.split(',').map(k => k.trim().toLowerCase());
  }
  
  // Colors
  console.log('\n🎨 Branding Colors');
  const useDefaultColors = await question('Use default WhatsApp colors? (y/n): ');
  
  let primaryColor, secondaryColor, accentColor;
  if (useDefaultColors.toLowerCase() === 'y') {
    primaryColor = '#075E54';
    secondaryColor = '#128C7E';
    accentColor = '#25D366';
  } else {
    primaryColor = await question('Enter primary color (hex code, e.g., #075E54): ');
    secondaryColor = await question('Enter secondary color (hex code, e.g., #128C7E): ');
    accentColor = await question('Enter accent color (hex code, e.g., #25D366): ');
  }
  
  // Create configuration object
  const config = {
    business: {
      name: businessName,
      shortName: shortName,
      industry: industry,
      productType: productType,
      catalogName: catalogName
    },
    messages: {
      welcomeTemplate: welcomeTemplate,
      catalogCaption: catalogCaption,
      locationMessage: locationMessage,
      catalogKeywords: catalogKeywords
    },
    location: {
      address: address,
      url: locationUrl
    },
    notifications: {
      phoneNumber: notificationPhone
    },
    branding: {
      primaryColor: primaryColor,
      secondaryColor: secondaryColor,
      accentColor: accentColor,
      dashboardTitle: `${businessName} WhatsApp Bot - Dashboard`,
      logoText: `${shortName} Bot`
    }
  };
  
  // Save configuration
  const configPath = path.join(__dirname, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  
  console.log('\n✅ Configuration saved successfully!');
  console.log(`📁 Config file: ${configPath}`);
  
  // Update .env file
  const envPath = path.join(__dirname, '.env');
  let envContent = '';
  
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf8');
  }
  
  // Update PDF_PATH in .env
  const pdfPathLine = `PDF_PATH="${catalogName}"`;
  if (envContent.includes('PDF_PATH=')) {
    envContent = envContent.replace(/PDF_PATH=.*/, pdfPathLine);
  } else {
    envContent += `\n${pdfPathLine}`;
  }
  
  fs.writeFileSync(envPath, envContent);
  
  console.log('\n📋 Next Steps:');
  console.log('1. Place your catalog PDF file in the Bot folder with the name:', catalogName);
  console.log('2. Update your Google Sheets credentials in .env file');
  console.log('3. Run: npm start');
  console.log('4. Scan QR code to connect WhatsApp');
  
  console.log('\n🎉 Your bot is ready to use!');
  
  rl.close();
}

// Run setup
setupBusiness().catch(console.error);