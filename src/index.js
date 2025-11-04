import { validateAIResponse, formatErrors } from "./validator.js";
import * as oauthX from "./oauth_x.js";
import { parseTwitterUrl } from './tweet_parser';

// 追加: テンプレート読み込みとキャッシュ（templates フォルダから相対読み込み）
const TEMPLATE_CACHE = {};
async function loadTemplate(name) {
	// name 例: 'index.html', 'calendar.html'
	if (TEMPLATE_CACHE[name]) return TEMPLATE_CACHE[name];
	// bundler がある環境で import.meta.url と相対パスからロードする想定
	const tplUrl = new URL(`./templates/${name}`, import.meta.url);
	const res = await fetch(tplUrl);
	if (!res.ok) throw new Error(`template load failed: ${name} (${res.status})`);
	const txt = await res.text();
	TEMPLATE_CACHE[name] = txt;
	return txt;
}

export default {
	async fetch(request, env) {
		try {
			const url = new URL(request.url);

			// ルート: テンプレートを読み込んで返すように変更
			if (request.method === "GET" && (url.pathname === "/" || url.pathname === "")) {
				const html = await loadTemplate("index.html");
				return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
			}

			if (url.pathname === "/api/parse" && request.method === "POST") {
				const body = await request.json().catch(()=>null);
				if (!body) return jsonResponse({ ok: false, error: "body required" }, 400);

				const targetUrl = body.url;
				if (!targetUrl) return jsonResponse({ ok: false, error: "url required" }, 400);

				// If prefetch provided by client (from /auth/x/fetch_tweet), use it instead of fetching the page.
				let oembedHtml = null;
				let pageText = "";
				let images = [];
				if (body.prefetch) {
					oembedHtml = body.prefetch.oembedHtml || null;
					pageText = body.prefetch.text || "";
					images = body.prefetch.images || [];
				} else {
					// Try to get oEmbed HTML for X (publish.twitter.com). Fallback to fetching page.
					try {
						const oe = await fetch(`https://publish.twitter.com/oembed?url=${encodeURIComponent(targetUrl)}`);
						if (oe.ok) {
							const j = await oe.json();
							oembedHtml = j.html || null;
						}
					} catch (e) { /* ignore */ }

					try {
						const res = await fetch(targetUrl, { redirect: "follow" });
						const bodyText = await res.text();
						pageText = extractText(bodyText);
						images = extractImages(bodyText);
					} catch (e) { /* ignore */ }
				}

				const payload = { text: pageText, images, source: targetUrl };

				// If AI endpoint configured, call it; otherwise use fallback parser
				let parsed;
				if (env.AI_ENDPOINT && env.AI_KEY) {
					try {
						const aiRes = await fetch(env.AI_ENDPOINT, {
							method: "POST",
							headers: {
								"Content-Type": "application/json",
								"Authorization": `Bearer ${env.AI_KEY}`
							},
							body: JSON.stringify(payload),
						});
						parsed = await aiRes.json();
					} catch (e) {
						parsed = fallbackParse(pageText);
					}
				} else {
					parsed = fallbackParse(pageText);
				}

				const validation = (typeof validateAIResponse === "function") ? validateAIResponse(parsed) : { valid: true };
				const validationSummary = { valid: validation.valid, errors: validation.errors ? formatErrors(validation.errors) : null };

				return jsonResponse({ ok: true, parsed, parsed_validated: validationSummary, oembed: oembedHtml, raw_text: pageText });
			}

			{
				// カレンダーページもテンプレートから返す
				if (request.method === "GET" && url.pathname === "/calendar") {
					const html = await loadTemplate("calendar.html");
					return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
				}

				// 変更: /api/list のイベント生成で extendedProps に parsed と shiftIndex を含める
				if (request.method === "GET" && url.pathname === "/api/list") {
					// try D1 first
					try {
						if (env.DB && typeof env.DB.prepare === "function") {
							const rows = await env.DB.prepare("SELECT id, payload FROM shifts ORDER BY created_at DESC").all();
							const events = (rows.results || rows).map(r => {
								const p = typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload;
								const evts = (p.shifts || []).map((s, idx) => {
									return {
										id: `${r.id}_${idx}_${s.date||s.raw||Math.random().toString(36).slice(2)}`,
										title: (p.names && p.names[0]) ? `${p.names[0]} @ ${p.store||''}`.trim() : (p.names && p.names[0]) || (p.store || "出勤"),
										start: (s.date ? normalizeDate(s.date) : undefined),
										extendedProps: { raw: s.raw || s.note || null, sourceId: r.id, parsed: p, shift: s, shiftIndex: idx }
									};
								});
								return evts;
							}).flat();
							return jsonResponse(events);
						}
					} catch (e) {
						// fallthrough to KV
					}

					// KV fallback
					if (env.SHIFTS_KV && env.SHIFTS_KV.list) {
						try {
							const list = await env.SHIFTS_KV.list({ limit: 1000 });
							const keys = list.keys.map(k => k.name);
							const events = [];
							for (const k of keys) {
								const v = await env.SHIFTS_KV.get(k);
								if (!v) continue;
								const item = JSON.parse(v);
								const p = item.parsed || {};
								(p.shifts || []).forEach((s, idx) => {
									events.push({
										id: `${item.id}_${idx}_${s.date||s.raw||Math.random().toString(36).slice(2)}`,
										title: (p.names && p.names[0]) ? `${p.names[0]} @ ${p.store||''}`.trim() : (p.names && p.names[0]) || (p.store || "出勤"),
										start: s.date ? normalizeDate(s.date) : undefined,
										extendedProps: { raw: s.raw || s.note || null, sourceId: item.id, parsed: p, shift: s, shiftIndex: idx }
									});
								});
							}
							return jsonResponse(events);
						} catch (e) {
							return jsonResponse([], 200);
						}
					}

					return jsonResponse([], 200);
				}

				// ユーティリティ: 日付文字列を ISO 形式に簡易変換（改善の余地あり）
				function normalizeDate(dstr) {
					// 簡易: yyyy/mm/dd または mm/dd → yyyy-??-??
					if (!dstr) return null;
					// 既に ISO 形式っぽければそのまま
					if (/^\d{4}-\d{2}-\d{2}/.test(dstr)) return dstr;
					const m = dstr.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
					if (m) return `${m[1].padStart(4,'0')}-${m[2].padStart(2,'0')}-${m[3].padStart(2,'0')}`;
					const m2 = dstr.match(/(\d{1,2})[\/\-](\d{1,2})/);
					if (m2) {
						// 当年を付ける（暫定）
						const y = new Date().getFullYear();
						return `${y}-${m2[1].padStart(2,'0')}-${m2[2].padStart(2,'0')}`;
					}
					return null;
				}
			}

			{
				// 追加: 更新 API
				if (url.pathname === "/api/update" && request.method === "POST") {
					const body = await request.json().catch(()=>null);
					if (!body || !body.id || !body.parsed) return jsonResponse({ ok:false, error: "id and parsed required" }, 400);

					const id = body.id;
					const parsed = body.parsed;
					const source = body.source || null;
					const updated_at = new Date().toISOString();

					// バリデーション
					const validation = validateAIResponse(parsed);
					if (!validation.valid) {
						return jsonResponse({ ok:false, error: "parsed does not match schema", validation: { valid: false, errors: validation.errors } }, 400);
					}

					// Try D1 first
					if (env.DB && typeof env.DB.prepare === "function") {
						try {
							// UPDATE payload and source if present
							await env.DB.prepare("UPDATE shifts SET payload = ?, source = ?, created_at = ? WHERE id = ?")
								.bind(JSON.stringify(parsed), source, updated_at, id)
								.run();
							return jsonResponse({ ok:true, updated: { engine: "D1", id } });
						} catch (e) {
							// fall through to KV attempt
						}
					}

					// KV fallback: replace the item
					if (env.SHIFTS_KV && env.SHIFTS_KV.get && env.SHIFTS_KV.put) {
						try {
							const existing = await env.SHIFTS_KV.get(id);
							if (!existing) return jsonResponse({ ok:false, error: "not found" }, 404);
							const item = JSON.parse(existing);
							item.parsed = parsed;
							if (source) item.source = source;
							item.updated_at = updated_at;
							await env.SHIFTS_KV.put(id, JSON.stringify(item));
							return jsonResponse({ ok:true, updated: { engine: "KV", id } });
						} catch (e) {
							return jsonResponse({ ok:false, error: "update failed", detail: String(e) }, 500);
						}
					}

					return jsonResponse({ ok:false, error: "no storage configured" }, 500);
				}

				// 追加: 削除 API
				if (url.pathname === "/api/delete" && request.method === "POST") {
					const body = await request.json().catch(()=>null);
					if (!body || !body.id) return jsonResponse({ ok:false, error: "id required" }, 400);

					const id = body.id;

					// Try D1 first
					if (env.DB && typeof env.DB.prepare === "function") {
						try {
							await env.DB.prepare("DELETE FROM shifts WHERE id = ?").bind(id).run();
							return jsonResponse({ ok:true, deleted: { engine: "D1", id } });
						} catch (e) {
							// fall through to KV
						}
					}

					// KV fallback
					if (env.SHIFTS_KV && env.SHIFTS_KV.delete) {
						try {
							await env.SHIFTS_KV.delete(id);
							return jsonResponse({ ok:true, deleted: { engine: "KV", id } });
						} catch (e) {
							return jsonResponse({ ok:false, error: "delete failed", detail: String(e) }, 500);
						}
					}

					return jsonResponse({ ok:false, error: "no storage configured" }, 500);
				}
			}

			return new Response("Not Found", { status: 404 });
		} catch (err) {
			return jsonResponse({ ok: false, error: String(err) }, 500);
		}
	}
};
