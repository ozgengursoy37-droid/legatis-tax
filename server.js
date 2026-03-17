const http = require('http');
const fs = require('fs');
const path = require('path');

const server = http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'text/html; charset=utf-8'});
  fs.createReadStream(path.join(__dirname, 'index.html')).pipe(res);
});

server.listen(process.env.PORT || 8080);
