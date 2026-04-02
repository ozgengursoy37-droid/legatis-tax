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
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function uniqueStrings(items) {
  return [...new Set(items.map(item => normalizeWhitespace(item)).filter(Boolean))];
}

function getSourceName(doc) {
  return normalizeWhitespace(doc?.metadata?.source || 'Bilinmiyor');
}

function getSourcePriority(source) {
  const s = source.toLowerCase();

  if (s.includes('beyanname düzenleme klavuzu') || s.includes('beyanname düzenleme kılavuzu')) return 6;
  if (s.includes('genel muhasebe')) return 5;
  if (s.includes('genel uygulama tebli')) return 4;
  if (s.includes('genel tebli')) return 4;
  if (s.includes('kanunu') || s.includes('kanun')) return 3;
  if (s.includes('rehber') || s.includes('kılavuz') || s.includes('klavuz')) return 3;
  if (s.includes('özelge')) return 2;

  return 1;
}

function extractQuestionFacts(question) {
  const q = normalizeWhitespace(question);
  const lower = q.toLowerCase();

  return {
    raw: q,
    hasKDV: /(kdv|katma değer vergisi)/i.test(lower),
    hasKV: /(kurumlar vergisi|kvk)/i.test(lower),
    hasGV: /(gelir vergisi|gvk)/i.test(lower),
    hasStopaj: /(stopaj|tevkifat)/i.test(lower),
    hasIade: /(iade)/i.test(lower),
    hasInsaat: /(inşaat|konut|arsa|müteahhit|taahhüt)/i.test(lower),
    saysHighMonthlyKDV: /(her ay).*(kdv).*(yüksek|fazla|çok)/i.test(lower) || /(yüksek).*(kdv)/i.test(lower),
    mentionsKonut: /(konut)/i.test(lower),
    mentionsArsa: /(arsa)/i.test(lower),
    mentionsTicari: /(ticari|işyeri|ofis|dükkan|avm)/i.test(lower),
    mentionsRestorasyon: /(restorasyon|kültür varlığı|2863)/i.test(lower),
    mentions150m2: /(150\s*m²|150\s*m2|150 m²|150 m2)/i.test(lower),
    mentionsFinansman: /(finansman|kredi faizi|faiz gideri|faiz|banka kredisi)/i.test(lower)
  };
}

