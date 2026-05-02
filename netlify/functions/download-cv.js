const https = require('https');
const { URL } = require('url');

exports.handler = async (event) => {
  const { url, filename } = event.queryStringParameters || {};

  if (!url) {
    return { statusCode: 400, body: 'Missing url parameter' };
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { statusCode: 400, body: 'Invalid URL' };
  }

  if (!parsed.hostname.endsWith('cloudinary.com')) {
    return { statusCode: 403, body: 'Only Cloudinary URLs are allowed' };
  }

  return new Promise((resolve) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const contentType = res.headers['content-type'] || 'application/octet-stream';
        const safeFilename = (filename || 'CV').replace(/[^a-zA-Z0-9._-]/g, '_');
        resolve({
          statusCode: 200,
          headers: {
            'Content-Type': contentType,
            'Content-Disposition': `attachment; filename="${safeFilename}"`,
            'Cache-Control': 'no-cache',
          },
          body: buffer.toString('base64'),
          isBase64Encoded: true,
        });
      });
      res.on('error', () => resolve({ statusCode: 502, body: 'Fetch failed' }));
    }).on('error', () => resolve({ statusCode: 502, body: 'Request failed' }));
  });
};
