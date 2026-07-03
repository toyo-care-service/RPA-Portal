/**
 * RPA Portal API (GitHub Pages フロントエンド用バックエンド)
 *
 * データ構成:
 *  - 実績一覧シート(gid=963808362) = 数値実績のマスタ(読み取り + 新規RPA行追加のみ)
 *  - APP_* タブ = アプリ管理データ(説明・部署・タグ・録画・バックログ等)
 *  - 結合キーは RPA名(空白除去・中点統一で正規化)
 */

const SS_ID = '1aKg7bkAisIC4OCO_RPu7dTPpx1iOIhdnURYNgJma13U';
const JISSEKI_GID = 963808362;
const HOURLY_WAGE = 1750;

const COLLECTIONS = {
  rpas: {
    sheet: 'APP_RPA',
    cols: ['id', 'name', 'description', 'department', 'tags', 'operationMode', 'sheets', 'sheetUrl', 'recordingUrl', 'devHours', 'tool', 'savedMinutes', 'savedAmount', 'runCount', 'createdAt', 'updatedAt'],
    json: ['tags', 'sheets'],
    num: ['devHours', 'savedMinutes', 'savedAmount', 'runCount']
  },
  runs: {
    sheet: 'APP_RUNS',
    cols: ['id', 'rpaId', 'scheduleId', 'status', 'executedAt', 'savedMinutes', 'runCount'],
    json: [],
    num: ['savedMinutes', 'runCount']
  },
  recordings: {
    sheet: 'APP_RECORDINGS',
    cols: ['id', 'rpaId', 'name', 'url'],
    json: [],
    num: []
  },
  backlog: {
    sheet: 'APP_BACKLOG',
    cols: ['id', 'title', 'department', 'priority', 'status', 'expectedSavedMinutesPerRun', 'notes', 'createdAt', 'updatedAt'],
    json: [],
    num: ['expectedSavedMinutesPerRun']
  },
  quickLinks: {
    sheet: 'APP_QUICKLINKS',
    cols: ['id', 'name', 'url', 'icon'],
    json: [],
    num: []
  },
  terminals: {
    sheet: 'APP_TERMINALS',
    cols: ['id', 'name', 'status'],
    json: [],
    num: []
  },
  schedules: {
    sheet: 'APP_SCHEDULES',
    cols: ['id', 'rpaId', 'terminalId', 'startTime', 'endTime', 'frequency'],
    json: [],
    num: []
  }
};

// クライアント側の計算値・一時フラグは保存しない
const TRANSIENT_FIELDS = ['sheetLinked', 'autoCreated', 'startDate', 'hasRecording', 'syncToSheet'];

function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) || 'data';
    if (action === 'data') {
      return jsonOut({ ok: true, data: getData() });
    }
    return jsonOut({ ok: false, error: 'unknown_action' });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;

    if (action === 'setup') {
      const props = PropertiesService.getScriptProperties();
      if (props.getProperty('ADMIN_PASSWORD')) {
        return jsonOut({ ok: false, error: 'already_configured' });
      }
      if (!body.password || String(body.password).length < 8) {
        return jsonOut({ ok: false, error: 'password_too_short' });
      }
      props.setProperty('ADMIN_PASSWORD', String(body.password));
      return jsonOut({ ok: true });
    }

    if (action === 'login') {
      return jsonOut(checkPassword(body.password) ? { ok: true } : { ok: false, error: 'invalid_password' });
    }

    if (action === 'save') {
      if (!checkPassword(body.password)) {
        return jsonOut({ ok: false, error: 'invalid_password' });
      }
      if (!body.data || !Array.isArray(body.data.rpas)) {
        return jsonOut({ ok: false, error: 'invalid_data' });
      }
      const lock = LockService.getScriptLock();
      lock.waitLock(30000);
      try {
        const added = saveData(body.data);
        return jsonOut({ ok: true, addedToJisseki: added });
      } finally {
        lock.releaseLock();
      }
    }

    return jsonOut({ ok: false, error: 'unknown_action' });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

