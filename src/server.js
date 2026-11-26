// Jembatan WAHA (WhatsApp) <-> Claude API untuk admin Habits Media.
// Tanpa dependency: cukup Node.js 20+.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ---------- Konfigurasi (.env) ----------
loadDotEnv(path.join(ROOT, '.env'));
const cfg = {
  port: Number(process.env.PORT || 8080),
  webhookToken: process.env.WEBHOOK_TOKEN || '',
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicBase: (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, ''),
  model: process.env.CLAUDE_MODEL || 'claude-sonnet-5-5',
  wahaUrl: (process.env.WAHA_URL || 'http://waha:3000').replace(/\/$/, ''),
  wahaKey: process.env.WAHA_API_KEY || '',
  session: process.env.WAHA_SESSION || 'default',
  mode: (process.env.BOT_MODE || 'draft').toLowerCase(), // draft | auto | off
  adminChatId: normalizeChatId(process.env.ADMIN_NUMBER || ''),
  ignore: (process.env.IGNORE_NUMBERS || '').split(',').map(normalizeChatId).filter(Boolean),
  debounceMs: Number(process.env.DEBOUNCE_SECONDS || 10) * 1000,
  historyLimit: Number(process.env.HISTORY_MESSAGES || 30),
  workStart: Number(process.env.WORK_HOUR_START || 9),
  workEnd: Number(process.env.WORK_HOUR_END || 17),
  outOfHoursText: process.env.OUT_OF_HOURS_TEXT || '',
  takeoverHours: Number(process.env.TAKEOVER_PAUSE_HOURS || 12),
};

if (!cfg.anthropicKey) console.warn('[!] ANTHROPIC_API_KEY belum diisi di .env');
if (!cfg.adminChatId && cfg.mode !== 'off') console.warn('[!] ADMIN_NUMBER belum diisi: draft & eskalasi tidak bisa dikirim ke Elha');

// ---------- Pengetahuan (system prompt) ----------
const KNOWLEDGE = ['second-brain-bot-whatsapp.md', 'panduan-gaya-bahasa-elha.md']
  .map((f) => fs.readFileSync(path.join(ROOT, 'knowledge', f), 'utf8'))
  .join('\n\n---\n\n');

const RULES = `Kamu menjalankan WhatsApp admin Habits Media atas nama Elha. Semua aturan, gaya bahasa, dan batas ada di dokumen pengetahuan di bawah.

Aturan teknis:
- Selalu jawab dengan memanggil tool "tentukan_balasan".
- "balasan" adalah teks WhatsApp siap kirim ke client, persis seperti yang akan dibaca client. Tanpa markdown heading/tabel; tebal pakai *bintang tunggal*.
- Jika perlu keputusan Elha (lihat bagian "Wajib eskalasi"), set perlu_eskalasi=true, isi "balasan" dengan balasan sementara yang sopan, dan isi ringkasan_untuk_elha.
- Jangan pernah menyebut angka harga yang tidak ada di rate card resmi.
- Jika client bertanya apakah ini bot/AI, jawab jujur bahwa ini asisten admin Habits Media yang membantu Elha, dan Elha akan ikut menindaklanjuti.
- Jika pesan adalah spam/tidak perlu dibalas, set balasan kosong "".
- Pesan berlabel [Elha membalas manual] adalah balasan Elha sendiri; ikuti arahannya.
- Lampiran (proposal, gambar, dokumen) tidak bisa kamu buka; konfirmasi penerimaan dan eskalasi bila isinya penting.`;

const TOOL = {
  name: 'tentukan_balasan',
  description: 'Balasan WhatsApp untuk client beserta keputusan eskalasi.',
  input_schema: {
    type: 'object',
    properties: {
      golongan: { type: 'string', enum: ['Placement', 'Media partner', 'Partnership lainnya', 'Client lama', 'Individu/umum', 'Spam'] },
      balasan: { type: 'string', description: 'Teks yang dikirim ke client. Kosong jika tidak perlu dibalas.' },
      perlu_eskalasi: { type: 'boolean' },
      ringkasan_untuk_elha: { type: 'string', description: 'Wajib jika eskalasi: nama/brand, golongan, kebutuhan, budget/timeline, pertanyaan untuk Elha, usulan balasan.' },
    },
    required: ['golongan', 'balasan', 'perlu_eskalasi'],
  },
};

