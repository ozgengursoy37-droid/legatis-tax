const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 8080;
const ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';

const RETRIEVAL_THRESHOLD = 0.70;
const RETRIEVAL_TOP_K = 14;
const MAX_SUBQUERIES = 8;
const MAX_CANDIDATE_DOCS = 28;
const MAX_PRIMARY_DOCS = 12;
const MAX_CONDITIONAL_DOCS = 4;
const MAX_CONTEXT_CHARS = 22000;
const DOC_PREVIEW_CHARS = 700;

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

function truncateText(text, max = DOC_PREVIEW_CHARS) {
  const clean = normalizeWhitespace(text);
  if (clean.length <= max) return clean;
  return clean.slice(0, max) + '...';
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
    hasIade: /\biade\b/i.test(lower),
    hasInsaat: /(inşaat|konut|arsa|müteahhit|taahhüt|şantiye)/i.test(lower),
    hasNakitAkisi: /(nakit|nakit akışı|ödeme güçlüğü|finansman baskısı)/i.test(lower),
    saysHighMonthlyKDV: /(her ay).*(kdv).*(yüksek|fazla|çok)/i.test(lower) || /(yüksek).*(kdv)/i.test(lower),
    mentionsKonut: /\bkonut\b/i.test(lower),
    mentionsArsa: /\barsa\b/i.test(lower),
    mentionsTicari: /(ticari|işyeri|ofis|dükkan|avm)/i.test(lower),
    mentionsRestorasyon: /(restorasyon|kültür varlığı|2863)/i.test(lower),
    mentions150m2: /(150\s*m²|150\s*m2|150 m²|150 m2|150m²|150m2)/i.test(lower),
    mentionsFinansman: /(finansman|kredi faizi|faiz gideri|banka kredisi|faiz)/i.test(lower),
    mentionsTesvik: /(teşvik|yatırım teşvik|yatırım teşvik belgesi|32\/a|32a)/i.test(lower),
    asksSolution: /(çözüm|öner|öneri|ne yapabiliriz|yol|yol haritası|nasıl azalt)/i.test(lower)
  };
}

