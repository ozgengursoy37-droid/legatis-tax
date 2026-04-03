const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const ExcelJS = require('exceljs');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function parseExcelToText(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];

  const lines = ['HESAP KODU | HESAP ADI | DÖVİZ | BORÇ | ALACAK | BORÇ BAKİYESİ | ALACAK BAKİYESİ'];
  let headerPassed = false;

  ws.eachRow((row) => {
    const vals = row.values.slice(1);
    const first = vals[0];

    if (!headerPassed) {
      if (String(first).includes('HESAP KODU')) headerPassed = true;
      return;
    }

    if (!first) return;
    const firstStr = String(first).trim();
    if (!firstStr) return;

    // Sadece ana hesap + grup + hesap seviyesi (nokta sayısı max 1)
    // Örn: 1, 10, 100, 102, 102.01 dahil — 102.01.001 hariç
    const dotCount = (firstStr.match(/\./g) || []).length;
    if (dotCount > 1) return;

    const fmt = (v) =>
      v !== null && v !== undefined && v !== '' && !isNaN(Number(v))
        ? Number(v).toFixed(2)
        : '';

    lines.push([
      firstStr,
      vals[1] ? String(vals[1]).trim() : '',
      vals[2] ? String(vals[2]).trim() : '',
      fmt(vals[3]),
      fmt(vals[4]),
      fmt(vals[5]),
      fmt(vals[6]),
    ].join(' | '));
  });

  return lines.join('\n');
}

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
    if (err) { res.writeHead(500); res.end(filename + ' okunamadi'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

async function getEmbedding(text) {
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({ model: 'text-embedding-ada-002', input: text })
  });
  const data = await response.json();
  return data.data[0].embedding;
}

async function searchDocuments(embedding, matchCount = 8) {
  const { data, error } = await supabase.rpc('match_documents', {
    query_embedding: embedding,
    match_threshold: 0.75,
    match_count: matchCount
  });
  if (error) throw new Error('Supabase arama hatasi: ' + error.message);
  return data || [];
}


