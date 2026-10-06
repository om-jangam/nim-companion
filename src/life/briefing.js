'use strict';
/*
 * The daily briefing - "Good morning, Sam. It is 9:12 on Saturday. You have two
 * reminders today... It is 28 degrees and partly cloudy" - and the weather on
 * its own.
 *
 * The weather comes from Open-Meteo (open-meteo.com): free, open, no account
 * and no key. What is sent is the name of your city, to find where it is, and
 * then that place. Nothing else. Without a city set, there is no weather and
 * nothing is sent.
 */

const GEO = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST = 'https://api.open-meteo.com/v1/forecast';

/* WMO weather codes, as words. */
const SKY = {
  0: 'clear', 1: 'mostly clear', 2: 'partly cloudy', 3: 'cloudy', 45: 'foggy', 48: 'foggy',
  51: 'drizzling', 53: 'drizzling', 55: 'drizzling', 56: 'freezing drizzle', 57: 'freezing drizzle',
  61: 'raining lightly', 63: 'raining', 65: 'raining heavily', 66: 'freezing rain', 67: 'freezing rain',
  71: 'snowing lightly', 73: 'snowing', 75: 'snowing heavily', 77: 'snowing',
  80: 'showery', 81: 'showery', 82: 'pouring', 85: 'snow showers', 86: 'snow showers',
  95: 'stormy', 96: 'stormy with hail', 99: 'stormy with hail'
};

async function getJson(url, fetchImpl) {
  const res = await (fetchImpl || fetch)(url, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Nim (a local desktop companion)' } });
  if (!res.ok) throw new Error('the weather service said ' + res.status);
  return res.json();
}

/* { place, now: degrees, sky, high, low, rain: % chance } for a city name. */
async function weather(city, opts) {
  opts = opts || {};
  const name = String(city || '').trim().slice(0, 80);
  if (!name) throw new Error('I do not know your city yet - tell me "my city is ..."');
  const geo = await getJson(GEO + '?' + new URLSearchParams({ name, count: '1', language: 'en', format: 'json' }), opts.fetch);
  const at = geo && geo.results && geo.results[0];
  if (!at) throw new Error('I could not find a place called ' + name);
  const q = new URLSearchParams({
    latitude: String(at.latitude), longitude: String(at.longitude), timezone: 'auto', forecast_days: '1',
    current: 'temperature_2m,weather_code', daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max'
  });
  const f = await getJson(FORECAST + '?' + q, opts.fetch);
  const cur = f.current || {}, day = f.daily || {};
  return {
    place: at.name + (at.country ? ', ' + at.country : ''),
    now: Math.round(cur.temperature_2m),
    sky: SKY[cur.weather_code] || 'changeable',
    high: day.temperature_2m_max ? Math.round(day.temperature_2m_max[0]) : null,
    low: day.temperature_2m_min ? Math.round(day.temperature_2m_min[0]) : null,
    rain: day.precipitation_probability_max ? day.precipitation_probability_max[0] : null
  };
}

function weatherWords(w) {
  if (!w) return '';
  let s = 'In ' + w.place.split(',')[0] + ' it is ' + w.now + ' degrees and ' + w.sky;
  if (w.high !== null && w.low !== null) s += ', ' + w.low + ' to ' + w.high + ' today';
  if (w.rain !== null && w.rain >= 40) s += ', with a ' + w.rain + ' percent chance of rain';
  return s + '.';
}

function greeting(hour) {
  return hour < 5 ? 'Up late' : hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
}

/* The briefing, in words. reminders: [{ text, at }] (ms). */
function compose({ name, date, reminders, weather: w }) {
  const d = date || new Date();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const day = d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
  const parts = [greeting(d.getHours()) + (name ? ', ' + name : '') + '. It is ' + time + ' on ' + day + '.'];
  const end = new Date(d); end.setHours(23, 59, 59, 999);
  const today = (reminders || []).filter((r) => r.at >= d.getTime() && r.at <= end.getTime());
  if (today.length === 1) parts.push('One reminder today: ' + today[0].text + ' at ' + new Date(today[0].at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '.');
  else if (today.length > 1) parts.push(today.length + ' reminders today, the first at ' + new Date(today[0].at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + ': ' + today[0].text + '.');
  else parts.push('No reminders today.');
  if (w) parts.push(weatherWords(w));
  return parts.join(' ');
}

module.exports = { weather, weatherWords, compose, greeting, SKY };
