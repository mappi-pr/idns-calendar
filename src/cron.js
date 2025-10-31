export default {
  async scheduled(event, env, ctx) {
    // 半月バッチ: 保存データを走査して頻度集計
    try {
      const nameCounts = {};
      const tagCounts = {};
      // D1 がある場合
      if (env.DB && typeof env.DB.prepare === "function") {
        const rows = await env.DB.prepare("SELECT payload FROM shifts").all();
        const results = rows.results || rows;
        for (const r of results) {
          const p = typeof r.payload === "string" ? JSON.parse(r.payload) : r.payload;
          (p.names || []).forEach(n => nameCounts[n] = (nameCounts[n]||0) + 1);
          (p.hashtags || []).forEach(t => tagCounts[t] = (tagCounts[t]||0) + 1);
        }
      } else if (env.SHIFTS_KV && env.SHIFTS_KV.list) {
        const list = await env.SHIFTS_KV.list({ limit: 1000 });
        for (const k of list.keys) {
          const v = await env.SHIFTS_KV.get(k.name);
          if (!v) continue;
          const item = JSON.parse(v);
          const p = item.parsed || {};
          (p.names || []).forEach(n => nameCounts[n] = (nameCounts[n]||0) + 1);
          (p.hashtags || []).forEach(t => tagCounts[t] = (tagCounts[t]||0) + 1);
        }
      } else {
        // 何もない
      }

      const learned = { updated_at: new Date().toISOString(), names: nameCounts, hashtags: tagCounts };
      if (env.LEARNED_KV && env.LEARNED_KV.put) {
        await env.LEARNED_KV.put("learned_summary", JSON.stringify(learned));
      }
      // ログ
      console.log("cron: learned summary saved", learned);
    } catch (e) {
      console.error("cron error", e);
    }
  }
};
