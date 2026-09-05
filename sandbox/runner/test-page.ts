import { createServer, type Server } from "node:http";

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ExtensionLab Test Page</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #ffffff; color: #1d1d1f; margin: 0; padding: 48px 24px; line-height: 1.5; }
    main { max-width: 720px; margin: 0 auto; }
    .badge { display:inline-block; border-radius:999px; background:#0071e3; color:#fff; padding:4px 12px; font-size:12px; font-weight:600; }
    .panel { border:1px solid #d2d2d7; border-radius:18px; padding:24px; margin-top:24px; }
    button, input, textarea { font: inherit; border:1px solid #d2d2d7; border-radius:12px; padding:10px 14px; background:#f5f5f7; }
    button { background:#1d1d1f; color:#fff; cursor:pointer; }
    #status { font-weight:600; margin-top:16px; }
  </style>
</head>
<body>
  <main>
    <span class="badge">ExtensionLab Runtime</span>
    <h1>ExtensionLab Test Page</h1>
    <p>Extension Runtime Environment</p>
    <p>Content scripts can be tested against this controlled origin.</p>
    <div class="panel">
      <form id="test-form">
        <label for="name">Name</label><br />
        <input id="name" name="name" type="text" placeholder="Type a value" /><br /><br />
        <textarea id="notes" rows="3" placeholder="Notes"></textarea><br /><br />
        <button type="submit">Submit</button>
        <button type="button" id="trigger">Trigger DOM event</button>
      </form>
      <div id="status">Extension is running.</div>
    </div>
    <p><a href="https://example.com">Example link</a></p>
  </main>
  <script>
    document.getElementById('trigger').addEventListener('click', function () {
      var el = document.createElement('div');
      el.id = 'dynamic-element';
      el.textContent = 'Dynamic element created.';
      document.getElementById('status').appendChild(el);
      console.log('Dynamic DOM element created.');
    });
    document.getElementById('test-form').addEventListener('submit', function (event) {
      event.preventDefault();
      console.log('Form submitted.');
    });
  </script>
</body>
</html>`;

export function startTestPageServer(): Server {
  const server = createServer((request, response) => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
    });
    response.end(html);
  });
  server.listen(8080, "127.0.0.1");
  return server;
}