// ---------- State (disimpan di data/state.json) ----------
const STATE_FILE = path.join(ROOT, 'data', 'state.json');
let state = { chats: {}, drafts: {}, nextDraftId: 1 };
try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }; } catch {}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state, null, 1));
    fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
  }, 500);
}
function chat(id) {
  return (state.chats[id] ||= { history: [], name: '', pausedUntil: 0, lastOutOfHours: 0 });
}
function pushHistory(id, role, text) {
  const c = chat(id);
  c.history.push({ role, text, at: Date.now() });
  if (c.history.length > cfg.historyLimit) c.history = c.history.slice(-cfg.historyLimit);
  save();
}

// ---------- WAHA API ----------
async function waha(pathname, body) {
  const res = await fetch(cfg.wahaUrl + pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cfg.wahaKey ? { 'X-Api-Key': cfg.wahaKey } : {}) },
    body: JSON.stringify({ session: cfg.session, ...body }),
  });
  if (!res.ok) throw new Error(`WAHA ${pathname} ${res.status}: ${await res.text()}`);
  return res.json().catch(() => ({}));
}
const recentlySent = new Map(); // chatId -> [{text, at}] untuk mengenali pesan kita sendiri
async function sendText(chatId, text) {
  const list = (recentlySent.get(chatId) || []).filter((x) => Date.now() - x.at < 120000);
  list.push({ text: text.trim(), at: Date.now() });
  recentlySent.set(chatId, list);
  return waha('/api/sendText', { chatId, text });
}
function isOwnBotMessage(chatId, text) {
  const list = recentlySent.get(chatId) || [];
  const i = list.findIndex((x) => x.text === (text || '').trim());
  if (i >= 0) { list.splice(i, 1); return true; }
  return false;
}
async function notifyAdmin(text) {
  if (!cfg.adminChatId) return console.log('[ADMIN]\n' + text);
  try { await sendText(cfg.adminChatId, text); } catch (e) { console.error('Gagal kirim ke admin:', e.message); }
}

// ---------- Claude API ----------
async function askClaude(chatId, contextNote) {
  const c = chat(chatId);
  const msgs = [];
  for (const h of c.history) {
    const role = h.role === 'client' ? 'user' : 'assistant';
    const text = h.role === 'elha' ? `[Elha membalas manual] ${h.text}` : h.text;
    const last = msgs[msgs.length - 1];
    if (last && last.role === role) last.content += '\n' + text;
    else msgs.push({ role, content: text });
  }
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  if (!msgs.length) return null;
  const lastUser = msgs[msgs.length - 1];
  if (lastUser.role !== 'user') return null; // tidak ada pesan client baru
  lastUser.content = `${contextNote}\n\n${lastUser.content}`;

  const body = {
    model: cfg.model,
    max_tokens: 1500,
    system: [
      { type: 'text', text: RULES },
      { type: 'text', text: KNOWLEDGE, cache_control: { type: 'ephemeral' } },
    ],
    tools: [TOOL],
    tool_choice: { type: 'tool', name: TOOL.name },
    messages: msgs,
  };
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(cfg.anthropicBase + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': cfg.anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = await res.json();
      const tool = (data.content || []).find((b) => b.type === 'tool_use');
      if (!tool) throw new Error('Claude tidak memanggil tool');
      return tool.input;
    }
    const errText = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await sleep(2000 * attempt);
      continue;
    }
    throw new Error(`Claude API ${res.status}: ${errText}`);
  }
}

// ---------- Logika utama ----------
const buffers = new Map(); // chatId -> timer (gabungkan beberapa bubble client)

function wibNow() {
  const d = new Date(Date.now() + 7 * 3600 * 1000);
  return { hour: d.getUTCHours(), day: d.getUTCDay(), label: d.toISOString().slice(0, 16).replace('T', ' ') + ' WIB' };
}
function inWorkHours() {
  const { hour, day } = wibNow();
  return day >= 1 && day <= 5 && hour >= cfg.workStart && hour < cfg.workEnd;
}

function scheduleReply(chatId) {
  clearTimeout(buffers.get(chatId));
  buffers.set(chatId, setTimeout(() => { buffers.delete(chatId); handleChat(chatId).catch((e) => console.error(e)); }, cfg.debounceMs));
}

