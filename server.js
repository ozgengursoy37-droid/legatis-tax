const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 8080;
const ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';

const RETRIEVAL_THRESHOLD = 0.71;
const RETRIEVAL_TOP_K = 12;
const MAX_SUBQUERIES = 8;
const MAX_SELECTED_DOCS = 14;
const MAX_CONTEXT_CHARS = 22000;
const DOC_PREVIEW_CHARS = 900;

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
    hasInsaat: /(inşaat|konut|arsa|müteahhit|taahhüt|şantiye)/i.test(lower),
    saysHighMonthlyKDV: /(her ay).*(kdv).*(yüksek|fazla|çok)/i.test(lower) || /(yüksek).*(kdv)/i.test(lower),
    asksSolution: /(çözüm|öner|öneri|yol|nasıl azalt|nasıl düşür|ne yapabiliriz)/i.test(lower),
    mentionsIade: /\biade\b/i.test(lower),
    mentionsKonut: /\bkonut\b/i.test(lower),
    mentionsArsa: /\barsa\b/i.test(lower),
    mentionsRestorasyon: /(restorasyon|kültür varlığı|2863)/i.test(lower),
    mentionsTesvik: /(teşvik|yatırım teşvik|yatırım teşvik belgesi|32\/a|32a)/i.test(lower),
    mentions150m2: /(150\s*m²|150\s*m2|150 m²|150 m2|150m²|150m2)/i.test(lower),
    mentionsFinansman: /(finansman|kredi faizi|faiz gideri|banka kredisi|faiz)/i.test(lower),
    mentionsTicariYapi: /(ticari|işyeri|ofis|dükkan|avm)/i.test(lower)
  };
}

function determineQuestionProfile(facts) {
  if (
    facts.hasInsaat &&
    facts.hasKDV &&
    facts.saysHighMonthlyKDV &&
    !facts.mentionsIade &&
    !facts.mentionsKonut &&
    !facts.mentionsArsa &&
    !facts.mentionsRestorasyon &&
    !facts.mentionsTesvik &&
    !facts.mentions150m2
  ) {
    return 'insaat_yuksek_kdv_genel';
  }

  if (facts.hasInsaat && facts.hasKDV && facts.mentionsKonut) {
    return 'insaat_konut_kdv';
  }

  if (facts.hasInsaat && facts.hasKDV && facts.mentionsArsa) {
    return 'insaat_arsa_kdv';
  }

  return 'genel';
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
  if (text.includes('promosyon')) tags.push('promosyon');
  if (text.includes('devreden kdv')) tags.push('devreden_kdv');
  if (text.includes('indirilecek kdv')) tags.push('indirilecek_kdv');
  if (text.includes('hesaplanan kdv')) tags.push('hesaplanan_kdv');
  if (text.includes('maliyet unsuru') || text.includes('gider olarak dikkate') || text.includes('gider veya maliyet')) tags.push('maliyet_gider');
  if (source.includes('beyanname düzenleme kılavuzu') || source.includes('beyanname düzenleme klavuzu')) tags.push('beyanname_kilavuzu');
  if (source.includes('genel uygulama tebli')) tags.push('uygulama_tebligi');
  if (source.includes('kanun')) tags.push('kanun');
  if (source.includes('genel muhasebe')) tags.push('muhasebe');

  return uniqueStrings(tags);
}

