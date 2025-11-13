// Configuration example - Copy this to config.local.js and customize for your deployment
// config.local.js is gitignored and won't be committed

const config = {
  appName: "Device Dashboard",
  appOrganization: "Your Organization",
  // Add other local configuration here
};

// For Node.js environments
if (typeof module !== 'undefined' && module.exports) {
  module.exports = config;
}
