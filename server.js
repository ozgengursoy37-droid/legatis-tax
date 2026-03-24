const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function parseMultipart(buffer, boundary) {
  const parts = [];
  const boundaryBuffer = Buffer.from('--' + boundary);
  let start = 0;
  while (start < buffer.length) {
    const boundaryIndex = buffer.indexOf(boundaryBuffer, start);
    if (boundaryIndex === -1) break;
    const headerStart = boundaryIndex + boundaryBuffer.length + 2;
    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), headerStart);
    if (headerEnd === -1) break;
    const header = buffer.slice(headerStart, headerEnd).toString();
    const dataStart = headerEnd + 4;
    const nextBoundary = buffer.indexOf(boundaryBuffer, dataStart);
    const dataEnd = nextBoundary === -1 ? buffer.length : nextBoundary - 2;
    const data = buffer.slice(dataStart, dataEnd);
    parts.push({ header, data });
    start = nextBoundary === -1 ? buffer.length : nextBoundary;
  }
  return parts;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  console.log('Files in dir:', fs.readdirSync(__dirname).join(', '));

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Landing page
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(path.join(__dirname, 'landing.html')).pipe(res);
    return;
  }

  // Chat uygulaması
  if (req.method === 'GET' && url.pathname === '/app') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
    return;
  }

  // Soru kaydet + sayaç kontrol
  if (req.method === 'POST' && url.pathname === '/api/question') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { user_id, category, question_text } = JSON.parse(body);
        let { data: profile } = await supabase.from('profiles').select('*').eq('id', user_id).single();
        if (!profile) {
          const { data: newProfile } = await supabase.from('profiles').insert({ id: user_id }).select().single();
          profile = newProfile;
        }
        if (!profile) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Profil oluşturulamadı' }));
          return;
        }
        const today = new Date().toISOString().split('T')[0];
        const isNewDay = profile.last_question_date !== today;
        const count = isNewDay ? 0 : profile.daily_question_count;
        if (!profile.is_premium && count >= 10) {
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'LIMIT_REACHED' }));
          return;
        }
        await supabase.from('profiles').update({ daily_question_count: count + 1, last_question_date: today }).eq('id', user_id);
        await supabase.from('user_questions').insert({ user_id, category: category || 'Tüm Sorular', question_text });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, remaining: profile.is_premium ? 999 : (9 - count) }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Sunucu hatası' }));
      }
    });
    return;
  }

  // Belge analizi
  if (req.method === 'POST' && url.pathname === '/api/analyze') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const buffer = Buffer.concat(chunks);
        const contentType = req.headers['content-type'] || '';
        const boundaryMatch = contentType.match(/boundary=(.+)/);
        if (!boundaryMatch) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Boundary bulunamadı' }));
          return;
        }
        const boundary = boundaryMatch[1];
        const parts = parseMultipart(buffer, boundary);
        let fileData = null, fileMimeType = null, fileName = null;
        let question = 'Bu belgeyi vergi mevzuatı açısından analiz et. Mükellef lehine yasal avantajları, riskleri ve önerileri belirt.';
        let userId = null;
        for (const part of parts) {
          const nameMatch = part.header.match(/name="([^"]+)"/);
          const filenameMatch = part.header.match(/filename="([^"]+)"/);
          const mimeMatch = part.header.match(/Content-Type: ([^\r\n]+)/);
          if (nameMatch && nameMatch[1] === 'question') { question = part.data.toString().trim() || question; }
          else if (nameMatch && nameMatch[1] === 'user_id') { userId = part.data.toString().trim(); }
          else if (filenameMatch) { fileData = part.data; fileName = filenameMatch[1]; fileMimeType = mimeMatch ? mimeMatch[1].trim() : 'application/octet-stream'; }
        }
        if (!fileData) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Dosya bulunamadı' }));
          return;
        }
        const base64Data = fileData.toString('base64');
        let messageContent = [];
        if (fileMimeType === 'application/pdf') {
          messageContent = [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Data } }, { type: 'text', text: question }];
        } else if (fileMimeType.startsWith('image/')) {
          const validImageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
          const mediaType = validImageTypes.includes(fileMimeType) ? fileMimeType : 'image/jpeg';
          messageContent = [{ type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } }, { type: 'text', text: question }];
        } else {
          messageContent = [{ type: 'text', text: `Kullanıcı bir belge yükledi (${fileName}). ${question}` }];
        }
        const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: 'claude-sonnet-4-5',
            max_tokens: 2000,
            system: `Sen Legatis Tax adlı bir Türk vergi danışmanlık asistanısın. Arkandaki ekip vergi mevzuatı ve özel sektör danışmanlığında derin uzmanlığa sahiptir. Yüklenen belgeleri vergi mevzuatı açısından analiz ederek mükellef lehine yasal avantajları, riskleri ve pratik önerileri belirtirsin.`,
            messages: [{ role: 'user', content: messageContent }]
          })
        });
        const anthropicData = await anthropicResponse.json();
        const analysisText = anthropicData.content?.[0]?.text || 'Analiz yapılamadı.';
        if (userId) {
          await supabase.from('user_questions').insert({ user_id: userId, category: 'Belge Analizi', question_text: `[Belge: ${fileName}] ${question}` });
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, analysis: analysisText }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Analiz hatası: ' + err.message }));
      }
    });
    return;
  }

  // Lemon Squeezy Webhook
  if (req.method === 'POST' && url.pathname === '/api/webhook') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
        const signature = req.headers['x-signature'];
        const hmac = crypto.createHmac('sha256', secret);
        hmac.update(body);
        const digest = hmac.digest('hex');
        if (digest !== signature) { res.writeHead(401); res.end('Unauthorized'); return; }
        const event = JSON.parse(body);
        const eventName = event.meta?.event_name;
        const userEmail = event.data?.attributes?.user_email;
        if (!userEmail) { res.writeHead(200); res.end('OK'); return; }
        const { data: users } = await supabase.auth.admin.listUsers();
        const user = users?.users?.find(u => u.email === userEmail);
        if (!user) { res.writeHead(200); res.end('OK'); return; }
        if (eventName === 'subscription_created' || eventName === 'subscription_payment_success') {
          await supabase.from('profiles').update({ is_premium: true }).eq('id', user.id);
        } else if (['subscription_cancelled', 'subscription_expired', 'subscription_payment_failed'].includes(eventName)) {
          await supabase.from('profiles').update({ is_premium: false }).eq('id', user.id);
        }
        res.writeHead(200); res.end('OK');
      } catch (err) { res.writeHead(500); res.end('Error'); }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(process.env.PORT || 8080);