function buildDeterministicSubqueries(question, facts, profile) {
  const q = normalizeWhitespace(question);
  const queries = [q];

  const add = (...items) => {
    for (const item of items) {
      if (item) queries.push(item);
    }
  };

  if (profile === 'insaat_yuksek_kdv_genel') {
    add(
      'inşaat sektöründe yüksek çıkan kdv indirilecek kdv hesaplanan kdv',
      'inşaat sektöründe kdv indirim mekanizması',
      'inşaat sektöründe devreden kdv beyanname düzenleme kılavuzu',
      'inşaat sektöründe kdv uygulama genel tebliği',
      'indirilecek kdv hesaplanan kdv genel yönetim giderleri',
      'maliyet unsuru gider unsuru kdv beyanname düzenleme kılavuzu',
      'kdv kanunu 29 indirim hakkı',
      'devreden kdv indirim konusu yapılması'
    );
  } else {
    if (facts.hasKDV) {
      add(
        `${q} kdv uygulama genel tebliği`,
        `${q} kdv beyanname düzenleme kılavuzu`,
        `${q} indirilecek kdv hesaplanan kdv`
      );
    }

    if (facts.hasInsaat) {
      add(
        `${q} inşaat sektöründe kdv uygulaması`,
        `${q} inşaat kdv beyanname düzenleme kılavuzu`,
        `${q} inşaat maliyet kdv`
      );
    }

    if (facts.mentionsIade) {
      add(
        `${q} iade usul esas`,
        `${q} indirim yoluyla giderilemeyen kdv`
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
        `${q} restorasyon kdv`,
        `${q} kültür varlığı kdv`
      );
    }

    if (facts.mentionsTesvik) {
      add(
        `${q} yatırım teşvik kdv`,
        `${q} teşvik belgesi kdv`
      );
    }

    if (facts.mentionsFinansman) {
      add(
        `${q} finansman gideri kdv`,
        `${q} kredi faizi maliyet gider`
      );
    }
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

function isHardExcluded(doc, facts, profile) {
  const tags = doc.specialTags || [];

  if (profile === 'insaat_yuksek_kdv_genel') {
    if (tags.includes('tesvik')) return true;
    if (tags.includes('restorasyon')) return true;
    if (tags.includes('konut_150m2')) return true;
    if (tags.includes('arsa_karsiligi')) return true;
    if (tags.includes('promosyon')) return true;
    if (tags.includes('indirimli_oran')) return true;
    if (tags.includes('konut') && !facts.mentionsKonut) return true;
  }

  if (tags.includes('tesvik') && !facts.mentionsTesvik) return true;
  if (tags.includes('restorasyon') && !facts.mentionsRestorasyon) return true;
  if (tags.includes('konut_150m2') && !(facts.mentionsKonut || facts.mentions150m2)) return true;
  if (tags.includes('arsa_karsiligi') && !facts.mentionsArsa) return true;
  if (tags.includes('promosyon') && profile === 'insaat_yuksek_kdv_genel') return true;

  return false;
}

function isPrimaryForProfile(doc, facts, profile) {
  const tags = doc.specialTags || [];

  if (profile === 'insaat_yuksek_kdv_genel') {
    if (tags.includes('indirilecek_kdv')) return true;
    if (tags.includes('hesaplanan_kdv')) return true;
    if (tags.includes('devreden_kdv')) return true;
    if (tags.includes('maliyet_gider')) return true;
    if (tags.includes('uygulama_tebligi')) return true;
    if (tags.includes('beyanname_kilavuzu')) return true;
    if (tags.includes('kanun')) return true;
    if (tags.includes('muhasebe')) return true;
  }

  return true;
}

async function retrieveAndSelectDocuments(question) {
  const facts = extractQuestionFacts(question);
  const profile = determineQuestionProfile(facts);
  const subqueries = buildDeterministicSubqueries(question, facts, profile);

  const merged = new Map();

  for (const subquery of subqueries) {
    const embedding = await getEmbedding(subquery);
    const docs = await searchDocuments(embedding, RETRIEVAL_TOP_K, RETRIEVAL_THRESHOLD);

    for (const doc of docs) {
      const source = getSourceName(doc);
      const enriched = {
        ...doc,
        source,
        sourcePriority: getSourcePriority(source),
        matchedBy: subquery,
        specialTags: inferSpecialTags(doc)
      };

      if (isHardExcluded(enriched, facts, profile)) continue;

      const key = String(doc.id);
      const existing = merged.get(key);

      if (!existing || scoreDocument(enriched) > scoreDocument(existing)) {
        merged.set(key, enriched);
      }
    }
  }

  const candidates = [...merged.values()].sort((a, b) => scoreDocument(b) - scoreDocument(a));

  const primary = [];
  const conditional = [];

  for (const doc of candidates) {
    if (primary.length >= MAX_SELECTED_DOCS) break;

    if (isPrimaryForProfile(doc, facts, profile)) {
      if (!primary.find(item => String(item.id) === String(doc.id))) {
        primary.push(doc);
      }
    }
  }

  for (const doc of candidates) {
    if (primary.length + conditional.length >= MAX_SELECTED_DOCS) break;
    if (primary.find(item => String(item.id) === String(doc.id))) continue;

    if (!conditional.find(item => String(item.id) === String(doc.id))) {
      conditional.push(doc);
    }
  }

  return {
    facts,
    profile,
    subqueries,
    primaryDocs: primary.slice(0, MAX_SELECTED_DOCS),
    conditionalDocs: conditional.slice(0, 3)
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
${truncateText(content, DOC_PREVIEW_CHARS)}`;

    const nextSize = totalChars + block.length + 10;
    if (nextSize > MAX_CONTEXT_CHARS) return;

    blocks.push(block);
    totalChars = nextSize;
  };

  for (const doc of primaryDocs) pushDoc(doc, 'ANA');
  for (const doc of conditionalDocs) pushDoc(doc, 'ŞARTA_BAĞLI');

  return blocks.join('\n\n---\n\n');
}

async function callAnthropicText({ system, userText, maxTokens = 3200 }) {
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

const ANSWER_SYSTEM_PROMPT = `Sen Legatis Tax adlı bir Türk vergi danışmanlık asistanısın. Kullanıcıya Google gibi sonuç sıralayan bir arama motoru gibi değil, mevzuata dayalı çalışan kıdemli bir vergi danışmanı gibi yanıt verirsin.

EN SIKI KURAL:
- Yalnızca BAĞLAM içindeki bilgilere dayan.
- BAĞLAMDA olmayan hiçbir hüküm, oran, şart, istisna, sonuç veya senaryo ekleme.
- "Grup: ANA" kaynaklar ana cevap içindir.
- "Grup: ŞARTA_BAĞLI" kaynaklar yalnızca kısa ve ikincil biçimde kullanılabilir.
- Soruda geçmeyen özel rejimleri ana çözüm gibi anlatma.

ÖZEL PROFİL KURALI:
- Eğer profil "insaat_yuksek_kdv_genel" ise, cevabı şu ana eksenlerle sınırla:
  1. indirilecek KDV'nin tam ve doğru kullanımı
  2. hesaplanan KDV / indirilecek KDV dengesinin işlem bazında kontrolü
  3. devreden KDV ve beyanname kontrolü
  4. gider / maliyet / muhasebe sınıflandırmasının etkisi
- Bu profilde kullanıcı açıkça söylemedikçe şu başlıkları ana çözümde kullanma:
  - teşvik belgesi
  - restorasyon
  - 150 m² altı konut
  - arsa karşılığı inşaat
  - promosyon
  - indirimli oranlı konut rejimi

YAZIM KURALI:
- Genel sektör anlatısı yapma.
- "Bu durum sektörün yapısı gereği yaygındır" gibi soyut cümleler kurma.
- 2-4 ana çözüm ekseniyle sınırlı kal.
- Cevap seçici, isabetli ve danışmanvari olsun.
- Soruda doğrulanmayan faaliyet detayını kesinmiş gibi yazma.
- "genellikle", "muhtemelen", "olabilir", "sanırım" gibi ifadeleri kullanma.

CEVAP BİÇİMİ:
1. Kısa değerlendirme
2. ## Sorudaki Durumun Vergisel Çerçevesi
3. ## Doğrudan Uygulanabilir Seçenekler
4. ## Şarta Bağlı Değerlendirilmesi Gereken Başlıklar
5. ## Yasal Dayanak
6. ## Pratik Yol Haritası
7. Gerekirse: Netleştirilmesi gereken hususlar

TEKNİK KURAL:
- Madde numarası BAĞLAMDA yoksa uydurma madde yazma.
- Beyanname Düzenleme Kılavuzu veya muhasebe kaynağından gelen teknik bilgiyi o kaynağa bağla.
- Aynı bilgiyi tekrar etme.`;

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
        const retrieval = await retrieveAndSelectDocuments(cleanQuestion);

        if (!retrieval.primaryDocs || retrieval.primaryDocs.length === 0) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            text: 'Bu konuda bilgi tabanımda yeterli mevzuat kaynağı bulunamadı. Güncel bilgi için vergi danışmanınıza başvurun.'
          }));
          return;
        }

        const context = buildAnswerContext(retrieval.primaryDocs, retrieval.conditionalDocs);

        if (!context.trim()) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            text: 'Bu konuda bilgi tabanımda yeterli mevzuat kaynağı bulunamadı. Güncel bilgi için vergi danışmanınıza başvurun.'
          }));
          return;
        }

        console.log('/api/chat profile:', retrieval.profile);
        console.log('/api/chat facts:', retrieval.facts);
        console.log('/api/chat subqueries:', retrieval.subqueries);
        console.log('/api/chat primary sources:', retrieval.primaryDocs.map(doc => ({
          id: doc.id,
          source: doc.source,
          similarity: Number((doc.similarity || 0).toFixed(4)),
          tags: doc.specialTags || []
        })));
        console.log('/api/chat conditional sources:', retrieval.conditionalDocs.map(doc => ({
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

SORU PROFİLİ:
${retrieval.profile}

GÖREV:
- Yalnızca ANA kaynaklarla ana çözümü kur.
- ŞARTA_BAĞLI kaynakları kısa tut.
- Eğer profil "insaat_yuksek_kdv_genel" ise, cevabı yalnızca genel yüksek KDV problemine doğrudan temas eden başlıklarla sınırla.
- Teşvik, restorasyon, 150 m², arsa karşılığı, promosyon gibi başlıkları kullanıcı açıkça söylemedikçe ana çözümde kullanma.
- Kısa değerlendirme bölümünde soyut sektör yorumu yapma.
- Kullanıcıya mevzuata dayalı, seçici ve uygulanabilir yol haritası ver.

BAĞLAM:
${context}`,
          maxTokens: 2800
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          text: answerText,
          debug: {
            profile: retrieval.profile,
            sourceCount: retrieval.primaryDocs.length + retrieval.conditionalDocs.length,
            subqueries: retrieval.subqueries,
            facts: retrieval.facts,
            primarySources: retrieval.primaryDocs.map(doc => doc.source),
            conditionalSources: retrieval.conditionalDocs.map(doc => doc.source)
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
