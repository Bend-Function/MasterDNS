// Only serves the harness's owned private container network.
const https = require('node:https');
const net = require('node:net');
const fs = require('node:fs');

const tcp = net.createServer(socket => socket.end()).listen(18080, '::');
// The acceptance harness can refuse TCP while keeping the owned host and HTTPS alive.
process.on('SIGUSR1', () => tcp.close());
https.createServer({ key: fs.readFileSync('/test/server.key'), cert: fs.readFileSync('/test/server.crt') }, (req, res) => {
  const correctOrigin = req.headers.host === 'probe-target.test' && req.socket.servername === 'probe-target.test';
  fs.appendFileSync('/test/requests.jsonl', JSON.stringify({ host: req.headers.host, sni: req.socket.servername, path: req.url }) + '\n');
  res.writeHead(correctOrigin ? 200 : 421);
  res.end('masterdns isolated target');
}).listen(18443, '::', () => console.log('ready'));
