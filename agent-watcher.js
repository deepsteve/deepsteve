const http = require('http');

const PORT = 3000;
const CHANNEL = 'agents';
const SENDER = 'Gemini CLI (Auto)';
let lastId = 0;

function log(msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] ${msg}`);
}

function sendMessage(text) {
  const body = JSON.stringify({ sender: SENDER, text });
  const req = http.request({
    hostname: 'localhost',
    port: PORT,
    path: `/api/agent-chat/${CHANNEL}/messages`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': body.length
    }
  });
  req.on('error', (e) => log(`Error sending message: ${e.message}`));
  req.write(body);
  req.end();
}

function poll() {
  http.get(`http://localhost:${PORT}/api/agent-chat/${CHANNEL}`, (res) => {
    let data = '';
    res.on('data', (chunk) => data += chunk);
    res.on('end', () => {
      try {
        const json = JSON.parse(data);
        const messages = json.messages || [];
        const newMessages = messages.filter(m => m.id > lastId);
        
        for (const msg of newMessages) {
          lastId = Math.max(lastId, msg.id);
          if (msg.sender !== SENDER && msg.sender !== 'Gemini CLI') {
            log(`Received from ${msg.sender}: ${msg.text}`);
            
            // Simple response logic
            const text = msg.text.toLowerCase();
            if (text.includes('gemini') || text.includes('hello') || text.includes('hi ')) {
               sendMessage(`Responding to ${msg.sender}: I'm here and watching the #agents channel!`);
            }
          }
        }
      } catch (e) {
        log(`Error parsing JSON: ${e.message}`);
      }
      setTimeout(poll, 15000);
    });
  }).on('error', (e) => {
    log(`Poll error: ${e.message}`);
    setTimeout(poll, 5000);
  });
}

// Initial fetch to set lastId so we don't respond to old messages
http.get(`http://localhost:${PORT}/api/agent-chat/${CHANNEL}`, (res) => {
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => {
    try {
      const json = JSON.parse(data);
      const messages = json.messages || [];
      if (messages.length > 0) {
        lastId = messages[messages.length - 1].id;
        log(`Initialized lastId to ${lastId}`);
      }
    } catch (e) {}
    log(`Starting poll loop on channel #${CHANNEL}...`);
    poll();
  });
}).on('error', (e) => {
  log(`Initial fetch error: ${e.message}`);
  poll();
});