async function handleChat(chatId) {
  const c = chat(chatId);
  if (cfg.mode === 'off' || c.pausedUntil > Date.now()) return;
  const now = wibNow();
  const working = inWorkHours();
  const isNew = !c.history.some((h) => h.role !== 'client');
  const note = `[Info sistem: waktu ${now.label}; nama WhatsApp client: ${c.name || 'tidak diketahui'}; ${isNew ? 'ini kontak BARU, pakai template balasan pertama' : 'percakapan lanjutan'}.]`;

  waha('/api/sendSeen', { chatId }).catch(() => {});
  let r;
  try {
    r = await askClaude(chatId, note);
  } catch (e) {
    console.error('Claude error:', e.message);
    return notifyAdmin(`⚠️ Bot gagal memproses chat ${pretty(chatId)} (${c.name}). Mohon dibalas manual.\nError: ${e.message.slice(0, 300)}`);
  }
  if (!r) return;
  const reply = (r.balasan || '').trim();
  const summary = r.ringkasan_untuk_elha ? `\n\n📋 Ringkasan:\n${r.ringkasan_untuk_elha}` : '';
  const header = `${pretty(chatId)} (${c.name || '-'}) · ${r.golongan}`;

  const autoSend = cfg.mode === 'auto' && working;
  if (autoSend && reply) {
    await typeAndSend(chatId, reply);
    pushHistory(chatId, 'bot', reply);
    if (r.perlu_eskalasi) await notifyAdmin(`🔔 *Perlu keputusan Elha*\n${header}\n\nBot sudah kirim balasan sementara:\n"${reply}"${summary}\n\nBalas langsung ke client dari WhatsApp. Bot berhenti di chat itu ${cfg.takeoverHours} jam setelah Elha membalas.`);
    return;
  }

  // Mode draft, atau di luar jam kerja: simpan draft untuk disetujui Elha.
  if (!reply && !r.perlu_eskalasi) return;
  if (cfg.mode === 'auto' && !working && cfg.outOfHoursText && Date.now() - c.lastOutOfHours > 12 * 3600 * 1000) {
    await sendText(chatId, cfg.outOfHoursText).catch((e) => console.error(e.message));
    pushHistory(chatId, 'bot', cfg.outOfHoursText);
    c.lastOutOfHours = Date.now();
  }
  const id = state.nextDraftId++;
  state.drafts[id] = { chatId, text: reply, at: Date.now() };
  save();
  await notifyAdmin(`${r.perlu_eskalasi ? '🔔 *Perlu keputusan Elha*' : '📝 *Draft balasan*'} #${id}\n${header}\n\nPesan client:\n"${lastClientText(chatId)}"\n\nUsulan balasan:\n${reply || '(tidak ada)'}${summary}\n\nKetik *kirim ${id}* untuk mengirim, *ubah ${id} teks baru* untuk mengirim versi Elha, atau *batal ${id}*.`);
}

async function typeAndSend(chatId, text) {
  try { await waha('/api/startTyping', { chatId }); await sleep(Math.min(6000, 1000 + text.length * 25)); await waha('/api/stopTyping', { chatId }); } catch {}
  await sendText(chatId, text);
}

function lastClientText(chatId) {
  const h = chat(chatId).history;
  const out = [];
  for (let i = h.length - 1; i >= 0 && h[i].role === 'client'; i--) out.unshift(h[i].text);
  return out.join('\n').slice(0, 700);
}

