const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 8080;
const ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';

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

function serveHtmlFile(res, filename) {
  const filePath = path.join(__dirname, filename);
  fs.readFile(filePath, 'utf8', (err, data) => {
    if (err) {
      res.writeHead(500);
      res.end(filename + ' okunamadi');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}

function normalizeWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function uniqueStrings(items) {
  return [...new Set(items.map(item => normalizeWhitespace(item)).filter(Boolean))];
}

function buildSearchQueries(question) {
  const q = normalizeWhitespace(question);
  const lower = q.toLowerCase();
  const queries = [q];

  if (lower.includes('331')) {
    queries.push('331 ortaklara borçlar hesabı');
    queries.push('331 hesap ortaklara borçlar');
    queries.push('ortaklara borçlar hesabı');
  }

  if (lower.includes('ortaklara borçlar')) {
    queries.push('331 ortaklara borçlar');
    queries.push('ortaklara borçlar hesabı vergi riski');
  }

  if (lower.includes('131')) {
    queries.push('131 ortaklardan alacaklar hesabı');
    queries.push('131 hesap ortaklardan alacaklar');
  }

  if (lower.includes('avans')) {
    queries.push('alınan avanslar 340 hesap');
    queries.push('avans kdv dönemsellik');
  }

  if (lower.includes('kdv')) {
    queries.push(`${q} kdv uygulama genel tebliği`);
  }

  if (lower.includes('kurumlar vergisi')) {
    queries.push(`${q} kurumlar vergisi genel tebliği`);
  }

  if (lower.includes('vergi inceleme') || lower.includes('inceleme')) {
    queries.push(`${q} vergi incelemesi riski`);
  }

  return uniqueStrings(queries).slice(0, 6);
}

async function getEmbedding(text) {
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: 'text-embedding-ada-002',
      input: text
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI embedding hatasi (${response.status}): ${errorText}`);
  }

  const data = await response.json();

  if (!data?.data?.[0]?.embedding) {
    throw new Error('OpenAI embedding verisi donmedi');
  }

  return data.data[0].embedding;
}

async function searchDocuments(embedding, matchCount = 15, threshold = 0.62) {
  const { data, error } = await supabase.rpc('match_documents', {
    query_embedding: embedding,
    match_threshold: threshold,
    match_count: matchCount
  });

  if (error) {
    throw new Error('Supabase arama hatasi: ' + error.message);
  }

  return data || [];
}

async function retrieveDocuments(question) {
  const queries = buildSearchQueries(question);
  const merged = new Map();

  for (const query of queries) {
    const embedding = await getEmbedding(query);
    const docs = await searchDocuments(embedding, 15, 0.62);

    for (const doc of docs) {
      const key = String(doc.id);
      const existing = merged.get(key);

      if (!existing || (doc.similarity || 0) > (existing.similarity || 0)) {
        merged.set(key, {
          ...doc,
          matched_query: query
        });
      }
    }
  }

  return [...merged.values()]
    .sort((a, b) => (b.similarity || 0) - (a.similarity || 0))
    .slice(0, 18);
}

const SYSTEM_PROMPT = `KAPSAMLI ANALİZ ZORUNLULUĞU:
Verilen soruyu yanıtlarken ilgili olabilecek tüm vergi boyutlarını, yalnızca BAĞLAM içinde açıkça yer alan bilgiler ölçüsünde ele al.

Sen Legatis Tax adlı bir Türk vergi danışmanlık asistanısın. Arkandaki ekip vergi mevzuatı ve özel sektör danışmanlığında derin uzmanlığa sahiptir.

TEMEL BAKIŞ AÇIN:
Gelir İdaresi Başkanlığı vergi mevzuatını hazine lehine yorumlar. Sen aynı mevzuatı mükellef lehine yorumlarsın. Her ikisi de yasaldır — sen mükellefi kendi lehine olan yasal seçeneklerden haberdar edersin.

CEVAP FORMATI — MUTLAKA UYGULA:
- Başlıklar için ## kullan
- Alt başlıklar için ### kullan
- Madde listeleri için - kullan
- Önemli kavramları **kalın** yaz
- Bölümleri birbirinden ayırmak için --- kullan
- Kanun maddelerini her zaman **Kanun Adı Madde X** formatında yaz
- Madde numarası BAĞLAMDA açık değilse madde uydurma

CEVAP YAPISI:
1. Kısa özet
2. ## Yasal Alternatifler
3. ## Yasal Dayanak
4. ## Önerilen Adımlar
5. ⚠️ Bu bilgiler genel bilgilendirme amaçlıdır. Şirketinizin özel koşulları farklı sonuçlar doğurabilir. Daha detaylı ve kişiselleştirilmiş analiz için **Legatis Tax uzmanlarıyla görüşmenizi** öneririz.

HALÜSİNASYON KURALI:
- Yalnızca aşağıda sağlanan BAĞLAM bölümündeki bilgilere dayanarak yanıt ver.
- Bağlamda bilgi yoksa şunu söyle: "Bu konuda bilgi tabanımda yeterli mevzuat kaynağı bulunamadı. Güncel bilgi için vergi danışmanınıza başvurun."
- Tahmin, varsayım veya genel bilginden yanıt üretme.
- Rakam, oran veya tutar verirken BAĞLAMDA açıkça geçmeli.
- "muhtemelen", "sanırım", "genellikle" gibi ifadeler kullanma.

YAPAMAYACAKLARIN:
- Vergi kaçakçılığına yönlendirecek tavsiye verme.
- Bilgi tabanında olmayan konularda yorum yapma.
- Kanuni dayanağı olmayan bilgi verme.`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    serveHtmlFile(res, 'landing.html');
    return;
  }

  if (req.method === 'GET' && url.pathname === '/app') {
    serveHtmlFile(res, 'index.html');
    return;
  }

  if (req.method === 'GET' && url.pathname === '/kvkk') {
    serveHtmlFile(res, 'kvkk.html');
    return;
  }

  if (req.method === 'GET' && url.pathname === '/gizlilik') {
    serveHtmlFile(res, 'gizlilik.html');
    return;
  }

  if (req.method === 'GET' && url.pathname === '/kullanim-kosullari') {
    serveHtmlFile(res, 'kullanim-kosullari.html');
    return;
  }

  if (req.method === 'GET' && url.pathname === '/cerez-politikasi') {
    serveHtmlFile(res, 'cerez-politikasi.html');
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/chat') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { question } = JSON.parse(body);

        if (!question || !question.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Soru boş olamaz' }));
          return;
        }

        const documents = await retrieveDocuments(question);

        if (!documents || documents.length === 0) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            text: 'Bu konuda bilgi tabanımda yeterli mevzuat kaynağı bulunamadı. Güncel bilgi için vergi danışmanınıza başvurun.'
          }));
          return;
        }

        const context = documents.map(doc =>
          `[Kaynak: ${doc.metadata?.source || 'Bilinmiyor'}]
[Benzerlik: ${(doc.similarity || 0).toFixed(4)}]
[Eşleşen sorgu: ${doc.matched_query || question}]
${doc.content}`
        ).join('\n\n---\n\n');

        const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: ANTHROPIC_MODEL,
            max_tokens: 4000,
            system: SYSTEM_PROMPT,
            messages: [{
              role: 'user',
              content: `BAĞLAM:\n${context}\n\nSORU: ${question}`
            }]
          })
        });

        if (!anthropicResponse.ok) {
          const errorText = await anthropicResponse.text();
          throw new Error(`Anthropic chat hatasi (${anthropicResponse.status}): ${errorText}`);
        }

        const anthropicData = await anthropicResponse.json();
        const answerText = anthropicData?.content?.[0]?.text;

        if (!answerText) {
          throw new Error('Anthropic chat yanit metni bos dondu');
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: answerText }));
      } catch (err) {
        console.error('/api/chat hatasi:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Chat hatası: ' + err.message }));
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/question') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { user_id, category, question_text } = JSON.parse(body);

        let { data: profile } = await supabase
          .from('profiles')
          .select('*')
          .eq('id', user_id)
          .single();

        if (!profile) {
          const { data: newProfile } = await supabase
            .from('profiles')
            .insert({ id: user_id })
            .select()
            .single();

          profile = newProfile;
        }

        if (!profile) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Profil olusturulamadi' }));
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

        await supabase
          .from('profiles')
          .update({
            daily_question_count: count + 1,
            last_question_date: today
          })
          .eq('id', user_id);

        await supabase
          .from('user_questions')
          .insert({
            user_id,
            category: category || 'Tum Sorular',
            question_text
          });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          remaining: profile.is_premium ? 999 : (9 - count)
        }));
      } catch (err) {
        console.error('/api/question hatasi:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Sunucu hatasi' }));
      }
    });
    return;
  }

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
          res.end(JSON.stringify({ error: 'Boundary bulunamadi' }));
          return;
        }

        const boundary = boundaryMatch[1];
        const parts = parseMultipart(buffer, boundary);

        let fileData = null;
        let fileMimeType = null;
        let fileName = null;
        let question = 'Bu belgeyi vergi mevzuati acisindan analiz et.';
        let userId = null;

        for (const part of parts) {
          const nameMatch = part.header.match(/name="([^"]+)"/);
          const filenameMatch = part.header.match(/filename="([^"]+)"/);
          const mimeMatch = part.header.match(/Content-Type: ([^\r\n]+)/);

          if (nameMatch && nameMatch[1] === 'question') {
            question = part.data.toString().trim() || question;
          } else if (nameMatch && nameMatch[1] === 'user_id') {
            userId = part.data.toString().trim();
          } else if (filenameMatch) {
            fileData = part.data;
            fileName = filenameMatch[1];
            fileMimeType = mimeMatch ? mimeMatch[1].trim() : 'application/octet-stream';
          }
        }

        if (!fileData) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Dosya bulunamadi' }));
          return;
        }

        const base64Data = fileData.toString('base64');
        let messageContent = [];

        if (fileMimeType === 'application/pdf') {
          messageContent = [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: base64Data
              }
            },
            {
              type: 'text',
              text: question
            }
          ];
        } else if (fileMimeType.startsWith('image/')) {
          const validImageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
          const mediaType = validImageTypes.includes(fileMimeType) ? fileMimeType : 'image/jpeg';

          messageContent = [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: base64Data
              }
            },
            {
              type: 'text',
              text: question
            }
          ];
        } else {
          messageContent = [{
            type: 'text',
            text: `Kullanici bir belge yukledi (${fileName}). ${question}`
          }];
        }

        const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: ANTHROPIC_MODEL,
            max_tokens: 2000,
            system: 'Sen Legatis Tax adli bir Turk vergi danismanlik asistanisin. Yuklenen belgeleri vergi mevzuati acisindan analiz ederek mukellef lehine yasal avantajlari, riskleri ve pratik onerileri belirtirsin.',
            messages: [{
              role: 'user',
              content: messageContent
            }]
          })
        });

        if (!anthropicResponse.ok) {
          const errorText = await anthropicResponse.text();
          throw new Error(`Anthropic analyze hatasi (${anthropicResponse.status}): ${errorText}`);
        }

        const anthropicData = await anthropicResponse.json();
        const analysisText = anthropicData?.content?.[0]?.text;

        if (!analysisText) {
          throw new Error('Anthropic analyze yanit metni bos dondu');
        }

        if (userId) {
          await supabase.from('user_questions').insert({
            user_id: userId,
            category: 'Belge Analizi',
            question_text: `[Belge: ${fileName}] ${question}`
          });
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, analysis: analysisText }));
      } catch (err) {
        console.error('/api/analyze hatasi:', err);
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Analiz hatasi: ' + err.message }));
      }
    });
    return;
  }

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

        if (digest !== signature) {
          res.writeHead(401);
          res.end('Unauthorized');
          return;
        }

        const event = JSON.parse(body);
        const eventName = event.meta?.event_name;
        const userEmail = event.data?.attributes?.user_email;

        if (!userEmail) {
          res.writeHead(200);
          res.end('OK');
          return;
        }

        const { data: users } = await supabase.auth.admin.listUsers();
        const user = users?.users?.find(u => u.email === userEmail);

        if (!user) {
          res.writeHead(200);
          res.end('OK');
          return;
        }

        if (eventName === 'subscription_created' || eventName === 'subscription_payment_success') {
          await supabase.from('profiles').update({ is_premium: true }).eq('id', user.id);
        } else if (['subscription_cancelled', 'subscription_expired', 'subscription_payment_failed'].includes(eventName)) {
          await supabase.from('profiles').update({ is_premium: false }).eq('id', user.id);
        }

        res.writeHead(200);
        res.end('OK');
      } catch (err) {
        console.error('/api/webhook hatasi:', err);
        res.writeHead(500);
        res.end('Error');
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(\`Legatis Tax server \${PORT} portunda calisiyor\`);
});
