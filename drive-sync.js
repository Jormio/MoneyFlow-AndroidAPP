/* ===== MoneyFlow — Synchronisation Google Drive =====
   Remplace le serveur Python local (server.py) par un stockage
   du fichier JSON existant sur Google Drive (ex: Comptes_Parents.json).
   Nécessite : CLIENT_ID (OAuth2 Web) + API_KEY (pour le Picker).
   À renseigner ci-dessous une fois créés dans Google Cloud Console.
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
let _fileId = localStorage.getItem('mf_drive_fileId') || null;
let _fileName = localStorage.getItem('mf_drive_fileName') || 'Comptes_Parents.json';

function driveIsConfigured() {
  return !DRIVE_CONFIG.CLIENT_ID.startsWith('REMPLACER') && !DRIVE_CONFIG.API_KEY.startsWith('REMPLACER');
}

function driveHasFile() {
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

// Récupère un access token valide (silencieux si déjà accordé, sinon popup de consentement)
function driveGetToken(interactive) {
  return new Promise(async (resolve, reject) => {
    try {
      await _ensureGis();
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
        resolve(_accessToken);
      };
      _gisTokenClient.requestAccessToken({ prompt: interactive ? 'consent' : '' });
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
      .setMimeTypes('application/json')
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
          localStorage.setItem('mf_drive_fileId', _fileId);
          localStorage.setItem('mf_drive_fileName', _fileName);
          resolve({ fileId: _fileId, fileName: _fileName });
        } else if (data.action === google.picker.Action.CANCEL) {
          resolve(null);
        }
      })
      .build();
    picker.setVisible(true);
  });
}

// Lit le contenu JSON du fichier Drive sélectionné
async function driveLoad(_attempt) {
  if (!_fileId) return null;
  const attempt = _attempt || 1;
  const token = await driveGetToken(false);
  try {
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${_fileId}?alt=media`, {
      headers: { Authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(60000)
    });
    if (!r.ok) {
      if (r.status === 404) driveForget();
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
  localStorage.removeItem('mf_drive_fileId');
  localStorage.removeItem('mf_drive_fileName');
}
