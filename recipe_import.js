/*
 * Разбор текстового формата рецептов для админки.
 * Это точный порт lib/utils/recipe_text_parser.dart — правила должны совпадать.
 * Проверка совпадения: node tool/compare_parsers.js (прогоняет все файлы Recepies/inbox через оба парсера).
 *
 * Дополнительно (нет в приложении): строки вида «# ===== Название — вариантов: N =====»
 * перед блоком запоминаются как группа (используется для файла duplicates.txt).
 */
(function (root) {
  'use strict';

  var CATEGORIES = ['Первое', 'Второе', 'Десерт', 'Выпечка', 'Салаты', 'Закуски', 'Напитки', 'Завтраки'];

  var UNIT_ALIASES = {
    'гр': 'г', 'грамм': 'г', 'граммов': 'г',
    'кг': 'кг', 'килограмм': 'кг',
    'л': 'л', 'литр': 'л', 'литров': 'л',
    'мл': 'мл', 'миллилитр': 'мл',
    'шт': 'шт.', 'штук': 'шт.', 'штука': 'шт.', 'штуки': 'шт.',
    'ч.л.': 'ч.л.', 'чл': 'ч.л.', 'ч л': 'ч.л.', 'ч.л': 'ч.л.',
    'ст.л.': 'ст.л.', 'стл': 'ст.л.', 'ст л': 'ст.л.', 'ст.л': 'ст.л.',
    'ст. л.': 'ст.л.', 'ст.ложка': 'ст.л.',
    'стакан': 'стакан', 'стаканов': 'стакан', 'стаканы': 'стакан',
    'щепотка': 'щепотка', 'щепоток': 'щепотка',
    'по вкусу': 'по вкусу'
  };

  function normalizeUnit(raw) {
    var t = raw.trim();
    var k = t.toLowerCase();
    return Object.prototype.hasOwnProperty.call(UNIT_ALIASES, k) ? UNIT_ALIASES[k] : t;
  }

  function parseIngredientLine(line) {
    var parts = line.split('--');
    if (parts.length < 2) return null;
    var name = parts[0].trim();
    if (!name) return null;
    var qtyPart = parts.slice(1).join('--').trim();
    var m = /^(\d+(?:[.,]\d+)?)\s*(.*)$/.exec(qtyPart);
    if (!m) {
      return { name: name, quantity: 0, unit: normalizeUnit(qtyPart ? qtyPart : 'по вкусу') };
    }
    var qty = parseFloat(m[1].replace(',', '.'));
    if (isNaN(qty)) qty = 0;
    var unit = normalizeUnit((m[2] || '').trim() || 'г');
    return { name: name, quantity: qty, unit: unit };
  }

  function parseYield(raw) {
    var t = raw.trim();
    var m = /^(\d+(?:[.,]\d+)?)\s*(.+)?$/.exec(t);
    if (!m) return [1, t ? t : 'порций'];
    var qty = parseFloat(m[1].replace(',', '.'));
    if (isNaN(qty)) qty = 1;
    var unit = m[2] ? m[2].trim() : '';
    return [qty, unit ? unit : 'порций'];
  }

  function parseBlock(block) {
    var warnings = [];
    var name = '', category = '', notes = '';
    var tags = [], ingredients = [], steps = [];
    var yieldAmount = 1, yieldUnit = 'порций';
    var state = 'header';
    var lines = block.split('\n');

    for (var li = 0; li < lines.length; li++) {
      var line = lines[li].trim();
      if (!line) continue;
      var lower = line.toLowerCase();

      if (lower.indexOf('ингредиент') === 0) { state = 'ingredients'; continue; }
      if (lower.indexOf('приготовлени') === 0) { state = 'steps'; continue; }
      if (lower.indexOf('заметк') === 0) {
        state = 'notes';
        var colon = line.indexOf(':');
        if (colon !== -1) {
          var inline = line.substring(colon + 1).trim();
          if (inline) notes = inline;
        }
        continue;
      }

      if (state === 'header') {
        if (lower.indexOf('название:') === 0) {
          name = line.substring(line.indexOf(':') + 1).trim();
        } else if (lower.indexOf('категория:') === 0) {
          category = line.substring(line.indexOf(':') + 1).trim();
        } else if (lower.indexOf('тег') === 0) {
          var rawTags = line.substring(line.indexOf(':') + 1).trim();
          rawTags.split(',').forEach(function (t) { t = t.trim(); if (t) tags.push(t); });
        } else if (lower.indexOf('выход:') === 0 || lower.indexOf('выход ') === 0) {
          var y = parseYield(line.substring(line.indexOf(':') + 1).trim());
          yieldAmount = y[0]; yieldUnit = y[1];
        }
      } else if (state === 'ingredients') {
        if (line.indexOf('--') !== -1) {
          var ing = parseIngredientLine(line);
          if (ing) ingredients.push(ing);
          else warnings.push('Не удалось разобрать ингредиент: "' + line + '"');
        }
      } else if (state === 'steps') {
        var cleaned = line.replace(/^\d+[.)]\s*/, '').trim();
        if (cleaned) steps.push(cleaned);
      } else if (state === 'notes') {
        notes = notes ? notes + '\n' + line : line;
      }
    }

    if (!name) {
      name = '(Без названия)';
      warnings.push('Не указано название рецепта');
    }
    var categoryUnknown = !!category && CATEGORIES.indexOf(category) === -1;

    return {
      name: name, category: category, tags: tags,
      yieldAmount: yieldAmount, yieldUnit: yieldUnit,
      ingredients: ingredients, steps: steps, notes: notes,
      categoryUnknown: categoryUnknown, warnings: warnings
    };
  }

  /** Разбирает весь текст. Возвращает { recipes: [...], globalErrors: [...] } */
  function parse(text) {
    if (!text || !text.trim()) return { recipes: [], globalErrors: ['Текст пуст'] };
    var rawBlocks = text.split(/^---\s*$/m);
    var recipes = [];
    var currentGroup = '';
    for (var i = 0; i < rawBlocks.length; i++) {
      var b = rawBlocks[i].trim();
      if (!b) continue;
      // Строки-заголовки групп («# ===== ... =====») убираем из блока и запоминаем
      var kept = [];
      b.split('\n').forEach(function (ln) {
        var g = /^\s*#\s*=+\s*(.*?)\s*=+\s*$/.exec(ln);
        if (g) { currentGroup = g[1]; } else { kept.push(ln); }
      });
      b = kept.join('\n').trim();
      if (!b) continue;
      var r = parseBlock(b);
      r.group = currentGroup;
      recipes.push(r);
    }
    if (!recipes.length) return { recipes: [], globalErrors: ['Не найдено ни одного рецепта'] };
    return { recipes: recipes, globalErrors: [] };
  }

  var api = { parse: parse, CATEGORIES: CATEGORIES, normalizeUnit: normalizeUnit };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RecipeImport = api;
})(typeof window !== 'undefined' ? window : this);