function inferSpecialTags(doc) {
  const text = normalizeWhitespace(doc.content).toLowerCase();
  const source = getSourceName(doc).toLowerCase();
  const tags = [];

  if (text.includes('150 m²') || text.includes('150 m2') || text.includes('150m²') || text.includes('150m2')) tags.push('konut_150m2');
  if (text.includes('arsa karşılığı') || text.includes('arsa payı')) tags.push('arsa_karsiligi');
  if (text.includes('restorasyon') || text.includes('kültür varlığı') || text.includes('2863')) tags.push('restorasyon');
  if (text.includes('yatırım teşvik') || text.includes('teşvik belgesi') || text.includes('32/a') || text.includes('32a')) tags.push('tesvik');
  if (text.includes('indirimli oran')) tags.push('indirimli_oran');
  if (text.includes('iade')) tags.push('iade');
  if (text.includes('finansman') || text.includes('kredi faizi') || text.includes('faiz gideri')) tags.push('finansman');
  if (text.includes('konut')) tags.push('konut');
  if (text.includes('ticari') || text.includes('işyeri') || text.includes('dükkan') || text.includes('ofis')) tags.push('ticari_yapi');
  if (source.includes('beyanname düzenleme kılavuzu') || source.includes('beyanname düzenleme klavuzu')) tags.push('beyanname_kilavuzu');
  if (source.includes('genel uygulama tebli')) tags.push('uygulama_tebligi');
  if (source.includes('kanun')) tags.push('kanun');
  if (source.includes('genel muhasebe') || text.includes('maliyet unsuru') || text.includes('gider olarak dikkate')) tags.push('muhasebe');

  return uniqueStrings(tags);
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
      `${q} indirim konusu kdv`,
      `${q} hesaplanan kdv indirilecek kdv`
    );
  }

  if (facts.hasInsaat) {
    add(
      `${q} inşaat sektöründe kdv uygulaması`,
      `${q} inşaat kdv beyanname düzenleme kılavuzu`,
      `${q} inşaat sektöründe indirilecek kdv`,
      `${q} inşaat maliyet kdv`
    );
  }

  if (facts.hasIade) {
    add(
      `${q} iade usul esas`,
      `${q} indirim yoluyla giderilemeyen kdv`,
      `${q} iade talep şartları`
    );
  }

  if (facts.mentionsKonut || facts.mentions150m2) {
    add(
      `${q} konut teslimi indirimli oran`,
      `${q} 150 m2 altı konut kdv`
    );
  }

  if (facts.mentionsArsa) {
    add(
      `${q} arsa karşılığı inşaat`,
      `${q} arsa payı kdv matrah`
    );
  }

  if (facts.mentionsRestorasyon) {
    add(
      `${q} restorasyon kdv iade`,
      `${q} kültür varlığı kdv`
    );
  }

  if (facts.mentionsTesvik) {
    add(
      `${q} yatırım teşvik kdv`,
      `${q} teşvik belgesi kdv iadesi`
    );
  }

  if (facts.mentionsFinansman) {
    add(
      `${q} finansman gideri kdv`,
      `${q} kredi faizi maliyet gider`
    );
  }

  if (facts.hasKV) {
    add(
      `${q} kurumlar vergisi genel tebliği`,
      `${q} kurumlar vergisi beyanname düzenleme kılavuzu`
    );
  }

  if (facts.hasGV || facts.hasStopaj) {
    add(
      `${q} gelir vergisi tevkifat`,
      `${q} stopaj beyan`
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

function scoreDocument(doc) {
  return (doc.similarity || 0) + (doc.sourcePriority || 0) * 0.015;
}

async function retrieveCandidateDocuments(question) {
  const facts = extractQuestionFacts(question);
  const subqueries = buildDeterministicSubqueries(question);
  const merged = new Map();

  for (const subquery of subqueries) {
    const embedding = await getEmbedding(subquery);
    const docs = await searchDocuments(embedding, RETRIEVAL_TOP_K, RETRIEVAL_THRESHOLD);

    for (const doc of docs) {
      const key = String(doc.id);
      const source = getSourceName(doc);
      const enriched = {
        ...doc,
        source,
        sourcePriority: getSourcePriority(source),
        matchedBy: subquery,
        specialTags: inferSpecialTags(doc)
      };

      const existing = merged.get(key);
      if (!existing || scoreDocument(enriched) > scoreDocument(existing)) {
        merged.set(key, enriched);
      }
    }
  }

  const allDocs = [...merged.values()].sort((a, b) => scoreDocument(b) - scoreDocument(a));

  return {
    facts,
    subqueries,
    documents: allDocs.slice(0, MAX_CANDIDATE_DOCS)
  };
}

function buildDocPreview(doc) {
  return {
    id: String(doc.id),
    source: doc.source,
    similarity: Number((doc.similarity || 0).toFixed(4)),
    matchedBy: doc.matchedBy,
    specialTags: doc.specialTags || [],
    preview: truncateText(doc.content, DOC_PREVIEW_CHARS)
  };
}

function parseJsonFromText(text) {
  const raw = String(text || '').trim();

  try {
    return JSON.parse(raw);
  } catch (_) {}

  const fenced = raw.match(/```json\s*([\s\S]*?)```/i) || raw.match(/```\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch (_) {}
  }

  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch (_) {}
  }

  throw new Error('JSON parse edilemedi');
}

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

async function classifyCandidateDocuments(question, facts, candidateDocs) {
  const previews = candidateDocs.map(buildDocPreview);

  const classifierSystem = `Sen bir vergi danışmanlık sisteminde çalışan "kaynak seçici" modülsün. Görevin cevap yazmak değil, yalnızca kullanıcının sorusuna gerçekten uygun kaynak parçalarını seçmektir.

KURALLAR:
- Yalnızca kullanıcı sorusu, çıkarılan olgular ve aday kaynak özetlerine bak.
- Genel vergi bilgisi kullanma.
- Soruda açıkça doğrulanmayan özel rejimleri ana kaynak olarak seçme.
- Özellikle şu başlıklar soruda açık tetikleyici yoksa reddedilmeli veya en fazla conditional seçilmeli:
  - yatırım teşvik / teşvik belgesi
  - restorasyon / 2863
  - 150 m² altı konut
  - arsa karşılığı inşaat
- Kullanıcının sorusu genel ise ana kaynaklar, doğrudan sorunun merkezine hizmet eden genel KDV / inşaat / muhasebe / uygulama parçaları olmalı.
- Şarta bağlı kaynaklar en fazla birkaç adet olmalı.
- Uygunsuz kaynakları reddet.

SADECE JSON DÖNDÜR:
{
  "selected_ids": ["..."],
  "conditional_ids": ["..."],
  "rejected_ids": ["..."],
  "issue_focus": ["..."],
  "missing_facts": ["..."],
  "reasoning_summary": "..."
}`;

  const classifierUserText = `KULLANICI SORUSU:
${question}

SORUDAN ÇIKARILAN OLGULAR:
${JSON.stringify(facts, null, 2)}

ADAY KAYNAKLAR:
${JSON.stringify(previews, null, 2)}

Yalnızca JSON döndür.`;

  const raw = await callAnthropicText({
    system: classifierSystem,
    userText: classifierUserText,
    maxTokens: 1800
  });

  const parsed = parseJsonFromText(raw);

  const selectedIds = Array.isArray(parsed.selected_ids) ? parsed.selected_ids.map(String) : [];
  const conditionalIds = Array.isArray(parsed.conditional_ids) ? parsed.conditional_ids.map(String) : [];
  const rejectedIds = Array.isArray(parsed.rejected_ids) ? parsed.rejected_ids.map(String) : [];
  const issueFocus = Array.isArray(parsed.issue_focus) ? parsed.issue_focus.map(item => normalizeWhitespace(item)).filter(Boolean) : [];
  const missingFacts = Array.isArray(parsed.missing_facts) ? parsed.missing_facts.map(item => normalizeWhitespace(item)).filter(Boolean) : [];
  const reasoningSummary = normalizeWhitespace(parsed.reasoning_summary || '');

  return {
    selectedIds,
    conditionalIds,
    rejectedIds,
    issueFocus,
    missingFacts,
    reasoningSummary
  };
}

function shouldHardExclude(doc, facts) {
  const tags = doc.specialTags || [];

  if (tags.includes('tesvik') && !facts.mentionsTesvik) return true;
  if (tags.includes('restorasyon') && !facts.mentionsRestorasyon) return true;
  if (tags.includes('konut_150m2') && !(facts.mentionsKonut || facts.mentions150m2)) return true;
  if (tags.includes('arsa_karsiligi') && !facts.mentionsArsa) return true;

  return false;
}

function fallbackSelectDocuments(facts, candidateDocs) {
  const primary = [];
  const conditional = [];

  for (const doc of candidateDocs) {
    if (shouldHardExclude(doc, facts)) continue;

    const tags = doc.specialTags || [];
    const isConditional =
      (tags.includes('konut_150m2') && !(facts.mentionsKonut || facts.mentions150m2)) ||
      (tags.includes('arsa_karsiligi') && !facts.mentionsArsa) ||
      (tags.includes('restorasyon') && !facts.mentionsRestorasyon) ||
      (tags.includes('tesvik') && !facts.mentionsTesvik);

    if (isConditional) {
      if (conditional.length < MAX_CONDITIONAL_DOCS) conditional.push(doc);
    } else {
      if (primary.length < MAX_PRIMARY_DOCS) primary.push(doc);
    }
  }

  return {
    primaryDocs: primary,
    conditionalDocs: conditional,
    issueFocus: [],
    missingFacts: [],
    reasoningSummary: 'Fallback secim kullanildi'
  };
}

function resolveSelectedDocuments(facts, candidateDocs, classification) {
  const byId = new Map(candidateDocs.map(doc => [String(doc.id), doc]));

  const primaryDocs = [];
  const conditionalDocs = [];

  for (const id of classification.selectedIds || []) {
    const doc = byId.get(String(id));
    if (!doc) continue;
    if (shouldHardExclude(doc, facts)) continue;
    if (!primaryDocs.find(item => String(item.id) === String(doc.id)) && primaryDocs.length < MAX_PRIMARY_DOCS) {
      primaryDocs.push(doc);
    }
  }

  for (const id of classification.conditionalIds || []) {
    const doc = byId.get(String(id));
    if (!doc) continue;
    if (shouldHardExclude(doc, facts)) continue;
    if (
      !primaryDocs.find(item => String(item.id) === String(doc.id)) &&
      !conditionalDocs.find(item => String(item.id) === String(doc.id)) &&
      conditionalDocs.length < MAX_CONDITIONAL_DOCS
    ) {
      conditionalDocs.push(doc);
    }
  }

  if (primaryDocs.length === 0) {
    return fallbackSelectDocuments(facts, candidateDocs);
  }

  return {
    primaryDocs,
    conditionalDocs,
    issueFocus: classification.issueFocus || [],
    missingFacts: classification.missingFacts || [],
    reasoningSummary: classification.reasoningSummary || ''
  };
}

function buildAnswerContext(primaryDocs, conditionalDocs) {
  const blocks = [];
  let totalChars = 0;

  const pushDoc = (doc, groupLabel) => {
    const content = normalizeWhitespace(doc.content);
    if (!content) return;

    const block = `[Grup: ${groupLabel}]
[Kaynak: ${doc.source}]
[Benzerlik: ${(doc.similarity || 0).toFixed(4)}]
[Eşleşen sorgu: ${doc.matchedBy}]
[Etiketler: ${(doc.specialTags || []).join(', ') || '-'}]
${content}`;

    const nextSize = totalChars + block.length + 10;
    if (nextSize > MAX_CONTEXT_CHARS) return;

    blocks.push(block);
    totalChars = nextSize;
  };

  for (const doc of primaryDocs) pushDoc(doc, 'ANA');
  for (const doc of conditionalDocs) pushDoc(doc, 'ŞARTA_BAĞLI');

  return blocks.join('\n\n---\n\n');
}

const ANSWER_SYSTEM_PROMPT = `Sen Legatis Tax adlı bir Türk vergi danışmanlık asistanısın. Kullanıcıya Google gibi sonuç sıralayan bir arama motoru gibi değil, mevzuata dayalı çalışan kıdemli bir vergi danışmanı gibi yanıt verirsin.

EN ÖNEMLİ KURAL:
- Yalnızca BAĞLAM içindeki bilgilere dayan.
- BAĞLAMDA olmayan hiçbir hüküm, oran, şart, istisna, sonuç veya senaryo ekleme.
- BAĞLAMDA "Grup: ŞARTA_BAĞLI" olarak işaretlenen kaynakları yalnızca kısa ve ikincil biçimde kullan.
- Ana çözüm bölümünü yalnızca "Grup: ANA" kaynaklarıyla kur.

DANIŞMANLIK DAVRANIŞI:
- Önce sorudaki somut problemi 2-3 cümleyle çerçevele.
- Sonra kullanıcı için gerçekten uygulanabilir 2-4 ana çözüm ekseni yaz.
- Soruda doğrulanmayan özel rejimleri ana çözüm gibi anlatma.
- Kullanıcıya öncelik sırasına göre yol göster.
- Cevap genel başlık yığını gibi değil, seçici danışmanlık notu gibi olsun.

KAYNAK KULLANIMI:
- Kanun, tebliğ, uygulama tebliği, beyanname düzenleme kılavuzu ve muhasebe kaynaklarını yalnızca BAĞLAMDA açıkça geçen noktalarda birleştir.
- Bir kaynaktaki ayrıntıyı başka kaynağa dayandırıyormuş gibi yazma.
- Madde numarası yoksa uydurma madde yazma.
- Beyanname Düzenleme Kılavuzu veya muhasebe kaynağındaki teknik ayrıntıyı açıkça o kaynağa bağla.

CEVAP BİÇİMİ:
1. Kısa değerlendirme
2. ## Sorudaki Durumun Vergisel Çerçevesi
3. ## Doğrudan Uygulanabilir Seçenekler
4. ## Şarta Bağlı Değerlendirilmesi Gereken Başlıklar
5. ## Yasal Dayanak
6. ## Pratik Yol Haritası
7. Gerekirse: Netleştirilmesi gereken hususlar

YAZIM KURALLARI:
- Başlıklar için ## kullan
- Alt başlıklar için ### kullan
- Madde listeleri için - kullan
- Önemli kavramları **kalın** yaz
- Aynı bilgiyi tekrar etme
- Boş süslü cümle kurma
- "genellikle", "muhtemelen", "olabilir", "sanırım" gibi ifadeleri kullanma

HALÜSİNASYON YASAĞI:
- Yalnızca BAĞLAM'a dayan.
- BAĞLAMDA bilgi yoksa şunu söyle:
"Bu konuda bilgi tabanımda yeterli mevzuat kaynağı bulunamadı. Güncel bilgi için vergi danışmanınıza başvurun."`;

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

        const retrieval = await retrieveCandidateDocuments(cleanQuestion);
        if (!retrieval.documents || retrieval.documents.length === 0) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            text: 'Bu konuda bilgi tabanımda yeterli mevzuat kaynağı bulunamadı. Güncel bilgi için vergi danışmanınıza başvurun.'
          }));
          return;
        }

        let classification;
        try {
          classification = await classifyCandidateDocuments(cleanQuestion, retrieval.facts, retrieval.documents);
        } catch (classificationError) {
          console.error('/api/chat classification hatasi:', classificationError);
          classification = {
            selectedIds: [],
            conditionalIds: [],
            rejectedIds: [],
            issueFocus: [],
            missingFacts: [],
            reasoningSummary: 'Classification fallback'
          };
        }

        const resolved = resolveSelectedDocuments(retrieval.facts, retrieval.documents, classification);

        if (!resolved.primaryDocs || resolved.primaryDocs.length === 0) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            text: 'Bu konuda bilgi tabanımda yeterli mevzuat kaynağı bulunamadı. Güncel bilgi için vergi danışmanınıza başvurun.'
          }));
          return;
        }

        const context = buildAnswerContext(resolved.primaryDocs, resolved.conditionalDocs);

        if (!context.trim()) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            text: 'Bu konuda bilgi tabanımda yeterli mevzuat kaynağı bulunamadı. Güncel bilgi için vergi danışmanınıza başvurun.'
          }));
          return;
        }

        console.log('/api/chat facts:', retrieval.facts);
        console.log('/api/chat subqueries:', retrieval.subqueries);
        console.log('/api/chat classification:', classification);
        console.log('/api/chat primary sources:', resolved.primaryDocs.map(doc => ({
          id: doc.id,
          source: doc.source,
          similarity: Number((doc.similarity || 0).toFixed(4)),
          tags: doc.specialTags || []
        })));
        console.log('/api/chat conditional sources:', resolved.conditionalDocs.map(doc => ({
          id: doc.id,
          source: doc.source,
          similarity: Number((doc.similarity || 0).toFixed(4)),
          tags: doc.specialTags || []
        })));

        const answerText = await callAnthropicText({
          system: ANSWER_SYSTEM_PROMPT,
          userText: `KULLANICI SORUSU:
${cleanQuestion}

SORUDAN ÇIKARILAN OLGULAR:
${JSON.stringify(retrieval.facts, null, 2)}

KAYNAK SEÇİMİNİN ODAĞI:
${JSON.stringify(resolved.issueFocus || [], null, 2)}

NETLEŞTİRİLMESİ GEREKEBİLECEK HUSUSLAR:
${JSON.stringify(resolved.missingFacts || [], null, 2)}

GÖREV:
- Cevabı yalnızca ANA kaynaklar üzerine kur.
- ŞARTA_BAĞLI kaynakları kısa ve ikinci planda kullan.
- Soruda geçmeyen özel rejimleri ana çözüm gibi anlatma.
- Kullanıcıya mevzuata dayalı yol gösteren danışman gibi konuş.
- En fazla 2-4 ana çözüm ekseni yaz.
- Pratik yol haritasında önce hangi verilerin kontrol edilmesi gerektiğini sırala.

BAĞLAM:
${context}`,
          maxTokens: 3200
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          text: answerText,
          debug: {
            sourceCount: retrieval.documents.length,
            selectedPrimaryCount: resolved.primaryDocs.length,
            selectedConditionalCount: resolved.conditionalDocs.length,
            subqueries: retrieval.subqueries,
            facts: retrieval.facts,
            primarySources: resolved.primaryDocs.map(doc => doc.source),
            conditionalSources: resolved.conditionalDocs.map(doc => doc.source),
            issueFocus: resolved.issueFocus,
            missingFacts: resolved.missingFacts,
            reasoningSummary: resolved.reasoningSummary
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
