const OEMBED_ENDPOINT = 'https://publish.twitter.com/oembed';

export async function parseTwitterUrl(url) {
  const params = new URLSearchParams({
    url: url,
    omit_script: true,
    hide_thread: true
  });

  const response = await fetch(`${OEMBED_ENDPOINT}?${params}`, {
    headers: {
      'User-Agent': 'Cloudflare Worker - idns-calendar'
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch oembed: ${response.status}`);
  }

  const data = await response.json();
  return extractContent(data.html);
}

function extractContent(html) {
  // 簡易的なHTML解析
  const textContent = html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    text: textContent,
    html: html
  };
}