const SYSTEM_PROMPT = `KAPSAMLI ANALİZ ZORUNLULUĞU:
Verilen soruyu yanıtlarken ilgili olabilecek TÜM vergi boyutlarını ele al. Bir taşıt işleminde KDV + ÖTV + gelir vergisi + amortisman boyutlarını; bir işletme giderinde KDV + kurumlar vergisi + stopaj boyutlarını; bir gayrimenkul işleminde KDV + tapu harcı + değer artış kazancı boyutlarını mutlaka kontrol et ve ilgili olanları cevaba dahil et. Hiçbir zaman "atladım" veya "bahsetmedim" durumuna düşme — soruyla ilgili tüm vergi boyutlarını tek cevabında tamamla.

Sen Legatis Tax adlı bir Türk vergi danışmanlık asistanısın. Arkandaki ekip vergi mevzuatı ve özel sektör danışmanlığında derin uzmanlığa sahiptir.

TEMEL BAKIŞ AÇIN:
Gelir İdaresi Başkanlığı vergi mevzuatını hazine lehine yorumlar. Sen aynı mevzuatı mükellef lehine yorumlarsın. Her ikisi de yasaldır — sen mükellefi kendi lehine olan yasal seçeneklerden haberdar edersin.

YANIT DETAYI — KESİNLİKLE UYGULA:
Her yanıt kapsamlı ve detaylı olmalıdır. Kullanıcı sorusunu tam olarak anlayıp tüm boyutlarıyla yanıtla. Kısa veya yüzeysel yanıt verme. Her seçenek için:
- Yasal dayanağını belirt
- Pratik uygulama adımlarını açıkla
- Avantaj ve dezavantajlarını say
- Varsa rakamsal örnek ver
- Mükellef lehine yorumu açıkla

CEVAP FORMATI — MUTLAKA UYGULA:
- Başlıklar için ## kullan
- Alt başlıklar için ### kullan
- Madde listeleri için - kullan
- Önemli kavramları **kalın** yaz
- Bölümleri birbirinden ayırmak için --- kullan
- Kanun maddelerini her zaman **Kanun Adı Madde X** formatında yaz

CEVAP YAPISI — HER CEVAP BU SIRALAMAYI TAKİP ETSİN:
1. Kısa özet (2-3 cümle, sorunun özü)
2. ## Yasal Alternatifler (mükellef lehine tüm seçenekler, rakamsal etkisiyle)
3. ## Dikkat Edilmesi Gereken Riskler
4. ## Yasal Dayanak (kanun adı ve madde numarası)
5. ## Önerilen Adımlar (pratik, uygulanabilir adımlar)
6. ⚠️ Bu bilgiler genel bilgilendirme amaçlıdır. Şirketinizin özel koşulları farklı sonuçlar doğurabilir. Daha detaylı ve kişiselleştirilmiş analiz için **Legatis Tax uzmanlarıyla görüşmenizi** öneririz.
7. Soru önerileri bloğu (aşağıya bak)

SORU ÖNERİLERİ — KESİNLİKLE UYGULA:
Yanıtın en sonuna, ⚠️ uyarısından SONRA, aşağıdaki formatta tam olarak 3 soru önerisi ekle:

###SORULAR###
{"sorular":["Soru 1 metni","Soru 2 metni","Soru 3 metni"]}
###SORULAR_BITIS###

Soru önerileri kuralları:
- Kullanıcının sorusunu farklı açılardan derinleştirecek sorular olsun
- Her biri bağımsız, tam bir soru olsun
- Kısa ve net olsun (max 15 kelime)
- Türkçe olsun
- Kullanıcının durumuna özel olsun

HALÜSİNASYON KURALI — KESİNLİKLE UYULMASI ZORUNLU:
- Yalnızca aşağıda sağlanan BAĞLAM bölümündeki bilgilere dayanarak yanıt ver.
- Bağlamda bilgi yoksa şunu söyle: "Bu konuda bilgi tabanımda yeterli mevzuat kaynağı bulunamadı. Güncel bilgi için vergi danışmanınıza başvurun." Başka hiçbir şey ekleme.
- Kanun maddesi numarası veremiyorsan o konuda yanıt verme.
- Tahmin, varsayım veya genel bilginden yanıt üretme. Hiçbir koşulda.
- Rakam, oran veya tutar verirken mutlaka hangi kanunun hangi maddesinden geldiğini belirt. Madde gösteremiyorsan o rakamı yazma.
- "Genellikle", "muhtemelen", "olabilir", "sanırım" gibi ifadeler kullanma.

MADDE NUMARASI KURALI — EN KRİTİK KURAL:
Kanun maddesi numarasını yalnızca bağlamda AÇIKÇA ve tam olarak yazıyorsa yaz.
Bağlamda madde numarası kesilmiş, eksik, belirsiz veya dolaylı atıfla geçiyorsa → o maddeyi hiçbir şekilde yazma.
Bağlamdan çıkarım yaparak madde numarası üretme. "Bu içerik muhtemelen şu maddedir" mantığıyla hareket etme.
Madde numarası yazamıyorsan: "İlgili kanun hükmü — madde numarasını danışmanınızla teyit edin" yaz.
Bağlamda içerik var ama madde numarası yoksa, içeriği kullan ama madde numarası uydurma.

ÖNCE TEŞHİS, SONRA TEDAVİ:
Her soruda önce durumun mahiyetini teşhis et, sonra çözüm öner. Kullanıcıya tek yanıtta hem teşhis senaryolarını hem çözümleri ver. Teşhis yapmadan çözüm önerme.

Teşhis formatı — her yanıtta bu mantığı uygula:
- Durum A: [X ise] → [şu riski taşır, şu çözüm uygulanır]
- Durum B: [Y ise] → [şu riski taşır, şu çözüm uygulanır]
- Durum C: [Z ise] → [şu riski taşır, şu çözüm uygulanır]

Örnek: 331 hesabı sorusunda önce "borç gerçek mi, fiktif mi, karışık mı?" teşhisini yap, her senaryoya ayrı çözüm ver.

İLİŞKİLİ KİŞİ İŞLEMLERİNDE EMSAL FAİZ ZORUNLULUĞU:
Ortak, ortak iştiraki veya ilişkili kişilerle yapılan borç/alacak işlemlerinde faizsiz bırakma riski her zaman belirt — kullanıcı sormasa bile:
- Faizsiz bırakma = emsale aykırı işlem = örtülü kazanç riski
- Transfer fiyatlandırması kapsamında değerlendirilebilir
- Emsal faiz oranı: TCMB kısa vadeli kredi faiz oranları baz alınır
- Faiz tahakkuku yapılacaksa: hangi dönem, hangi bakiye, hangi oran, hangi sözleşmeye dayanarak — hepsi net olmalı

FİKTİF BORÇ UYARISI:
Belge dayanağı olmayan borçlar için "sözleşme yaparak kurtarılır" yaklaşımını asla önerme. İnceleme "paranın kaynağı nerede?" diye sorar — geriye dönük sözleşme bu soruyu kapatmaz. Fiktif borcu gerçek borç gibi tedavi etmek incelemede daha büyük risk yaratır.

2026 YILI GÜNCEL VERGİ LİMİTLERİ (RESMİ GAZETE 31.12.2025):
Bu limitler kesin ve doğrudur. Kullanıcı sorduğunda doğrudan bu rakamları kullan, "bulunamadı" deme.

VUK (Vergi Usul Kanunu) 2026 Hadleri:
- Madde 232 Fatura kullanma mecburiyeti: 12.000 TL
- Madde 177 Bilanço esasına göre defter tutma — yıllık alış: 2.500.000 TL, yıllık satış: 3.500.000 TL, gayrisafi iş hasılatı: 1.200.000 TL
- Madde 313 Doğrudan gider yazılacak demirbaş: 12.000 TL
- Madde 323 Şüpheli alacak: 25.000 TL
- Madde 343 En az ceza haddi — damga vergisi: 150 TL, diğer vergiler: 300 TL
- Madde 352 I. derece usulsüzlük — sermaye şirketi: 35.000 TL, 1. sınıf tüccar/serbest meslek: 17.000 TL, 2. sınıf tüccar: 8.700 TL
- Madde 353 Fatura vermeme cezası — 1. tespit: 17.000 TL, yıllık üst sınır: 17.000.000 TL
- Madde 370 İzaha davet — yanıltıcı belge tutarı: 870.000 TL
- Ek Madde 1 Uzlaşma limiti: 40.000 TL üzeri

GVK (Gelir Vergisi Kanunu) 2026 Hadleri:
- Madde 103 Gelir vergisi tarifeleri (2026 gelirleri için):
  * 190.000 TL'ye kadar: %15
  * 400.000 TL'nin 190.000 TL'si için 28.500 TL + fazlası: %20
  * 1.000.000 TL'nin 400.000 TL'si için 70.500 TL + fazlası (ücret): %27
  * 1.500.000 TL'nin 400.000 TL'si için 70.500 TL + fazlası (diğer): %27
  * 5.300.000 TL'nin 1.000.000 TL'si için 232.500 TL + fazlası (ücret): %35
  * 5.300.000 TL'nin 1.500.000 TL'si için 367.500 TL + fazlası (diğer): %35
  * 5.300.000 TL üzeri: %40
- Mükerrer Madde 121 Beyanname verme sınırı: 12.000.000 TL

KDV 2026 Hadleri:
- KDV iade alt sınırı (56 Seri No'lu Tebliğ): 164.000 TL

YAPAMAYACAKLARIN:
- Vergi kaçakçılığına yönlendirecek hiçbir tavsiye verme.
- Bilgi tabanında olmayan konularda yorum yapma.
- Kanuni dayanağı olmayan hiçbir bilgi verme.
- Varsayıma dayalı hiçbir yorumda bulunma.`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && url.pathname === '/') { serveHtmlFile(res, 'landing.html'); return; }
  if (req.method === 'GET' && url.pathname === '/app') { serveHtmlFile(res, 'index.html'); return; }
  if (req.method === 'GET' && url.pathname === '/kvkk') { serveHtmlFile(res, 'kvkk.html'); return; }
  if (req.method === 'GET' && url.pathname === '/gizlilik') { serveHtmlFile(res, 'gizlilik.html'); return; }
  if (req.method === 'GET' && url.pathname === '/kullanim-kosullari') { serveHtmlFile(res, 'kullanim-kosullari.html'); return; }
  if (req.method === 'GET' && url.pathname === '/cerez-politikasi') { serveHtmlFile(res, 'cerez-politikasi.html'); return; }

  if (req.method === 'POST' && url.pathname === '/api/chat') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { question, sessionId } = JSON.parse(body);
        if (!question || !question.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Soru boş olamaz' }));
          return;
        }

        const embedding = await getEmbedding(question);
        const documents = await searchDocuments(embedding, 8);

        if (!documents || documents.length === 0) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            text: 'Bu konuda bilgi tabanımda yeterli mevzuat kaynağı bulunamadı. Güncel bilgi için vergi danışmanınıza başvurun.',
            suggestions: []
          }));
          return;
        }

        const context = documents.map(doc =>
          `[Kaynak: ${doc.metadata?.source || 'Bilinmiyor'}]\n${doc.content}`
        ).join('\n\n---\n\n');

        const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-5',
            max_tokens: 6000,
            system: SYSTEM_PROMPT,
            messages: [{
              role: 'user',
              content: `BAĞLAM:\n${context}\n\nSORU: ${question}`
            }]
          })
        });

        const anthropicData = await anthropicResponse.json();
        const fullText = anthropicData.content?.[0]?.text || 'Yanıt alınamadı.';

        let answerText = fullText;
        let suggestions = [];

        try {
          const soruMatch = fullText.match(/###SORULAR###\s*([\s\S]*?)\s*###SORULAR_BITIS###/);
          if (soruMatch) {
            const jsonStr = soruMatch[1].trim();
            const parsed = JSON.parse(jsonStr);
            suggestions = parsed.sorular || [];
            answerText = fullText.replace(/###SORULAR###[\s\S]*?###SORULAR_BITIS###/, '').trim();
          }
        } catch (e) {
          // suggestions boş kalır
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: answerText, suggestions }));

      } catch (err) {
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
        let { data: profile } = await supabase.from('profiles').select('*').eq('id', user_id).single();
        if (!profile) {
          const { data: newProfile } = await supabase.from('profiles').insert({ id: user_id }).select().single();
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
        await supabase.from('profiles').update({ daily_question_count: count + 1, last_question_date: today }).eq('id', user_id);
        await supabase.from('user_questions').insert({ user_id, category: category || 'Tum Sorular', question_text });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, remaining: profile.is_premium ? 999 : (9 - count) }));
      } catch (err) {
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
        let fileData = null, fileMimeType = null, fileName = null;
        let question = 'Bu belgeyi vergi mevzuati acisindan analiz et.';
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
          res.end(JSON.stringify({ error: 'Dosya bulunamadi' }));
          return;
        }

        let messageContent = [];

        if (fileMimeType === 'application/pdf') {
          const base64Data = fileData.toString('base64');
          messageContent = [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Data } },
            { type: 'text', text: question }
          ];
        } else if (fileMimeType.startsWith('image/')) {
          const base64Data = fileData.toString('base64');
          const validImageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
          const mediaType = validImageTypes.includes(fileMimeType) ? fileMimeType : 'image/jpeg';
          messageContent = [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } },
            { type: 'text', text: question }
          ];
        } else if (
          fileMimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
          fileMimeType === 'application/vnd.ms-excel' ||
          fileName.endsWith('.xlsx') ||
          fileName.endsWith('.xls')
        ) {
          // Excel dosyasını parse et, düz metin olarak gönder
          const excelText = await parseExcelToText(fileData);
          messageContent = [
            {
              type: 'text',
              text: `Aşağıdaki mizan/Excel verisini vergi mevzuatı açısından analiz et.\n\nDosya adı: ${fileName}\n\nMİZAN VERİSİ:\n${excelText}\n\nKULLANICI SORUSU: ${question}`
            }
          ];
        } else {
          messageContent = [
            { type: 'text', text: `Kullanici bir belge yukledi (${fileName}). ${question}` }
          ];
        }

        const anthropicResponse = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-5',
            max_tokens: 6000,
            system: 'Sen Legatis Tax adli bir Turk vergi danismanlik asistanisin. Yuklenen belgeleri vergi mevzuati acisindan analiz ederek mukellef lehine yasal avantajlari, riskleri ve pratik onerileri belirtirsin. Kapsamli ve detayli yanit ver.',
            messages: [{ role: 'user', content: messageContent }]
          })
        });

        const anthropicData = await anthropicResponse.json();
        const analysisText = anthropicData.content?.[0]?.text || 'Analiz yapilamadi.';

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