// ---------- Perintah dari Elha (dari ADMIN_NUMBER) ----------
async function handleAdminCommand(text) {
  const t = text.trim();
  let m;
  if ((m = t.match(/^kirim\s+#?(\d+)\s*$/i))) return sendDraft(m[1]);
  if ((m = t.match(/^ubah\s+#?(\d+)[\s:]+([\s\S]+)$/i))) return sendDraft(m[1], m[2].trim());
  if ((m = t.match(/^batal\s+#?(\d+)/i))) { delete state.drafts[m[1]]; save(); return notifyAdmin(`Draft #${m[1]} dibatalkan.`); }
  if ((m = t.match(/^(pause|jeda)\s+(\S+)/i))) { chat(normalizeChatId(m[2])).pausedUntil = Date.now() + 3650 * 864e5; save(); return notifyAdmin(`Bot dijeda untuk ${m[2]}.`); }
  if ((m = t.match(/^(lanjut|resume)\s+(\S+)/i))) { chat(normalizeChatId(m[2])).pausedUntil = 0; save(); return notifyAdmin(`Bot aktif lagi untuk ${m[2]}.`); }
  if (/^mode\s+(draft|auto|off)$/i.test(t)) { cfg.mode = t.split(/\s+/)[1].toLowerCase(); return notifyAdmin(`Mode bot sekarang: ${cfg.mode} (kembali ke isi .env saat bot di-restart).`); }
  if (/^status$/i.test(t)) {
    const ids = Object.keys(state.drafts);
    return notifyAdmin(`Mode: ${cfg.mode}. Draft menunggu: ${ids.length ? ids.map((i) => `#${i} ${pretty(state.drafts[i].chatId)}`).join(', ') : 'tidak ada'}.`);
  }
  if (/^(bantuan|help)$/i.test(t)) return notifyAdmin('Perintah: kirim N · ubah N teks · batal N · status · mode draft|auto|off · jeda 628xx · lanjut 628xx');
  return false; // bukan perintah: diperlakukan sebagai chat biasa
}
async function sendDraft(id, override) {
  const d = state.drafts[id];
  if (!d) return notifyAdmin(`Draft #${id} tidak ditemukan.`);
  const text = override || d.text;
  if (!text) return notifyAdmin(`Draft #${id} kosong, pakai: ubah ${id} teks balasan`);
  try {
    await typeAndSend(d.chatId, text);
    pushHistory(d.chatId, override ? 'elha' : 'bot', text);
    delete state.drafts[id]; save();
    return notifyAdmin(`✅ Terkirim ke ${pretty(d.chatId)}.`);
  } catch (e) { return notifyAdmin(`Gagal kirim #${id}: ${e.message.slice(0, 200)}`); }
}

// ---------- Webhook ----------
async function onEvent(evt) {
  if (!evt || !['message', 'message.any'].includes(evt.event)) return;
  const p = evt.payload || {};
  const fromMe = !!p.fromMe;
  const chatId = fromMe ? p.to : p.from;
  if (!chatId || /@g\.us$|@newsletter$|@broadcast$/.test(chatId)) return; // abaikan grup, channel, status
  const text = (p.body || '').trim();
  const attachment = p.hasMedia ? `[client mengirim lampiran${p.media?.mimetype ? ' ' + p.media.mimetype : ''}${p.media?.filename ? ': ' + p.media.filename : ''}]` : '';
  const content = [text, attachment].filter(Boolean).join('\n');
  if (!content) return;
  console.log(`${fromMe ? '→' : '←'} ${chatId}: ${content.slice(0, 80).replace(/\n/g, ' ')}`);

  // Perintah dari Elha
  // (nomor admin terpisah, atau chat "Message yourself" jika nomornya sama)
  if (cfg.adminChatId && sameNumber(chatId, cfg.adminChatId)) {
    if (fromMe && isOwnBotMessage(chatId, text)) return; // notifikasi bot sendiri
    await handleAdminCommand(text); // selain perintah, chat dari admin tidak dibalas bot
    return;
  }
  if (fromMe) {
    if (isOwnBotMessage(chatId, text)) return;
    // Elha membalas manual dari HP: catat dan jeda bot di chat ini
    pushHistory(chatId, 'elha', content);
    chat(chatId).pausedUntil = Date.now() + cfg.takeoverHours * 3600 * 1000;
    clearTimeout(buffers.get(chatId)); buffers.delete(chatId);
    for (const [id, d] of Object.entries(state.drafts)) if (d.chatId === chatId) delete state.drafts[id];
    save();
    return;
  }
  if (cfg.ignore.some((n) => sameNumber(chatId, n))) return;

  const c = chat(chatId);
  c.name = p._data?.notifyName || p._data?.pushName || p.notifyName || c.name;
  pushHistory(chatId, 'client', content);
  scheduleReply(chatId);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, mode: cfg.mode, model: cfg.model, drafts: Object.keys(state.drafts).length }));
  }
  if (req.method === 'POST' && url.pathname === '/webhook') {
    if (cfg.webhookToken && url.searchParams.get('token') !== cfg.webhookToken) { res.writeHead(401); return res.end(); }
    let raw = '';
    req.on('data', (d) => { raw += d; if (raw.length > 5e6) req.destroy(); });
    req.on('end', () => {
      res.writeHead(200); res.end('ok');
      let evt; try { evt = JSON.parse(raw); } catch { return; }
      onEvent(evt).catch((e) => console.error('Webhook error:', e));
    });
    return;
  }
  res.writeHead(404); res.end();
});
server.listen(cfg.port, () => console.log(`Bot Habits Media jalan di port ${cfg.port} · mode=${cfg.mode} · model=${cfg.model}`));

// ---------- Utilitas ----------
function normalizeChatId(s) {
  s = String(s || '').trim();
  if (!s) return '';
  if (s.includes('@')) return s;
  let d = s.replace(/\D/g, '');
  if (d.startsWith('0')) d = '62' + d.slice(1);
  return d ? d + '@c.us' : '';
}
function sameNumber(a, b) { return !!a && !!b && a.split('@')[0] === b.split('@')[0]; }
function pretty(id) { return '+' + String(id).split('@')[0]; }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let v = m[2];
    if (/^".*"$|^'.*'$/.test(v)) v = v.slice(1, -1);
    process.env[m[1]] = v.replace(/\\n/g, '\n');
  }
}
