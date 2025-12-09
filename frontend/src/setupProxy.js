const { createProxyMiddleware } = require('http-proxy-middleware');
const fs = require('fs');
const path = require('path');

module.exports = function(app) {
  // Read PORT from the root .env file (single source of truth)
  let backendPort = '8000'; // default
  
  const envPath = path.resolve(__dirname, '../../.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf-8');
    const portMatch = envContent.match(/^PORT=(\d+)/m);
    if (portMatch) {
      backendPort = portMatch[1];
    }
  }
  
  const target = `http://localhost:${backendPort}`;
  console.log(`Configuring proxy to backend at ${target}`);

  app.use(
    '/api',
    createProxyMiddleware({
      target: target,
      changeOrigin: true,
      logLevel: 'debug',
    })
  );
};
