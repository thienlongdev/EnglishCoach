// Loopback test adapter: exercise the Host header that production Nginx supplies without editing DNS.
import http from 'node:http';
const upstream = new URL(process.env.DISCOVER_BASE || 'http://127.0.0.1:18492');
const port = Number(process.env.DISCOVER_TEST_PORT || 18494);
if (upstream.protocol !== 'http:' || upstream.hostname !== '127.0.0.1' || !upstream.port || port === Number(upstream.port)) {
  throw Error('A distinct loopback HTTP port is required.');
}
http.createServer((request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
  const headers = { ...request.headers, host: 'englishcoach.io.vn' };
  const next = http.request({ hostname: '127.0.0.1', port: upstream.port, path: request.url, method: request.method, headers }, result => {
    response.writeHead(result.statusCode, result.headers);
    result.pipe(response);
  });
  next.on('error', () => { response.writeHead(502); response.end(); });
  response.on('close', () => next.destroy());
  request.pipe(next);
}).listen(port, '127.0.0.1', () => console.log('Local canonical-host adapter on port ' + port));