function buildDeterministicSubqueries(question) {
  const q = normalizeWhitespace(question);
  const facts = extractQuestionFacts(q);
  const queries = [q];

  const add = (...items) => {
    for (const item of items) {
      if (item) queries.push(item);
    }
  };

  if (facts.hasKDV) {
    add(
      `${q} kdv uygulama genel tebliği`,
      `${q} kdv beyanname düzenleme kılavuzu`,
      `${q} indirim konusu kdv iade matrah`
    );
  }

  if (facts.hasKV) {
    add(
      `${q} kurumlar vergisi genel tebliği`,
      `${q} kurumlar vergisi beyanname düzenleme kılavuzu`,
      `${q} kurum kazancı istisna indirim gider`
    );
  }

  if (facts.hasGV || facts.hasStopaj) {
    add(
      `${q} gelir vergisi kanunu tevkifat`,
      `${q} gelir vergisi beyanname düzenleme kılavuzu`,
      `${q} stopaj kesinti beyan`
    );
  }

  if (/(vuk|vergi usul|muhasebe|mizan|bilanço|defter|belge)/i.test(q.toLowerCase())) {
    add(
      `${q} vergi usul kanunu`,
      `${q} muhasebe sistemi uygulama genel tebliği`,
      `${q} genel muhasebe`
    );
  }

  if (/(teşvik|yatırım|indirimli kurumlar|32\/a|32a)/i.test(q.toLowerCase())) {
    add(
      `${q} yatırım teşvik indirimli kurumlar`,
      `${q} kurumlar vergisi kanunu 32a`,
      `${q} teşvik uygulama`
    );
  }

  if (facts.hasInsaat) {
    add(
      `${q} inşaat kdv indirim iade matrah`,
      `${q} beyanname düzenleme kılavuzu inşaat`,
      `${q} inşaat sektöründe kdv uygulaması`
    );

    if (facts.mentionsKonut || facts.mentions150m2) {
      add(
        `${q} konut teslimi 150 m2 altı kdv iadesi`,
        `${q} indirimli oranlı konut teslimi`
      );
    }

    if (facts.mentionsArsa) {
      add(
        `${q} arsa karşılığı inşaat`,
        `${q} arsa payı teslimi matrah kdv`
      );
    }

    if (facts.mentionsFinansman) {
      add(
        `${q} finansman gideri maliyet bedeli`,
        `${q} kredi faizi kdv matrah maliyet`
      );
    }
  }

  if (facts.hasIade) {
    add(
      `${q} iade usul esas`,
      `${q} iade talep şartları`,
      `${q} indirim yoluyla giderilemeyen kdv`
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

function isDocConditionallyRelevant(doc, facts) {
  const source = getSourceName(doc).toLowerCase();
  const content = normalizeWhitespace(doc.content).toLowerCase();

  if (!facts.hasInsaat) return false;

  if (content.includes('150 m²') || content.includes('150 m2') || content.includes('150m²') || content.includes('150m2')) {
    return !(facts.mentionsKonut || facts.mentions150m2);
  }

  if (content.includes('arsa karşılığı') || content.includes('arsa payı')) {
    return !facts.mentionsArsa;
  }

  if (content.includes('kültür varlığı') || content.includes('restorasyon') || content.includes('2863')) {
    return !facts.mentionsRestorasyon;
  }

  if (content.includes('finansman gideri') || content.includes('kredi')) {
    return !facts.mentionsFinansman;
  }

  if (source.includes('beyanname düzenleme kılavuzu') && content.includes('konut')) {
    return !facts.mentionsKonut;
  }

  return false;
}

async function retrieveDocumentsForQuestion(question) {
  const facts = extractQuestionFacts(question);
  const subqueries = buildDeterministicSubqueries(question);
  const merged = new Map();

  for (const subquery of subqueries) {
    const embedding = await getEmbedding(subquery);
    const docs = await searchDocuments(embedding, RETRIEVAL_TOP_K, RETRIEVAL_THRESHOLD);

    for (const doc of docs) {
      const key = String(doc.id);
      const existing = merged.get(key);
      const source = getSourceName(doc);

      const enriched = {
        ...doc,
        source,
        sourcePriority: getSourcePriority(source),
        matchedBy: subquery,
        conditional: isDocConditionallyRelevant(doc, facts)
      };

      if (!existing) {
        merged.set(key, enriched);
        continue;
      }

      const existingScore = (existing.similarity || 0) + (existing.sourcePriority || 0) * 0.015;
      const newScore = (enriched.similarity || 0) + (enriched.sourcePriority || 0) * 0.015;

      if (newScore > existingScore) {
        merged.set(key, { ...existing, ...enriched });
      }
    }
  }

  const allDocs = [...merged.values()].sort((a, b) => {
    const aConditionalPenalty = a.conditional ? 0.04 : 0;
    const bConditionalPenalty = b.conditional ? 0.04 : 0;

    const aScore = (a.similarity || 0) + (a.sourcePriority || 0) * 0.015 - aConditionalPenalty;
    const bScore = (b.similarity || 0) + (b.sourcePriority || 0) * 0.015 - bConditionalPenalty;

    return bScore - aScore;
  });

  const primary = [];
  const secondary = [];
  const usedSources = new Set();

  for (const doc of allDocs) {
    if (!doc.conditional && primary.length < Math.ceil(MAX_CONTEXT_DOCS * 0.7)) {
      if (!usedSources.has(doc.source)) {
        primary.push(doc);
        usedSources.add(doc.source);
      }
    }
  }

  for (const doc of allDocs) {
    if (!doc.conditional && primary.length < Math.ceil(MAX_CONTEXT_DOCS * 0.7)) {
      if (!primary.find(item => item.id === doc.id)) {
        primary.push(doc);
      }
    }
  }

  for (const doc of allDocs) {
    if (doc.conditional && secondary.length < Math.floor(MAX_CONTEXT_DOCS * 0.3)) {
      if (!secondary.find(item => item.id === doc.id)) {
        secondary.push(doc);
      }
    }
  }

  const documents = [...primary, ...secondary].slice(0, MAX_CONTEXT_DOCS);

  return {
    subqueries,
    documents,
    facts
  };
}

function buildContext(documents) {
  const parts = [];
  let totalChars = 0;

  for (const doc of documents) {
    const content = normalizeWhitespace(doc.content);
    if (!content) continue;

    const conditionalLabel = doc.conditional ? 'Evet' : 'Hayır';
    const block = `[Kaynak: ${doc.source}]
[Benzerlik: ${(doc.similarity || 0).toFixed(4)}]
[Eşleşen sorgu: ${doc.matchedBy}]
[Şarta bağlı başlık: ${conditionalLabel}]
${content}`;

    const nextSize = totalChars + block.length + 10;
    if (nextSize > MAX_CONTEXT_CHARS) break;

    parts.push(block);
    totalChars = nextSize;
  }

  return parts.join('\n\n---\n\n');
}

const SYSTEM_PROMPT = `Sen Legatis Tax adlı bir Türk vergi danışmanlık asistanısın. Kullanıcıya Google gibi sonuç sıralayan bir arama motoru gibi değil, mevzuata dayalı çalışan kıdemli bir vergi danışmanı gibi yanıt verirsin.

TEMEL KURAL:
- Yalnızca BAĞLAM içinde açıkça yer alan bilgilere dayan.
- BAĞLAMDA olmayan hiçbir hüküm, oran, şart, istisna, süre, sonuç veya senaryo ekleme.
- Soru metninde doğrulanmayan alt senaryoları ana çözüm gibi yazma.
- BAĞLAM içinde "Şarta bağlı başlık: Evet" olarak işaretlenen metinleri yalnızca ikincil ve sınırlı biçimde kullan.

DANIŞMANLIK YAKLAŞIMI:
- Önce kullanıcının sorusundaki kesin olguları esas al.
- Sonra sadece bu kesin olgularla doğrudan ilişkili çözümleri ana bölümde yaz.
- Soruda doğrulanmayan ama bağlamda geçen alt senaryoları kısa tut ve ayrı bölüme koy.
- Ana cevapta kullanıcıya öncelik sırasına göre yol göster.
- Kullanıcının olayına temas etmeyen başlıkları sırf bağlamda var diye yazma.
- "genellikle" tarzı soyut cümlelerle genel sektör anlatısı kurma.

KAYNAK KULLANIMI:
- Kanun, tebliğ, uygulama tebliği, beyanname düzenleme kılavuzu, muhasebe kaynakları birlikte gelebilir.
- Bunlar aynı konuda farklı ayrıntılar içeriyorsa yalnızca BAĞLAMDA açıkça bulunan noktaları birleştir.
- Bir kaynaktaki ayrıntıyı başka kaynağa dayandırıyormuş gibi yazma.
- Madde numarası yoksa uydurma madde yazma.
- Beyanname Düzenleme Kılavuzu veya muhasebe kaynağındaki teknik ayrıntıyı açıkça kendi kaynağına bağla.

CEVAP BİÇİMİ:
- Başlıklar için ## kullan
- Alt başlıklar için ### kullan
- Madde listeleri için - kullan
- Önemli kavramları **kalın** yaz
- Bölümleri birbirinden ayırmak için --- kullan

HER CEVAP ŞU SIRAYI İZLESİN:
1. Kısa değerlendirme
2. ## Sorudaki Durumun Vergisel Çerçevesi
3. ## Doğrudan Uygulanabilir Seçenekler
4. ## Şarta Bağlı Değerlendirilmesi Gereken Başlıklar
5. ## Yasal Dayanak
6. ## Pratik Yol Haritası
7. Gerekirse tek paragraf: Netleştirilmesi gereken hususlar

YAZIM KURALI:
- Cevap arama motoru özeti gibi değil, seçici ve isabetli danışmanlık notu gibi olmalı.
- Ana bölümde en fazla 2-4 ana çözüm ekseni yaz.
- Şarta bağlı bölüm kısa olmalı; soru sahibinin olayı doğrulamıyorsa orayı ana gövdeye taşıma.
- Sorunun içinde açıkça geçmeyen faaliyet/işlem türünü kesinmiş gibi yazma.
- Bağlam zenginse ayrıntı ver ama gereksiz başlık çoğaltma.
- Aynı bilgiyi tekrar etme.

HALÜSİNASYON KURALI:
- Yalnızca BAĞLAM'a dayan.
- BAĞLAMDA bilgi yoksa şunu söyle:
"Bu konuda bilgi tabanımda yeterli mevzuat kaynağı bulunamadı. Güncel bilgi için vergi danışmanınıza başvurun."
- Tahmin, varsayım veya genel bilgiden yanıt üretme.
- Rakam, oran, süre, şart veya sonuç BAĞLAMDA açıkça yoksa yazma.
- "genellikle", "muhtemelen", "olabilir", "sanırım" gibi ifadeleri kullanma.

YASAKLAR:
- Vergi kaçakçılığına yönlendirecek tavsiye verme.
- BAĞLAMDA olmayan konuda hüküm verme.
- Kullanıcının olayında doğrulanmamış bir alt senaryoyu kesinmiş gibi anlatma.`;

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
        console.log('/api/chat facts:', retrieval.facts);
        console.log('/api/chat kaynaklar:', retrieval.documents.map(doc => ({
          id: doc.id,
          source: doc.source,
          similarity: Number((doc.similarity || 0).toFixed(4)),
          matchedBy: doc.matchedBy,
          conditional: doc.conditional
        })));

        const answerText = await callAnthropicText({
          system: SYSTEM_PROMPT,
          userText: `KULLANICI SORUSU:
${cleanQuestion}

SORUDAN ÇIKARILAN KESİN OLGULAR:
${JSON.stringify(retrieval.facts, null, 2)}

GÖREV:
- Bu soruya arama motoru gibi değil, mevzuata dayalı yol gösteren kıdemli bir vergi danışmanı gibi yanıt ver.
- Önce yalnızca kullanıcı sorusunda açıkça doğrulanan olguları esas al.
- Ana çözüm bölümünde yalnızca bu doğrulanmış olgularla doğrudan ilgili başlıkları kullan.
- BAĞLAMDA "Şarta bağlı başlık: Evet" olarak gelen metinleri yalnızca ikincil başlıkta ve kısa biçimde kullan.
- Kullanıcının olayında doğrulanmamış alt senaryoları ana çözüm gibi anlatma.
- İlk bölümde mevcut sorunu 2-3 cümleyle çerçevele ama soru metninde olmayan faaliyet/işlem türünü ekleme.
- Doğrudan uygulanabilir bölümünde en fazla 2-4 ana başlık yaz.
- Pratik yol haritasında önce hangi verinin kontrol edilmesi gerektiğini sırala.
- Yasal dayanakta kaynakları açıkça göster.
- Eğer soru, bazı başlıkları kesinleştirmeye yetmiyorsa bunu yalnızca son bölümde belirt.

BAĞLAM:
${context}`,
          maxTokens: 4000
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          text: answerText,
          debug: {
            sourceCount: retrieval.documents.length,
            subqueries: retrieval.subqueries,
            sources: retrieval.documents.map(doc => doc.source),
            facts: retrieval.facts
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
