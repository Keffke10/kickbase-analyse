// Schlanker Client für die (inoffizielle) Kickbase-API v4.
// Läuft komplett im Browser: Zugangsdaten gehen ausschließlich direkt an api.kickbase.com.

const BASE = 'https://api.kickbase.com/v4';

export class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Bekannte Kickbase-Fehlercodes (errMsg) in verständliche Meldungen übersetzen
const ERR_TEXT = {
  UnderpayNotAllowed: 'Das Gebot liegt unter dem Marktwert bzw. Angebotspreis.',
  NotEnoughMoney: 'Dafür reicht dein Budget nicht.',
  NotFound: 'Nicht gefunden – evtl. ist der Spieler nicht mehr auf dem Markt oder das Angebot ist abgelaufen.',
};

async function request(path, { method = 'GET', token, body, signal } = {}) {
  const headers = { Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(BASE + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    });
    if (res.status === 429 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      continue;
    }
    if (!res.ok) {
      let code = null;
      try { code = (await res.json()).errMsg ?? null; } catch { /* kein JSON */ }
      const msg = res.status === 401 ? 'Sitzung abgelaufen – bitte neu anmelden.'
        : res.status === 403 ? 'Kein Zugriff.'
        : code ? (ERR_TEXT[code] || `Kickbase lehnt ab: ${code}`)
        : `Kickbase-API Fehler ${res.status}`;
      throw new ApiError(res.status, msg, code);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
}

/** Login – liefert Token + Ligen. Das Passwort wird nirgends gespeichert. */
export async function login(email, password) {
  try {
    const d = await request('/user/login', {
      method: 'POST',
      body: { em: email, pass: password, loy: false, rep: {} },
    });
    return {
      token: d.tkn,
      expires: d.tknex,
      user: { id: d.u.id, name: d.u.name, uim: d.u.uim },
      leagues: (d.srvl || []).map((l) => ({ id: l.id, name: l.name, cpi: l.cpi, uim: l.lim })),
    };
  } catch (e) {
    if (e.status === 401 || e.status === 400 || e.status === 404) throw new ApiError(e.status, 'E-Mail oder Passwort falsch.');
    throw e;
  }
}

/** Führt fn für alle items mit begrenzter Parallelität aus (schont die API). */
export async function pool(items, limit, fn, onProgress) {
  const out = new Array(items.length);
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i], i);
      } catch (e) {
        if (e.status === 401) throw e;
        out[i] = null;
      }
      done++;
      onProgress?.(done, items.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export class Kickbase {
  constructor(token, leagueId, competitionId = '1') {
    this.cpi = competitionId;
    this.token = token;
    this.lid = leagueId;
    this.cache = new Map();
  }

  get(path, { fresh = false } = {}) {
    if (!fresh && this.cache.has(path)) return this.cache.get(path);
    const p = request(path, { token: this.token }).catch((e) => {
      this.cache.delete(path);
      throw e;
    });
    this.cache.set(path, p);
    return p;
  }

  clearCache() { this.cache.clear(); }

  /** Nur die Daten verwerfen, die sich durch eine Aktion ändern (Rest bleibt gecacht → schnelles Neuladen). */
  invalidateLive() {
    const live = ['/me', '/squad', '/market', '/lineup', '/teamcenter/myeleven', '/teamprofile', '/ranking', '/activitiesFeed'];
    for (const k of [...this.cache.keys()]) if (live.some((s) => k.includes(s))) this.cache.delete(k);
  }

  send(method, path, body) {
    return request(path, { method, token: this.token, body });
  }

  // ---- Schreibende Aktionen (werden in der App immer erst bestätigt)
  setLineup(formation, playerIds) { return this.send('POST', `/leagues/${this.lid}/lineup`, { type: formation, players: playerIds }); }
  placeBid(pid, price) { return this.send('POST', `/leagues/${this.lid}/market/${pid}/offers`, { price }); }
  withdrawBid(pid, offerId) { return this.send('DELETE', `/leagues/${this.lid}/market/${pid}/offers/${offerId}`); }
  listPlayer(pid, price) { return this.send('POST', `/leagues/${this.lid}/market`, { pi: pid, prc: price }); }
  unlistPlayer(pid) { return this.send('DELETE', `/leagues/${this.lid}/market/${pid}`); }
  acceptOffer(pid, offerId) { return this.send('POST', `/leagues/${this.lid}/market/${pid}/offers/${offerId}/accept`, {}); }
  declineOffer(pid, offerId) { return this.send('POST', `/leagues/${this.lid}/market/${pid}/offers/${offerId}/decline`, {}); }

  // Liga
  me() { return this.get(`/leagues/${this.lid}/me`); }
  overview() { return this.get(`/leagues/${this.lid}/overview`); }
  squad() { return this.get(`/leagues/${this.lid}/squad`); }
  market() { return this.get(`/leagues/${this.lid}/market`); }
  ranking(day) { return this.get(`/leagues/${this.lid}/ranking${day ? `?dayNumber=${day}` : ''}`); }
  myEleven() { return this.get(`/leagues/${this.lid}/teamcenter/myeleven`); }
  feed(max = 100) { return this.get(`/leagues/${this.lid}/activitiesFeed?start=0&max=${max}`); }
  teamProfile(tid) { return this.get(`/leagues/${this.lid}/teams/${tid}/teamprofile`); }
  managerSquad(uid) { return this.get(`/leagues/${this.lid}/managers/${uid}/squad`); }
  managerDashboard(uid) { return this.get(`/leagues/${this.lid}/managers/${uid}/dashboard`); }
  managerPerformance(uid) { return this.get(`/leagues/${this.lid}/managers/${uid}/performance`); }

  // Spieler
  player(pid) { return this.get(`/leagues/${this.lid}/players/${pid}`); }
  marketValue(pid, days = 92) { return this.get(`/leagues/${this.lid}/players/${pid}/marketvalue/${days}`); }
  transferHistory(pid) { return this.get(`/leagues/${this.lid}/players/${pid}/transferHistory`); }
  performance(pid) { return this.get(`/competitions/${this.cpi}/players/${pid}/performance`); }

  // Wettbewerb
  table() { return this.get(`/competitions/${this.cpi}/table`); }
  matchdays() { return this.get(`/competitions/${this.cpi}/matchdays`); }
}
