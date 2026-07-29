(async () => {
  const query = 'weather in west palm beach florida';
  try {
    const res = await fetch('https://lite.duckduckgo.com/lite/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      body: `q=${encodeURIComponent(query)}`
    });
    const text = await res.text();
    // Regex extract from lite DDG
    const snippetRegex = /<td class='result-snippet'>([\s\S]*?)<\/td>/g;
    let match;
    let results = [];
    while ((match = snippetRegex.exec(text)) !== null) {
      results.push(match[1].replace(/<[^>]+>/g, '').trim());
    }
    console.log("DDG Lite Results:");
    console.log(results.slice(0, 3));
  } catch (err) {
    console.error(err);
  }
})();
