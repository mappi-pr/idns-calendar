import { JSDOM } from 'jsdom';

const OEMBED_ENDPOINT = 'https://publish.twitter.com/oembed';
const TIMELINE_ENDPOINT = 'https://syndication.twitter.com/timeline/profile';

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

export async function parseTwitterTimeline(username) {
  const params = new URLSearchParams({
    screen_name: username,
    limit: 20
  });

  const response = await fetch(`${TIMELINE_ENDPOINT}?${params}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; IdnsCalendar/1.0)'
    }
  });

  if (!response.ok) {
    throw new Error(`Timeline fetch failed: ${response.status}`);
  }

  const html = await response.text();
  return extractShiftInfo(html);
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

function extractShiftInfo(html) {
  const dom = new JSDOM(html);
  const document = dom.window.document;
  const tweets = document.querySelectorAll('.timeline-Tweet');
  
  const shifts = [];
  
  for (const tweet of tweets) {
    const text = tweet.querySelector('.timeline-Tweet-text')?.textContent || '';
    const timestamp = tweet.querySelector('.timeline-Tweet-timestamp')?.getAttribute('datetime');
    
    if (text.includes('シフト') || text.includes('出勤')) {
      shifts.push({
        text: text.trim(),
        date: timestamp ? new Date(timestamp) : null,
        id: tweet.getAttribute('data-tweet-id')
      });
    }
  }

  return shifts;
}