function checkPassword(password) {
  const stored = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD');
  return !!stored && !!password && String(password) === stored;
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function normName(s) {
  return String(s || '').trim().replace(/\s+/g, '').replace(/･/g, '・');
}

// ---------- 読み取り ----------

function getData() {
  const ss = SpreadsheetApp.openById(SS_ID);
  const out = {};
  Object.keys(COLLECTIONS).forEach(function (key) {
    out[key] = readCollection(ss, key);
  });

  const jisseki = readJisseki(ss);
  const byName = {};
  jisseki.forEach(function (j) { byName[normName(j.name)] = j; });

  const used = {};
  out.rpas.forEach(function (r) {
    const j = byName[normName(r.name)];
    if (j) {
      used[normName(j.name)] = true;
      applyJisseki(r, j);
    }
  });

  jisseki.forEach(function (j) {
    if (used[normName(j.name)]) return;
    const r = {
      id: 'rpa-sheet-' + j.row,
      name: j.name,
      description: '',
      department: '',
      tags: [],
      operationMode: 'scheduled',
      sheets: [],
      sheetUrl: '',
      recordingUrl: '',
      devHours: 0,
      tool: 'ロボパットDX',
      autoCreated: true,
      createdAt: '',
      updatedAt: ''
    };
    applyJisseki(r, j);
    out.rpas.push(r);
  });

  return out;
}

function applyJisseki(rpa, j) {
  const totalHours = Number(j.totalSavedHours) || 0;
  rpa.savedMinutes = Math.round(totalHours * 60);
  rpa.savedAmount = Math.round(totalHours * HOURLY_WAGE);
  rpa.runCount = Number(j.runsPerMonth) || 0;
  rpa.startDate = j.startDate;
  rpa.sheetLinked = true;
}

function readCollection(ss, key) {
  const def = COLLECTIONS[key];
  const sh = getOrCreateAppSheet(ss, def);
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  const header = values[0].map(String);
  const rows = [];
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][0]) === '') continue;
    var obj = {};
    for (var c = 0; c < header.length; c++) {
      var col = header[c];
      if (!col) continue;
      var v = values[i][c];
      if (v instanceof Date) v = v.toISOString();
      if (col === '_extra') {
        if (v) {
          try {
            var extra = JSON.parse(v);
            Object.keys(extra).forEach(function (k) { obj[k] = extra[k]; });
          } catch (e) { /* 破損時は無視 */ }
        }
        continue;
      }
      if (def.json.indexOf(col) >= 0) {
        try { v = v ? JSON.parse(v) : []; } catch (e) { v = []; }
      } else if (def.num.indexOf(col) >= 0) {
        v = v === '' ? 0 : Number(v);
      } else {
        v = v === null || v === undefined ? '' : String(v);
      }
      obj[col] = v;
    }
    rows.push(obj);
  }
  return rows;
}

function getOrCreateAppSheet(ss, def) {
  var sh = ss.getSheetByName(def.sheet);
  if (!sh) {
    sh = ss.insertSheet(def.sheet);
    sh.getRange(1, 1, 1, def.cols.length + 1).setValues([def.cols.concat(['_extra'])]);
  }
  return sh;
}

// ---------- 保存 ----------

function saveData(data) {
  const ss = SpreadsheetApp.openById(SS_ID);
  Object.keys(COLLECTIONS).forEach(function (key) {
    writeCollection(ss, key, Array.isArray(data[key]) ? data[key] : []);
  });

  // アプリで新規登録されたRPA(syncToSheetフラグ付き)だけを実績一覧へ追加
  const jisseki = readJisseki(ss);
  const existing = {};
  jisseki.forEach(function (j) { existing[normName(j.name)] = true; });

  const added = [];
  (data.rpas || []).forEach(function (r) {
    if (r.syncToSheet && r.name && !existing[normName(r.name)]) {
      appendJissekiRow(ss, r);
      existing[normName(r.name)] = true;
      added.push(r.name);
    }
  });
  return added;
}

function writeCollection(ss, key, items) {
  const def = COLLECTIONS[key];
  const sh = getOrCreateAppSheet(ss, def);
  const header = def.cols.concat(['_extra']);
  const rows = items.map(function (item) {
    const extra = {};
    Object.keys(item).forEach(function (k) {
      if (def.cols.indexOf(k) < 0 && TRANSIENT_FIELDS.indexOf(k) < 0) {
        extra[k] = item[k];
      }
    });
    const row = def.cols.map(function (col) {
      var v = item[col];
      if (v === undefined || v === null) return '';
      if (def.json.indexOf(col) >= 0) return JSON.stringify(v);
      if (typeof v === 'object') return JSON.stringify(v);
      return v;
    });
    row.push(Object.keys(extra).length ? JSON.stringify(extra) : '');
    return row;
  });

  sh.clearContents();
  const range = sh.getRange(1, 1, rows.length + 1, header.length);
  range.setNumberFormat('@');
  sh.getRange(1, 1, 1, header.length).setValues([header]);
  if (rows.length) {
    sh.getRange(2, 1, rows.length, header.length).setValues(rows);
  }
}

