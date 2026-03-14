export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    if (request.method !== 'POST') {
      return new Response('Send a POST request with your EPUB as the body.', { status: 200 });
    }

    try {
      const { default: JSZip } = await import('https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm');

      const inputBuffer = await request.arrayBuffer();
      const zip = await JSZip.loadAsync(inputBuffer);
      const textExts = /\.(html|htm|xhtml|xml|opf|ncx|css|txt)$/i;

      const promises = Object.keys(zip.files).map(async (name) => {
        const file = zip.files[name];
        if (file.dir || !textExts.test(name)) return;
        const content = await file.async('string');
        const cleaned = content
          .replace(/&lt;&lt;/g, '\u00ab')
          .replace(/&gt;&gt;/g, '\u00bb')
          .replace(/<</g, '\u00ab')
          .replace(/>>/g, '\u00bb');
        zip.file(name, cleaned);
      });

      await Promise.all(promises);

      const outputBuffer = await zip.generateAsync({
        type: 'uint8array',
        mimeType: 'application/epub+zip',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 }
      });

      return new Response(outputBuffer, {
        headers: {
          'Content-Type': 'application/epub+zip',
          'Access-Control-Allow-Origin': '*',
        }
      });

    } catch (err) {
      return new Response('Error: ' + err.message, { status: 500 });
    }
  }
};
