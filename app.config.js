const fs = require('fs');
const path = require('path');

const config = JSON.parse(JSON.stringify(require('./app.json')));

const googleServicesPath = path.resolve(__dirname, 'google-services.json');

if (!fs.existsSync(googleServicesPath)) {
  delete config.expo.android.googleServicesFile;
}

module.exports = config;
