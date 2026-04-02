const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 8080;
const ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';

const RETRIEVAL_THRESHOLD = 0.72;
const RETRIEVAL_TOP_K = 12;
const MAX_SUBQUERIES = 6;
const MAX_CONTEXT_DOCS = 18;
const MAX_CONTEXT_CHARS = 26000;

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
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueStrings(items) {
  return [...new Set(items.map(item => normalizeWhitespace(item)).filter(Boolean))];
}

function getSourceName(doc) {
  return normalizeWhitespace(doc?.metadata?.source || 'Bilinmiyor');
}

function getSourcePriority(source) {
  const s = source.toLowerCase();

  if (s.includes('beyanname düzenleme klavuzu') || s.includes('beyanname düzenleme kılavuzu')) return 5;
  if (s.includes('genel muhasebe')) return 5;
  if (s.includes('genel uygulama tebli')) return 4;
  if (s.includes('genel tebli')) return 4;
  if (s.includes('kanunu') || s.includes('kanun')) return 3;
  if (s.includes('rehber') || s.includes('kılavuz') || s.includes('klavuz')) return 3;
  if (s.includes('özelge')) return 2;

  return 1;
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

async function searchDocuments(embedding, matchCount = RETRIEVAL_TOP_K, threshold = RETRIEVAL_THRESHOLD) {
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

function buildDeterministicSubqueries(question) {
  const q = normalizeWhitespace(question);
  const lower = q.toLowerCase();
  const queries = [q];

  const add = (...items) => {
    for (const item of items) {
      if (item) queries.push(item);
    }
  };

  if (/(kdv|katma değer vergisi)/i.test(lower)) {
    add(
      `${q} kdv uygulama genel tebliği`,
      `${q} kdv beyanname düzenleme kılavuzu`,
      `${q} indirim konusu kdv iade matrah`
    );
  }

  if (/(kurumlar vergisi|kvk)/i.test(lower)) {
    add(
      `${q} kurumlar vergisi genel tebliği`,
      `${q} kurumlar vergisi beyanname düzenleme kılavuzu`,
      `${q} kurum kazancı istisna indirim gider`
    );
  }

  if (/(gelir vergisi|gvk|stopaj|tevkifat)/i.test(lower)) {
    add(
      `${q} gelir vergisi kanunu tevkifat`,
      `${q} gelir vergisi beyanname düzenleme kılavuzu`,
      `${q} stopaj kesinti beyan`
    );
  }

  if (/(vuk|vergi usul|muhasebe|mizan|bilanço|defter|belge)/i.test(lower)) {
    add(
      `${q} vergi usul kanunu`,
      `${q} muhasebe sistemi uygulama genel tebliği`,
      `${q} genel muhasebe`
    );
  }

  if (/(teşvik|yatırım|indirimli kurumlar|32\/a|32a)/i.test(lower)) {
    add(
      `${q} yatırım teşvik indirimli kurumlar`,
      `${q} kurumlar vergisi kanunu 32a`,
      `${q} teşvik uygulama`
    );
  }

  if (/(inşaat|konut|arsa|müteahhit|taahhüt)/i.test(lower)) {
    add(
      `${q} inşaat kdv indirim iade matrah`,
      `${q} konut teslimi arsa payı finansman gideri`,
      `${q} beyanname düzenleme kılavuzu inşaat`
    );
  }

  if (/(iade)/i.test(lower)) {
    add(
      `${q} iade usul esas`,
      `${q} iade talep şartları`,
      `${q} indirim yoluyla giderilemeyen kdv`
    );
  }

  if (/(amortisman|demirbaş|taşıt|araç)/i.test(lower)) {
    add(
      `${q} amortisman gider kısıtlaması`,
      `${q} taşıt kdv ötv gider`,
      `${q} muhasebe amortisman uygulama`
    );
  }

  if (queries.length === 1) {
    add(
      `${q} kanun tebliğ uygulama`,
      `${q} beyanname düzenleme kılavuzu`,
      `${q} muhasebe uygulama`
    );
  }

  return uniqueStrings(queries).slice(0, MAX_SUBQUERIES);
}

async function retrieveDocumentsForQuestion(question) {
  const subqueries = buildDeterministicSubqueries(question);
  const merged = new Map();

  for (const subquery of subqueries) {
    const embedding = await getEmbedding(subquery);
    const docs = await searchDocuments(embedding, RETRIEVAL_TOP_K, RETRIEVAL_THRESHOLD);

    for (const doc of docs) {
      const key = String(doc.id);
      const existing = merged.get(key);
      const enriched = {
        ...doc,
        source: getSourceName(doc),
        sourcePriority: getSourcePriority(getSourceName(doc)),
        matchedBy: subquery
      };

      if (!existing) {
        merged.set(key, enriched);
        continue;
      }

      if ((enriched.similarity || 0) > (existing.similarity || 0)) {
        merged.set(key, { ...existing, ...enriched });
      }
    }
  }

  const allDocs = [...merged.values()].sort((a, b) => {
    const aScore = (a.similarity || 0) + (a.sourcePriority || 0) * 0.015;
    const bScore = (b.similarity || 0) + (b.sourcePriority || 0) * 0.015;
    return bScore - aScore;
  });

  const selected = [];
  const usedSources = new Set();

  for (const doc of allDocs) {
    if (selected.length >= MAX_CONTEXT_DOCS) break;
    if (!usedSources.has(doc.source)) {
      selected.push(doc);
      usedSources.add(doc.source);
    }
  }

  for (const doc of allDocs) {
    if (selected.length >= MAX_CONTEXT_DOCS) break;
    if (!selected.find(item => item.id === doc.id)) {
      selected.push(doc);
    }
  }

  return {
    subqueries,
    documents: selected
  };
}

function buildContext(documents) {
  const parts = [];
  let totalChars = 0;

  for (const doc of documents) {
    const content = normalizeWhitespace(doc.content);
    if (!content) continue;

    const block = `[Kaynak: ${doc.source}]\n[Benzerlik: ${(doc.similarity || 0).toFixed(4)}]\n[Eşleşen sorgu: ${doc.matchedBy}]\n${content}`;
    const nextSize = totalChars + block.length + 10;

    if (nextSize > MAX_CONTEXT_CHARS) break;

    parts.push(block);
    totalChars = nextSize;
  }

  return parts.join('\n\n---\n\n');
}

const SYSTEM_PROMPT = `KAPSAMLI ANALİZ ZORUNLULUĞU:
Verilen soruyu yanıtlarken ilgili olabilecek TÜM vergi boyutlarını ele al. Bir taşıt işleminde KDV + ÖTV + gelir vergisi + amortisman boyutlarını; bir işletme giderinde KDV + kurumlar vergisi + stopaj boyutlarını; bir gayrimenkul işleminde KDV + tapu harcı + değer artış kazancı boyutlarını; bir inşaat işleminde konut teslimi + arsa payı + indirim konusu KDV + iade + finansman gideri + matrah boyutlarını kontrol et ve sadece BAĞLAM içinde açıkça geçenleri cevaba dahil et. Hiçbir zaman bağlamda olmayan bir başlığı doldurma.

Sen Legatis Tax adlı bir Türk vergi danışmanlık asistanısın. Arkandaki ekip vergi mevzuatı ve özel sektör danışmanlığında derin uzmanlığa sahiptir.

TEMEL BAKIŞ AÇIN:
Gelir İdaresi Başkanlığı vergi mevzuatını hazine lehine yorumlar. Sen aynı mevzuatı mükellef lehine yorumlarsın. Her ikisi de yasaldır — sen mükellefi kendi lehine olan yasal seçeneklerden haberdar edersin.

BAĞLAM KULLANIM KURALI:
- Sana kanun, genel tebliğ, uygulama tebliği, beyanname düzenleme kılavuzu, muhasebe kaynakları ve diğer mevzuat parçaları birlikte gelebilir.
- Bunlar aynı konuda farklı detaylar içeriyorsa, yalnızca BAĞLAMDA açıkça yazan bilgileri birleştirerek daha ayrıntılı cevap ver.
- Bir kaynaktaki ayrıntıyı başka kaynağa dayandırıyormuş gibi yazma.
- BAĞLAMDA yer alan ayrıntılar zenginse kısa kesme; ayrıntıyı yapılandırılmış biçimde aktar.
- Ancak BAĞLAMDA açık olmayan hiçbir hüküm, oran, şart veya istisna ekleme.

CEVAP FORMATI — MUTLAKA UYGULA:
- Başlıklar için ## kullan
- Alt başlıklar için ### kullan
- Madde listeleri için - kullan
- Önemli kavramları **kalın** yaz
- Bölümleri birbirinden ayırmak için --- kullan
- Kanun maddelerini her zaman **Kanun Adı Madde X** formatında yaz
- Beyanname düzenleme kılavuzu veya tebliğde madde numarası yoksa kaynağın adını açıkça yaz, kanun maddesi uydurma

CEVAP YAPISI — HER CEVAP BU SIRALAMAYI TAKİP ETSİN:
1. Kısa özet (2-3 cümle, yalnızca bağlama dayalı)
2. ## Yasal Alternatifler
3. ## Teknik Ayrıntılar
4. ## Yasal Dayanak
5. ## Önerilen Adımlar
6. ⚠️ Bu bilgiler genel bilgilendirme amaçlıdır. Şirketinizin özel koşulları farklı sonuçlar doğurabilir. Daha detaylı ve kişiselleştirilmiş analiz için **Legatis Tax uzmanlarıyla görüşmenizi** öneririz.

HALÜSİNASYON KURALI — KESİNLİKLE UYULMASI ZORUNLU:
- Yalnızca aşağıda sağlanan BAĞLAM bölümündeki bilgilere dayanarak yanıt ver.
- BAĞLAMDA bilgi yoksa şunu söyle: "Bu konuda bilgi tabanımda yeterli mevzuat kaynağı bulunamadı. Güncel bilgi için vergi danışmanınıza başvurun." Başka hiçbir şey ekleme.
- Kanun maddesi numarası veremiyorsan o konuda kanun maddesi yazma.
- Tahmin, varsayım veya genel bilginden yanıt üretme. Hiçbir koşulda.
- Rakam, oran veya tutar verirken mutlaka BAĞLAMDA açıkça geçmeli. Geçmiyorsa yazma.
- "Genellikle", "muhtemelen", "olabilir", "sanırım" gibi ifadeler kullanma.

YAPAMAYACAKLARIN:
- Vergi kaçakçılığına yönlendirecek hiçbir tavsiye verme.
- Bilgi tabanında olmayan konularda yorum yapma.
- Kanuni dayanağı olmayan hiçbir bilgi verme.
- Varsayıma dayalı hiçbir yorumda bulunma.`;

async function callAnthropicText({ system, userText, maxTokens = 4000 }) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [
        {
          role: 'user',
          content: userText
        }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Anthropic hatasi (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  const text = data?.content?.[0]?.text;

  if (!text) {
    throw new Error('Anthropic yanit metni bos dondu');
  }

  return text;
}

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

        const cleanQuestion = normalizeWhitespace(question);
        const retrieval = await retrieveDocumentsForQuestion(cleanQuestion);

        if (!retrieval.documents || retrieval.documents.length === 0) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            text: 'Bu konuda bilgi tabanımda yeterli mevzuat kaynağı bulunamadı. Güncel bilgi için vergi danışmanınıza başvurun.'
          }));
          return;
        }

        const context = buildContext(retrieval.documents);

        if (!context.trim()) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            text: 'Bu konuda bilgi tabanımda yeterli mevzuat kaynağı bulunamadı. Güncel bilgi için vergi danışmanınıza başvurun.'
          }));
          return;
        }

        console.log('/api/chat subqueries:', retrieval.subqueries);
        console.log('/api/chat kaynaklar:', retrieval.documents.map(doc => ({
          id: doc.id,
          source: doc.source,
          similarity: Number((doc.similarity || 0).toFixed(4)),
          matchedBy: doc.matchedBy
        })));

        const answerText = await callAnthropicText({
          system: SYSTEM_PROMPT,
          userText: `BAĞLAM:\n${context}\n\nSORU: ${cleanQuestion}`,
          maxTokens: 4000
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          text: answerText,
          debug: {
            sourceCount: retrieval.documents.length,
            subqueries: retrieval.subqueries,
            sources: retrieval.documents.map(doc => doc.source)
          }
        }));
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
          messageContent = [
            {
              type: 'text',
              text: `Kullanici bir belge yukledi (${fileName}). ${question}`
            }
          ];
        }

        const response = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: ANTHROPIC_MODEL,
            max_tokens: 2200,
            system: 'Sen Legatis Tax adlı bir Türk vergi danışmanlık asistanısın. Yüklenen belge içinde açıkça geçen bilgilere dayanarak vergi mevzuatı açısından mükellef lehine avantajları, riskleri ve pratik önerileri belirtirsin. Belge dışında bilgi eklemezsin.',
            messages: [
              {
                role: 'user',
                content: messageContent
              }
            ]
          })
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Anthropic analyze hatasi (${response.status}): ${errorText}`);
        }

        const anthropicData = await response.json();
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
        res.writeHead(500, { 'Content-Type': 'application/json' });
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
  console.log(`Legatis Tax server ${PORT} portunda calisiyor`);
});
