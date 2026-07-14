/* ===== MoneyFlow — Synchronisation Google Drive =====
   Remplace le serveur Python local (server.py) par un stockage
   du fichier JSON existant sur Google Drive.
   CLIENT_ID et API_KEY configurés ci-dessous.
*/
const DRIVE_CONFIG = {
  CLIENT_ID: '511188293229-ftulmn4212jiteq88fvdr2np707cqou7.apps.googleusercontent.com',
  API_KEY: 'AIzaSyBWN0L2u2jNaDSG-sO7-TNsz_DgJcG3Ovc',
  SCOPES: 'https://www.googleapis.com/auth/drive'
};

let _gisTokenClient = null;
let _accessToken = null;
let _tokenExpiry = 0;
let _pickerLoaded = false;
let _gisLoaded = false;

// ===== Persistance fileId : localStorage + cookie (iOS robustesse) =====
function _readFileId() {
  try {
    const ls = localStorage.getItem('mf_drive_fileId');
    if (ls) return ls;
  } catch(e) {}
  // Fallback cookie
  const m = document.cookie.match(/mf_drive_fileId=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function _writeFileId(id) {
  try { localStorage.setItem('mf_drive_fileId', id); } catch(e) {}
  const exp = new Date(Date.now() + 365*24*3600*1000).toUTCString();
  document.cookie = `mf_drive_fileId=${encodeURIComponent(id)};expires=${exp};path=/;SameSite=Strict`;
}

function _clearFileId() {
  try { localStorage.removeItem('mf_drive_fileId'); } catch(e) {}
  document.cookie = 'mf_drive_fileId=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/';
}

function _readFileName() {
  try {
    const ls = localStorage.getItem('mf_drive_fileName');
    if (ls) return ls;
  } catch(e) {}
  const m = document.cookie.match(/mf_drive_fileName=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : 'Comptes_Parents.json';
}

function _writeFileName(name) {
  try { localStorage.setItem('mf_drive_fileName', name); } catch(e) {}
  const exp = new Date(Date.now() + 365*24*3600*1000).toUTCString();
  document.cookie = `mf_drive_fileName=${encodeURIComponent(name)};expires=${exp};path=/;SameSite=Strict`;
}

let _fileId = _readFileId();
let _fileName = _readFileName();

// Helpers cookies génériques pour d'autres clés (ex: backupFileId)
function _readCookie(key) {
  try { const ls = localStorage.getItem(key); if (ls) return ls; } catch(e) {}
  const m = document.cookie.match(new RegExp(key + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}
function _writeCookie(key, val) {
  try { localStorage.setItem(key, val); } catch(e) {}
  const exp = new Date(Date.now() + 365*24*3600*1000).toUTCString();
  document.cookie = `${key}=${encodeURIComponent(val)};expires=${exp};path=/;SameSite=Strict`;
}
function _clearCookie(key) {
  try { localStorage.removeItem(key); } catch(e) {}
  document.cookie = `${key}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
}

function driveIsConfigured() {
  return !DRIVE_CONFIG.CLIENT_ID.startsWith('REMPLACER') && !DRIVE_CONFIG.API_KEY.startsWith('REMPLACER');
}

function driveHasFile() {
  if (!_fileId) _fileId = _readFileId();
  return !!_fileId;
}

// Charge dynamiquement les scripts Google (GIS + API client) à la demande
function _loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function _ensureGis() {
  if (_gisLoaded) return;
  await _loadScript('https://accounts.google.com/gsi/client');
  _gisLoaded = true;
}

async function _ensurePicker() {
  if (_pickerLoaded) return;
  await _loadScript('https://apis.google.com/js/api.js');
  await new Promise((resolve) => gapi.load('picker', resolve));
  _pickerLoaded = true;
}

function _isSafariIOS() {
  return /iP(hone|ad|od)/.test(navigator.userAgent) && /WebKit/.test(navigator.userAgent)
    && !/CriOS/.test(navigator.userAgent) && !/FxiOS/.test(navigator.userAgent);
}

// Récupère un access token valide (silencieux si déjà accordé, sinon popup de consentement)
function driveGetToken(interactive) {
  return new Promise(async (resolve, reject) => {
    try {
      await _ensureGis();
      // Relire le token depuis cookie/localStorage si la variable mémoire est vide
      if (!_accessToken || Date.now() >= _tokenExpiry - 30000) {
        const savedToken = _readCookie('mf_drive_token');
        const savedExpiry = parseInt(_readCookie('mf_drive_token_exp') || '0');
        if (savedToken && Date.now() < savedExpiry - 30000) {
          _accessToken = savedToken;
          _tokenExpiry = savedExpiry;
        }
      }
      if (_accessToken && Date.now() < _tokenExpiry - 30000) { resolve(_accessToken); return; }
      if (!_gisTokenClient) {
        _gisTokenClient = google.accounts.oauth2.initTokenClient({
          client_id: DRIVE_CONFIG.CLIENT_ID,
          scope: DRIVE_CONFIG.SCOPES,
          callback: () => {},
        });
      }
      _gisTokenClient.callback = (resp) => {
        if (resp.error) { reject(resp); return; }
        _accessToken = resp.access_token;
        _tokenExpiry = Date.now() + (resp.expires_in || 3600) * 1000;
        // Persister le token pour éviter la popup au prochain démarrage
        _writeCookie('mf_drive_token', _accessToken);
        _writeCookie('mf_drive_token_exp', String(_tokenExpiry));
        resolve(_accessToken);
      };
      // Sur Safari iOS, forcer prompt='' pour éviter le blocage popup
      const prompt = interactive && !_isSafariIOS() ? 'consent' : '';
      _gisTokenClient.requestAccessToken({ prompt });
    } catch (e) { reject(e); }
  });
}

// Ouvre le sélecteur Google Picker pour choisir le fichier JSON existant une seule fois
async function driveOpenPicker() {
  if (!driveIsConfigured()) { toast('Configurez CLIENT_ID et API_KEY dans drive-sync.js', 'error'); return; }
  const token = await driveGetToken(true);
  await _ensurePicker();
  return new Promise((resolve) => {
    const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(false);
    const picker = new google.picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(token)
      .setDeveloperKey(DRIVE_CONFIG.API_KEY)
      .setCallback((data) => {
        if (data.action === google.picker.Action.PICKED) {
          const doc = data.docs[0];
          _fileId = doc.id;
          _fileName = doc.name;
          _writeFileId(_fileId);
          _writeFileName(_fileName);
          resolve({ fileId: _fileId, fileName: _fileName });
        } else if (data.action === google.picker.Action.CANCEL) {
          resolve(null);
        }
      })
      .build();
    picker.setVisible(true);
  });
}

// Recherche automatique du fichier par nom si fileId perdu (iOS PWA storage reset)
async function driveFindFileByName(name) {
  try {
    const token = await driveGetToken(false);
    const q = encodeURIComponent(`name='${name}' and trashed=false`);
    const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=5`, {
      headers: { Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (j.files && j.files.length > 0) {
      const f = j.files[0];
      _fileId = f.id;
      _fileName = f.name;
      _writeFileId(_fileId);
      _writeFileName(_fileName);
      console.log('Drive: fichier retrouvé automatiquement', f.name, f.id);
      return f.id;
    }
  } catch(e) { console.warn('driveFindFileByName error', e); }
  return null;
}

// Charge les données : si fileId perdu, tente de le retrouver par nom avant d'échouer
async function driveLoadAuto() {
  if (!_fileId) _fileId = _readFileId();
  if (!_fileId) {
    // Tenter de retrouver le fichier par son dernier nom connu
    const lastName = _readFileName();
    if (lastName) await driveFindFileByName(lastName);
  }
  if (!_fileId) return null;
  return driveLoad();
}

// Lit le contenu JSON du fichier Drive sélectionné
async function driveLoad(_attempt) {
  if (!_fileId) return null;
  const attempt = _attempt || 1;
  try {
    // Forcer renouvellement du token si c'est un retry après 401
    const token = await driveGetToken(false);
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${_fileId}?alt=media`, {
      headers: { Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(60000)
    });
    if (!r.ok) {
      if (r.status === 404) driveForget();
      if (r.status === 401 && attempt < 3) {
        // Token expiré : invalider le token mémorisé et réessayer
        _accessToken = null; _tokenExpiry = 0;
        _clearCookie('mf_drive_token'); _clearCookie('mf_drive_token_exp');
        await new Promise(res => setTimeout(res, 1000));
        return driveLoad(attempt + 1);
      }
      if ((r.status === 429 || r.status >= 500) && attempt < 4) {
        await new Promise(res => setTimeout(res, attempt * 3000));
        return driveLoad(attempt + 1);
      }
      throw new Error('Drive load HTTP ' + r.status);
    }
    return r.json();
  } catch (e) {
    if (attempt < 4 && !String(e).includes('HTTP')) {
      await new Promise(res => setTimeout(res, attempt * 3000));
      return driveLoad(attempt + 1);
    }
    throw e;
  }
}

// Écrit le JSON dans le fichier Drive existant (PATCH media, conserve le même fileId)
// Retry automatique avec backoff progressif pour réseaux instables/lents.
async function driveSave(obj, _attempt) {
  if (!_fileId) return false;
  const attempt = _attempt || 1;
  const token = await driveGetToken(false);
  const body = JSON.stringify(obj);
  // Timeout plus généreux : base 20s, +1s par 100 caractères, plafonné à 90s
  const ms = Math.max(20000, Math.min(90000, body.length / 100));
  try {
    const r = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${_fileId}?uploadType=media`, {
      method: 'PATCH',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(ms)
    });
    if (!r.ok) {
      let detail = '';
      try { const j = await r.json(); detail = j?.error?.message || ''; } catch(e) {}
      window._driveLastError = `HTTP ${r.status} ${detail}`;
      console.warn('driveSave HTTP error', r.status, detail);
      if (r.status === 404) { driveForget(); return false; }
      if (r.status === 401 && attempt < 3) {
        // Token expiré : invalider et réessayer
        _accessToken = null; _tokenExpiry = 0;
        _clearCookie('mf_drive_token'); _clearCookie('mf_drive_token_exp');
        await new Promise(res => setTimeout(res, 1000));
        return driveSave(obj, attempt + 1);
      }
      // Erreurs serveur transitoires (429 rate limit, 5xx) : retry avec backoff
      if ((r.status === 429 || r.status >= 500) && attempt < 4) {
        await new Promise(res => setTimeout(res, attempt * 3000));
        return driveSave(obj, attempt + 1);
      }
    }
    return r.ok;
  } catch (e) {
    window._driveLastError = String(e);
    console.warn('driveSave error (tentative ' + attempt + ')', e);
    // Timeout/erreur réseau : retry avec délai croissant (réseau lent/instable)
    if (attempt < 4) {
      await new Promise(res => setTimeout(res, attempt * 3000));
      return driveSave(obj, attempt + 1);
    }
    return false;
  }
}

function driveForget() {
  _fileId = null;
  _clearFileId();
  try { localStorage.removeItem('mf_drive_fileName'); } catch(e) {}
  document.cookie = 'mf_drive_fileName=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/';
}

// ===== Backup glissant (un seul fichier, écrasé à chaque démarrage) =====
let _backupFileId = _readCookie('mf_drive_backupFileId');

function _backupName() {
  const base = _fileName.replace(/\.json$/i, '');
  return base + '_backup.json';
}

// Récupère le dossier parent du fichier principal
async function _getParentFolder(token) {
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${_fileId}?fields=parents`, {
    headers: { Authorization: 'Bearer ' + token }
  });
  if (!r.ok) return null;
  const j = await r.json();
  return (j.parents && j.parents[0]) || null;
}

// Cherche le fichier de backup existant (par nom, dans le même dossier)
async function _findBackupFile(token) {
  const parent = await _getParentFolder(token);
  const q = encodeURIComponent(`name='${_backupName()}'` + (parent ? ` and '${parent}' in parents` : '') + ' and trashed=false');
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)`, {
    headers: { Authorization: 'Bearer ' + token }
  });
  if (!r.ok) return null;
  const j = await r.json();
  return (j.files && j.files[0] && j.files[0].id) || null;
}

// Écrit (ou crée si absent) le fichier de backup glissant, écrasé à chaque appel
async function driveBackupNow(obj) {
  if (!_fileId) return false;
  try {
    const token = await driveGetToken(false);
    if (!_backupFileId) {
      _backupFileId = await _findBackupFile(token);
      if (_backupFileId) _writeCookie('mf_drive_backupFileId', _backupFileId);
    }
    const body = JSON.stringify(obj);
    if (_backupFileId) {
      // Le backup existe déjà : on l'écrase (PATCH media)
      const r = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${_backupFileId}?uploadType=media`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body, signal: AbortSignal.timeout(60000)
      });
      if (r.status === 404) { _backupFileId = null; _clearCookie('mf_drive_backupFileId'); return driveBackupNow(obj); }
      return r.ok;
    } else {
      // Pas de backup existant : on le crée dans le même dossier que le fichier principal
      const parent = await _getParentFolder(token);
      const metadata = { name: _backupName(), parents: parent ? [parent] : undefined };
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
      form.append('file', new Blob([body], { type: 'application/json' }));
      const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token },
        body: form, signal: AbortSignal.timeout(60000)
      });
      if (!r.ok) return false;
      const j = await r.json();
      _backupFileId = j.id;
      _writeCookie('mf_drive_backupFileId', _backupFileId);
      return true;
    }
  } catch (e) { console.warn('driveBackupNow error', e); return false; }
}
