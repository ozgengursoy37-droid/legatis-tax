const http = require('http');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/question') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const { user_id, category, question_text } = JSON.parse(body);

        // Profil getir, yoksa oluştur
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

        await supabase.from('profiles').update({
          daily_question_count: count + 1,
          last_question_date: today
        }).eq('id', user_id);

        await supabase.from('user_questions').insert({
          user_id,
          category: category || 'Tüm Sorular',
          question_text
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          remaining: profile.is_premium ? 999 : (9 - count)
        }));

      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Sunucu hatası' }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(process.env.PORT || 8080);