// ---------- 実績一覧シート ----------

function getJissekiSheet(ss) {
  const sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getSheetId() === JISSEKI_GID) return sheets[i];
  }
  throw new Error('実績一覧シート(gid=' + JISSEKI_GID + ')が見つかりません');
}

function findJissekiHeaderRow(sh) {
  const colA = sh.getRange(1, 1, Math.min(10, sh.getLastRow()), 1).getValues();
  for (var i = 0; i < colA.length; i++) {
    if (normName(colA[i][0]) === 'RPA名') return i + 1;
  }
  throw new Error('実績一覧のヘッダー行(RPA名)が見つかりません');
}

/**
 * 列: A=RPA名 B=稼働開始日 C=RPA稼働時間 D=手動作業時間 E=削減時間 F=実行回数/月 G=合計削減時間 H=削減率 I=備考
 * データはヘッダーの次行から、A列が空になるまで
 */
function readJisseki(ss) {
  const sh = getJissekiSheet(ss);
  const headerRow = findJissekiHeaderRow(sh);
  const lastRow = sh.getLastRow();
  if (lastRow <= headerRow) return [];
  const values = sh.getRange(headerRow + 1, 1, lastRow - headerRow, 9).getValues();
  const tz = ss.getSpreadsheetTimeZone();
  const rows = [];
  for (var i = 0; i < values.length; i++) {
    const name = String(values[i][0]).trim();
    if (!name) break;
    var start = values[i][1];
    if (start instanceof Date) start = Utilities.formatDate(start, tz, 'yyyy-MM-dd');
    rows.push({
      row: headerRow + 1 + i,
      name: name,
      startDate: String(start || ''),
      savedHoursPerRun: Number(values[i][4]) || 0,
      runsPerMonth: Number(values[i][5]) || 0,
      totalSavedHours: Number(values[i][6]) || 0,
      note: String(values[i][8] || '')
    });
  }
  return rows;
}

/**
 * 新規RPAの行を表の末尾に追加。
 * 直前行をコピーして数式(削減時間・合計・削減率など)を引き継ぎ、入力セルだけ差し替える。
 */
function appendJissekiRow(ss, rpa) {
  const sh = getJissekiSheet(ss);
  const headerRow = findJissekiHeaderRow(sh);
  var last = headerRow;
  const lastRow = sh.getLastRow();
  const colA = sh.getRange(headerRow + 1, 1, lastRow - headerRow, 1).getValues();
  for (var i = 0; i < colA.length; i++) {
    if (String(colA[i][0]).trim() === '') break;
    last = headerRow + 1 + i;
  }
  if (last === headerRow) throw new Error('実績一覧にデータ行がありません');

  sh.insertRowAfter(last);
  const newRow = last + 1;
  const prev = sh.getRange(last, 1, 1, 9);
  prev.copyTo(sh.getRange(newRow, 1, 1, 9));

  const prevFormulas = prev.getFormulas()[0];
  const tz = ss.getSpreadsheetTimeZone();
  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const runCount = Number(rpa.runCount) || 0;
  const totalHours = (Number(rpa.savedMinutes) || 0) / 60;
  const perRun = runCount > 0 ? totalHours / runCount : totalHours;

  sh.getRange(newRow, 1).setValue(rpa.name);
  sh.getRange(newRow, 2).setValue(today);
  sh.getRange(newRow, 3).setValue('');
  sh.getRange(newRow, 4).setValue('');
  if (!prevFormulas[4]) sh.getRange(newRow, 5).setValue(perRun || '');
  sh.getRange(newRow, 6).setValue(runCount || '');
  if (!prevFormulas[6]) sh.getRange(newRow, 7).setValue(totalHours || '');
  if (!prevFormulas[7]) sh.getRange(newRow, 8).setValue('');
  sh.getRange(newRow, 9).setValue('');
}
