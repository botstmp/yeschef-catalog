/*
 * Вкладка «Импорт» в админке: вставка текста рецептов → разбор → предпросмотр → запись в базу.
 * Использует глобальные db, esc, scoreMatch, normalizeForMatch, capitalize, invalidateRecipesCache,
 * loadRecipes из admin.html и RecipeImport из recipe_import.js.
 *
 * Безопасность:
 *  - разбор и предпросмотр ничего не пишут в базу;
 *  - по умолчанию рецепты сохраняются СКРЫТЫМИ (published = false) — на сайте их не видно;
 *  - рецепты, которые уже есть в базе (по названию), по умолчанию не выбираются и не записываются повторно;
 *  - перед записью повторно сверяется список названий (защита от двойного клика / второй вкладки);
 *  - запись пачками; после импорта доступна кнопка «Отменить импорт» (удаляет ровно записанные строки).
 */
(function () {
  'use strict';

  var UNDO_KEY = 'yc_import_undo';
  var S = {
    items: [],          // разобранные рецепты с состоянием
    existing: null,     // Set названий в базе (нижний регистр)
    catalog: null,      // ингредиенты каталога [{name, aliases}]
    filter: 'all',
    busy: false,
    lastIds: []
  };

  function $(id) { return document.getElementById(id); }
  function key(n) { return String(n || '').trim().toLowerCase(); }

  // ── Загрузка данных из базы ────────────────────────────────────────────────

  async function fetchAll(table, cols) {
    var out = [], from = 0, step = 1000;
    for (;;) {
      var res = await db.from(table).select(cols).range(from, from + step - 1);
      if (res.error) throw new Error(res.error.message);
      out = out.concat(res.data || []);
      if (!res.data || res.data.length < step) break;
      from += step;
    }
    return out;
  }

  async function loadExisting() {
    var rows = await fetchAll('recipes', 'name');
    S.existing = new Set(rows.map(function (r) { return key(r.name); }));
  }

  async function loadCatalog() {
    if (S.catalog) return;
    try { S.catalog = await fetchAll('ingredients', 'name, aliases'); }
    catch (e) { S.catalog = []; }
    buildCatIndex();
  }

  // ── Сопоставление ингредиентов с каталогом ─────────────────────────────────

  function buildCatIndex() {
    S.catIndex = {};
    (S.catalog || []).forEach(function (c) {
      [c.name].concat(c.aliases || []).forEach(function (n) { S.catIndex[IngredientDict.fold(n)] = c.name; });
    });
  }

  /** ok — есть в каталоге; new — словарь знает, в каталоге ещё нет; unknown — словарь не знает */
  function matchIngredient(name) {
    var r = IngredientDict.resolve(name);
    var hit = S.catIndex[IngredientDict.fold(r.canonical)] || S.catIndex[IngredientDict.fold(name)];
    if (hit) return { status: 'ok', canonical: capitalize(hit), dict: r };
    return { status: r.known ? 'new' : 'unknown', canonical: capitalize(r.canonical), dict: r };
  }

  // ── Разбор ─────────────────────────────────────────────────────────────────

  async function analyze(text) {
    var res = RecipeImport.parse(text);
    if (res.globalErrors.length && !res.recipes.length) { showMsg(res.globalErrors.join('; '), true); return; }

    showMsg('Сверяю с каталогом…', false);
    try { await Promise.all([loadExisting(), loadCatalog()]); }
    catch (e) { showMsg('Не удалось прочитать каталог: ' + e.message, true); return; }

    var seen = {};
    S.items = res.recipes.map(function (r, idx) {
      var k = key(r.name);
      var inDb = S.existing.has(k);
      var dupInList = !!seen[k];
      seen[k] = true;

      var ings = r.ingredients.map(function (i) {
        var m = matchIngredient(i.name);
        return { name: i.name, quantity: i.quantity, unit: i.unit, match: m };
      });
      var unknown = ings.filter(function (i) { return i.match.status !== 'ok'; }).length;

      var cat = RecipeImport.CATEGORIES.indexOf(r.category) !== -1 ? r.category : '';
      var needsCheck = /ПРОВЕРИТЬ/i.test(r.notes || '');
      var grouped = !!r.group;
      var problems = [];
      if (!r.ingredients.length) problems.push('нет ингредиентов');
      if (!r.steps.length) problems.push('нет шагов');
      r.warnings.forEach(function (w) { problems.push(w); });

      return {
        idx: idx, r: r, ings: ings, unknown: unknown,
        category: cat, inDb: inDb, dupInList: dupInList, grouped: grouped,
        needsCheck: needsCheck, problems: problems,
        // выбираем по умолчанию только безопасные: новые, не повторы, с категорией и без проблем
        selected: !inDb && !dupInList && !grouped && !!cat && !problems.length
      };
    });
    S.filter = 'all';
    $('imp-result').style.display = 'none';
    buildDict();
    render();
    showMsg('', false);
  }

  // ── Словарь ингредиентов пачки ─────────────────────────────────────────────

  S.dictFilter = 'all';

  function buildDict() {
    var map = {}, lines = 0, covered = 0, rawSet = {};
    S.items.forEach(function (it) {
      it.ings.forEach(function (g) {
        lines++;
        rawSet[IngredientDict.fold(g.name)] = true;
        var k = IngredientDict.fold(g.match.canonical);
        var d = map[k] || (map[k] = { canonical: g.match.canonical, status: g.match.status, category: g.match.dict.category,
          unit: g.match.dict.unit, lines: 0, recipes: {}, raws: {} });
        d.lines++; d.recipes[it.idx] = true; d.raws[g.name] = (d.raws[g.name] || 0) + 1;
        if (g.match.status === 'ok') covered++;
      });
    });
    S.dict = Object.keys(map).map(function (k) { return map[k]; }).sort(function (a, b) { return b.lines - a.lines; });
    S.dictStats = { lines: lines, covered: covered, rawNames: Object.keys(rawSet).length };
  }

  function renderDict() {
    var box = $('imp-dict');
    if (!S.dict || !S.items.length) { box.innerHTML = ''; return; }
    var st = S.dictStats;
    var inCat = S.dict.filter(function (d) { return d.status === 'ok'; }).length;
    var fresh = S.dict.filter(function (d) { return d.status === 'new'; }).length;
    var unk = S.dict.filter(function (d) { return d.status === 'unknown'; }).length;
    var flt = S.dictFilter;
    var rows = S.dict.filter(function (d) {
      return flt === 'all' ? true : flt === 'ok' ? d.status === 'ok' : flt === 'new' ? d.status === 'new' : d.status === 'unknown';
    }).map(function (d) {
      var badge = d.status === 'ok' ? '<span class="badge" style="background:#e6f4e6;color:#2d7a2d">в каталоге</span>'
        : d.status === 'new' ? '<span class="badge" style="background:#fff3cd;color:#8a6100">новый</span>'
        : '<span class="badge" style="background:#fbe9e9;color:#a33">нет в словаре</span>';
      var variants = Object.keys(d.raws).filter(function (r) { return IngredientDict.fold(r) !== IngredientDict.fold(d.canonical); });
      return '<tr><td><strong>' + esc(d.canonical) + '</strong></td><td>' + badge + '</td>' +
        '<td style="text-align:right">' + d.lines + '</td><td style="text-align:right">' + Object.keys(d.recipes).length + '</td>' +
        '<td>' + esc(d.category) + ' · ' + esc(d.unit) + '</td>' +
        '<td style="font-size:12px;color:var(--text-muted)">' + esc(variants.slice(0, 6).join('; ') + (variants.length > 6 ? '; … (+' + (variants.length - 6) + ')' : '')) + '</td></tr>';
    }).join('');
    function chip(f, label) {
      return '<button class="btn ' + (flt === f ? 'btn-primary' : 'btn-ghost') + '" style="padding:4px 10px;font-size:12px" onclick="Imp.dictFilter(\'' + f + '\')">' + label + '</button> ';
    }
    box.innerHTML = '<details ' + (S.dictOpen ? 'open' : '') + ' ontoggle="Imp.dictToggle(this.open)" style="margin:10px 0;border:1px solid var(--border);border-radius:var(--radius);background:var(--surface);padding:10px 14px">' +
      '<summary style="cursor:pointer;font-weight:600">Словарь ингредиентов: ' + st.rawNames + ' названий в тексте → ' + S.dict.length +
      ' после очистки (в каталоге ' + inCat + ', новых ' + fresh + (unk ? ', неизвестных ' + unk : '') + '); строк с привязкой к каталогу ' +
      Math.round(st.covered / Math.max(1, st.lines) * 100) + '%</summary>' +
      '<div style="margin:10px 0">' + chip('all', 'Все (' + S.dict.length + ')') + chip('new', 'Новые (' + fresh + ')') + chip('ok', 'В каталоге (' + inCat + ')') + (unk ? chip('unknown', 'Неизвестные (' + unk + ')') : '') + '</div>' +
      '<div style="max-height:420px;overflow:auto"><table class="recipes-table"><thead><tr><th>Ингредиент</th><th>Статус</th><th style="text-align:right">Строк</th><th style="text-align:right">Рецептов</th><th>Категория · ед.</th><th>Варианты в текстах</th></tr></thead><tbody>' + rows + '</tbody></table></div></details>';
  }

  // ── Отрисовка ──────────────────────────────────────────────────────────────

  function showMsg(t, isErr) {
    var el = $('imp-msg');
    el.textContent = t;
    el.style.color = isErr ? 'var(--danger)' : 'var(--text-muted)';
  }

  function visible(it) {
    switch (S.filter) {
      case 'new': return !it.inDb && !it.dupInList && !it.grouped;
      case 'dup': return it.inDb || it.dupInList || it.grouped;
      case 'check': return it.needsCheck || it.problems.length || !it.category;
      case 'sel': return it.selected;
      default: return true;
    }
  }

  function badge(text, color, bg) {
    return '<span class="badge" style="background:' + bg + ';color:' + color + '">' + esc(text) + '</span> ';
  }

  function itemBadges(it) {
    var b = '';
    if (it.inDb) b += badge('уже в базе', '#a33', '#fbe9e9');
    if (it.dupInList) b += badge('повтор в списке', '#a33', '#fbe9e9');
    if (it.r.group) b += badge('группа: ' + it.r.group.replace(/\s*—\s*вариантов:.*/, ''), '#555', '#eee');
    if (it.needsCheck) b += badge('проверить по видео', '#8a6100', '#fff3cd');
    if (!it.category) b += badge('выберите категорию', '#a33', '#fbe9e9');
    if (it.unknown) b += badge('нет в каталоге: ' + it.unknown, '#555', '#eee');
    it.problems.forEach(function (p) { b += badge(p, '#a33', '#fbe9e9'); });
    return b;
  }

  function details(it) {
    var h = '<div style="margin:8px 0 4px;font-size:13px;color:var(--text)">';
    h += '<div style="color:var(--text-muted);margin-bottom:4px">Выход: ' + esc(it.r.yieldAmount) + ' ' + esc(it.r.yieldUnit) +
      (it.r.tags.length ? ' · Теги: ' + esc(it.r.tags.join(', ')) : '') + '</div>';
    h += '<strong>Ингредиенты</strong><ul style="margin:4px 0 8px 18px">';
    it.ings.forEach(function (i) {
      var mark = '';
      if (i.match.status === 'ok' && i.match.canonical.toLowerCase() !== i.name.toLowerCase())
        mark = ' <span style="color:var(--success)">→ ' + esc(i.match.canonical) + '</span>';
      else if (i.match.status === 'new')
        mark = ' <span style="color:#8a6100">→ ' + esc(i.match.canonical) + ' (будет создан в каталоге)</span>';
      else if (i.match.status === 'unknown')
        mark = ' <span style="color:var(--text-muted)">(нет в словаре: ' + esc(i.match.canonical) + ')</span>';
      h += '<li>' + esc(i.name) + ' — ' + esc(i.quantity || '') + ' ' + esc(i.unit) + mark + '</li>';
    });
    h += '</ul><strong>Приготовление</strong><ol style="margin:4px 0 8px 18px">';
    it.r.steps.forEach(function (s) { h += '<li>' + esc(s) + '</li>'; });
    h += '</ol>';
    if (it.r.notes) h += '<div style="color:var(--text-muted);white-space:pre-wrap"><strong>Заметки:</strong> ' + esc(it.r.notes) + '</div>';
    return h + '</div>';
  }

  function updateSummary() {
    var items = S.items;
    var sel = items.filter(function (i) { return i.selected; }).length;
    var cnt = {
      all: items.length,
      inDb: items.filter(function (i) { return i.inDb; }).length,
      dup: items.filter(function (i) { return i.dupInList || i.grouped; }).length,
      check: items.filter(function (i) { return i.needsCheck; }).length
    };
    $('imp-summary').innerHTML =
      '<strong>' + cnt.all + '</strong> рецептов · выбрано <strong>' + sel + '</strong>' +
      ' · уже в базе: ' + cnt.inDb + ' · повторы/группы: ' + cnt.dup + ' · «проверить по видео»: ' + cnt.check;
    $('imp-go').textContent = 'Импортировать выбранные (' + sel + ')';
    $('imp-go').disabled = S.busy || !sel;
    $('imp-bulk').style.display = items.length ? '' : 'none';
    $('imp-go-wrap').style.display = items.length ? '' : 'none';
  }

  function render() {
    var items = S.items;
    updateSummary();
    renderDict();

    var filters = [['all', 'Все'], ['new', 'Новые'], ['dup', 'Повторы'], ['check', 'Требуют внимания'], ['sel', 'Выбранные']];
    $('imp-filters').innerHTML = filters.map(function (f) {
      var on = S.filter === f[0];
      return '<button class="btn ' + (on ? 'btn-primary' : 'btn-ghost') + '" style="padding:5px 12px;font-size:12px" ' +
        'onclick="Imp.setFilter(\'' + f[0] + '\')">' + f[1] + '</button>';
    }).join(' ');

    var rows = '';
    var lastGroup = null;
    items.forEach(function (it) {
      if (!visible(it)) return;
      if (it.r.group && it.r.group !== lastGroup) {
        rows += '<div style="margin:14px 0 4px;font-weight:600;color:var(--primary)">' + esc(it.r.group) + '</div>';
      }
      lastGroup = it.r.group;
      var catOpts = '<option value="">— категория —</option>' + RecipeImport.CATEGORIES.map(function (c) {
        return '<option' + (c === it.category ? ' selected' : '') + '>' + esc(c) + '</option>';
      }).join('');
      rows += '<div style="border:1px solid var(--border);border-radius:var(--radius);background:var(--surface);padding:10px 12px;margin-bottom:8px">' +
        '<div style="display:flex;gap:10px;align-items:center">' +
        '<input type="checkbox" style="width:18px;height:18px;flex:none" ' + (it.selected ? 'checked ' : '') + 'onchange="Imp.toggle(' + it.idx + ', this.checked)">' +
        '<div style="flex:1;min-width:0"><strong>' + esc(it.r.name) + '</strong>' +
        '<div style="font-size:12px;color:var(--text-muted)">' + it.ings.length + ' ингр. · ' + it.r.steps.length + ' шагов</div></div>' +
        '<select style="width:150px;flex:none" onchange="Imp.setCat(' + it.idx + ', this.value)">' + catOpts + '</select>' +
        '<button class="btn btn-ghost" style="padding:4px 10px;font-size:12px;flex:none" onclick="Imp.more(' + it.idx + ')">Подробнее</button>' +
        '</div><div style="margin-top:6px">' + itemBadges(it) + '</div>' +
        '<div id="imp-more-' + it.idx + '" style="display:none">' + details(it) + '</div></div>';
    });
    $('imp-list').innerHTML = rows || '<p style="color:var(--text-muted)">Нет рецептов по этому фильтру</p>';
  }

  // ── Действия ───────────────────────────────────────────────────────────────

  function mode() { return document.querySelector('input[name=imp-mode]:checked').value; }

  async function doImport() {
    if (S.busy) return;
    var chosen = S.items.filter(function (i) { return i.selected; });
    if (!chosen.length) return;
    var noCat = chosen.filter(function (i) { return !i.category; });
    if (noCat.length) { alert('Выберите категорию у рецептов: ' + noCat.slice(0, 5).map(function (i) { return i.r.name; }).join(', ')); return; }

    var publish = mode() === 'publish';
    var checkCnt = chosen.filter(function (i) { return i.needsCheck; }).length;
    var msg = 'Записать в базу рецептов: ' + chosen.length + '\n' +
      (publish ? 'СРАЗУ ОПУБЛИКОВАТЬ на сайте и в приложении.' : 'Сохранить СКРЫТЫМИ (на сайте не появятся, откроете их во вкладке «Рецепты»).');
    if (publish && checkCnt) msg += '\n\nВнимание: у ' + checkCnt + ' рецептов в заметках стоит «ПРОВЕРИТЬ ПО ВИДЕО» — они попадут в каталог с этой пометкой.';
    msg += '\n\nПродолжить?';
    if (!confirm(msg)) return;

    S.busy = true; render();
    showMsg('Записываю…', false);
    try {
      await loadExisting(); // свежий список названий
      var toWrite = [], skipped = [], batchKeys = {};
      chosen.forEach(function (it) {
        var k = key(it.r.name);
        // уже в базе или повтор внутри самого выбора — не пишем второй раз
        if (S.existing.has(k) || batchKeys[k]) skipped.push(it.r.name);
        else { batchKeys[k] = true; toWrite.push(it); }
      });
      var ids = [];
      for (var i = 0; i < toWrite.length; i += 20) {
        var chunk = toWrite.slice(i, i + 20).map(function (it) {
          return {
            name: it.r.name,
            categories: [it.category],
            tags: it.r.tags,
            yield_amount: it.r.yieldAmount,
            yield_unit: it.r.yieldUnit,
            description: '',
            notes: it.r.notes,
            published: publish,
            ingredients: it.ings.map(function (g) {
              return { name: g.match.status === 'ok' ? g.match.canonical : g.name, quantity: g.quantity, unit: g.unit };
            }),
            steps: it.r.steps.map(function (s) { return { description: s }; })
          };
        });
        var res = await db.from('recipes').insert(chunk).select('id');
        if (res.error) {
          if (ids.length) { S.lastIds = ids; saveUndo(ids); }
          throw new Error(res.error.message + ' (записано до ошибки: ' + ids.length + ')');
        }
        res.data.forEach(function (r) { ids.push(r.id); });
        showMsg('Записано ' + ids.length + ' из ' + toWrite.length + '…', false);
      }
      // пустой повторный импорт не должен стирать возможность отмены предыдущего
      if (ids.length) { S.lastIds = ids; saveUndo(ids); }
      toWrite.forEach(function (it) { S.existing.add(key(it.r.name)); it.inDb = true; it.selected = false; });
      invalidateRecipesCache(); loadRecipes();
      showResult('Готово: записано ' + ids.length + (ids.length ? ' (' + (publish ? 'опубликованы' : 'скрыты') + ')' : '') +
        (skipped.length ? '. Пропущено (уже в базе или повтор в выборе): ' + skipped.length : '') + '.', S.lastIds.length > 0);
      showMsg('', false);
    } catch (e) {
      showMsg('Ошибка: ' + e.message, true);
      showResult('Импорт остановлен: ' + e.message, S.lastIds.length > 0);
    }
    S.busy = false; render();
  }

  function showResult(text, canUndo) {
    var el = $('imp-result');
    el.style.display = '';
    el.innerHTML = '<div style="margin-bottom:8px">' + esc(text) + '</div>' +
      (canUndo ? '<button class="btn btn-danger" onclick="Imp.undo()">Отменить этот импорт (удалить записанные)</button>' : '');
  }

  async function undo() {
    var ids = S.lastIds.length ? S.lastIds : loadUndo();
    if (!ids.length) { alert('Нечего отменять'); return; }
    if (!confirm('Удалить из базы рецепты, записанные последним импортом: ' + ids.length + ' шт.?\nЭто необратимо.')) return;
    var res = await db.from('recipes').delete().in('id', ids);
    if (res.error) { alert('Не удалось удалить: ' + res.error.message); return; }
    S.lastIds = []; saveUndo([]);
    try { await loadExisting(); } catch (e) {}
    S.items.forEach(function (it) { it.inDb = S.existing.has(key(it.r.name)); });
    invalidateRecipesCache(); loadRecipes(); render();
    showResult('Импорт отменён, удалено: ' + ids.length + '.', false);
  }

  function saveUndo(ids) { try { localStorage.setItem(UNDO_KEY, JSON.stringify(ids)); } catch (e) {} }
  function loadUndo() { try { return JSON.parse(localStorage.getItem(UNDO_KEY) || '[]'); } catch (e) { return []; } }

  // ── Ввод ───────────────────────────────────────────────────────────────────

  async function readFiles(files) {
    var texts = [];
    for (var i = 0; i < files.length; i++) texts.push(await files[i].text());
    var all = texts.join('\n---\n');
    $('imp-text').value = all;
    $('imp-files').textContent = Array.prototype.map.call(files, function (f) { return f.name; }).join(', ');
    await analyze(all);
  }

  window.Imp = {
    init: function () {
      var drop = $('imp-drop');
      ['dragenter', 'dragover'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.style.borderColor = 'var(--primary)'; }); });
      ['dragleave', 'drop'].forEach(function (ev) { drop.addEventListener(ev, function (e) { e.preventDefault(); drop.style.borderColor = 'var(--border)'; }); });
      drop.addEventListener('drop', function (e) { if (e.dataTransfer.files.length) readFiles(e.dataTransfer.files); });
      $('imp-file').addEventListener('change', function (e) { if (e.target.files.length) readFiles(e.target.files); e.target.value = ''; });
      var prev = loadUndo();
      if (prev.length) { S.lastIds = prev; showResult('Есть незавершённый след прошлого импорта: ' + prev.length + ' рецептов.', true); }
    },
    parse: function () { analyze($('imp-text').value); },
    clear: function () { S.items = []; $('imp-text').value = ''; $('imp-files').textContent = ''; $('imp-list').innerHTML = ''; $('imp-summary').innerHTML = ''; $('imp-filters').innerHTML = ''; showMsg('', false); render(); },
    setFilter: function (f) { S.filter = f; render(); },
    dictFilter: function (f) { S.dictFilter = f; S.dictOpen = true; renderDict(); },
    dictToggle: function (o) { S.dictOpen = o; },
    toggle: function (i, v) { S.items[i].selected = v; updateSummary(); },
    setCat: function (i, v) { S.items[i].category = v; render(); },
    more: function (i) { var el = $('imp-more-' + i); el.style.display = el.style.display === 'none' ? '' : 'none'; },
    selectNew: function () { S.items.forEach(function (it) { it.selected = !it.inDb && !it.dupInList && !it.grouped && !!it.category; }); render(); },
    selectAll: function () { S.items.forEach(function (it) { it.selected = !it.inDb && !!it.category; }); render(); },
    selectNone: function () { S.items.forEach(function (it) { it.selected = false; }); render(); },
    go: doImport,
    undo: undo
  };

  document.addEventListener('DOMContentLoaded', function () { Imp.init(); });
})();
